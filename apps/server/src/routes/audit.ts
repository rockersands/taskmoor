import { Readable } from 'node:stream';
import type { Database } from '@taskmoor/db';
import {
  CSV_CONTENT_TYPE,
  CSV_SEPARATORS,
  csvLine as csvRecord,
  withBom,
} from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import { appendAudit, verifyChain } from '../audit/chain';
import {
  type AuditFilter,
  type AuditView,
  CSV_COLUMNS,
  csvLine,
  exportAudit,
  searchAudit,
} from '../audit/query';
import { AUDIT_ACTIONS } from '../audit/record';
import { MAX_RETENTION_MONTHS, RETENTION_SETTING, retentionMonths } from '../audit/retention';
import { latestSeq, type SyslogTarget, sendSyslog, syslogMessage } from '../audit/syslog';
import { requireSiteAdmin } from '../auth';
import { withEvent } from '../events/bus';
import { countBulkExport } from '../security/alerts';
import { writeSetting } from '../setup';

/** An ISO 8601 date (midnight UTC) or date and time with an offset. */
const instant = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((text) => new Date(text));

const filterQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
  actor: z.coerce.number().int().positive().optional(),
  /** An action or the start of one: `user.` matches every user event. */
  action: z.string().trim().min(1).max(100).optional(),
  /** A subject type (`user`) or a type and id (`user:12`). */
  subject: z
    .string()
    .trim()
    .regex(/^[a-z_]{1,50}(:.{1,100})?$/)
    .optional(),
});

const searchQuery = filterQuery.extend({
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const exportQuery = filterQuery.extend({
  format: z.enum(['csv', 'jsonl']).default('csv'),
  /** How a CSV file separates its cells (T-263): `comma`, the default, or `semicolon`. */
  separator: z.enum(CSV_SEPARATORS).default('comma'),
});

const settingsBody = z
  .object({ retentionMonths: z.number().int().min(0).max(MAX_RETENTION_MONTHS) })
  .strict();

type FilterQuery = z.infer<typeof filterQuery>;

/**
 * The tables that name a record's subject, by its type (AD-2): each has an id, the workspace and
 * a name (or the column `NAME_COLUMNS` gives). Every audited subject whose table has a name is
 * here; `audit.test.ts` holds the list to that. A ticket is named by its key instead (below); a
 * subject with no name, such as a bulk change, keeps its id alone.
 */
export const NAMED_SUBJECTS = {
  track: 'track',
  user: 'app_user',
  group: 'user_group',
  team: 'team',
  workflow: 'workflow',
  status: 'status',
  board: 'board',
  dashboard: 'dashboard',
  release: 'release',
  field: 'field',
  role: 'role',
  access_policy: 'access_policy',
  ticket_template: 'ticket_template',
  layout_set: 'layout_set',
  field_rule_set: 'field_rule_set',
  track_group: 'track_group',
  plan: 'plan',
  saved_search: 'saved_search',
  sprint: 'sprint',
  area: 'area',
  api_token: 'api_token',
  attachment: 'attachment',
  close_reason: 'close_reason',
  cross_track_release: 'cross_track_release',
  directory: 'ldap_directory',
  field_context: 'field_context',
  field_option: 'field_option',
  frontend_origin: 'frontend_origin',
  hierarchy_level: 'hierarchy_level',
  identity_provider: 'identity_provider',
  import_run: 'import_run',
  link_type: 'link_type',
  notification_policy: 'notification_policy',
  oauth_client: 'oauth_client',
  priority: 'priority',
  priority_set: 'priority_set',
  ticket_type: 'ticket_type',
  track_category: 'track_category',
  type_set: 'type_set',
  visibility_level: 'visibility_level',
  visibility_policy: 'visibility_policy',
  webhook: 'webhook',
  workflow_map: 'workflow_map',
} as const satisfies Record<string, keyof Database>;

type NamedType = keyof typeof NAMED_SUBJECTS;
const isNamed = (type: string): type is NamedType => Object.hasOwn(NAMED_SUBJECTS, type);

/**
 * The subjects whose name is in another column than `name`: a field option by its value, a
 * frontend by its label, or by its address when it has none.
 */
const NAME_COLUMNS: Partial<Record<NamedType, RawBuilder<string>>> = {
  field_option: sql<string>`value`,
  frontend_origin: sql<string>`coalesce(nullif(label, ''), origin)`,
};

/** The subjects whose ids are text, not numbers: an app connection's client id (`tmc_...`). */
const TEXT_IDS: ReadonlySet<string> = new Set<NamedType>(['oauth_client']);

/** Whether a record's subject id can name a row of its type's table. */
const nameableId = (type: string, id: string): boolean =>
  TEXT_IDS.has(type) ? id.length <= 100 : /^[0-9]{1,9}$/.test(id);

/**
 * The actions whose details point at a role and the person or group it was given to or taken
 * from (S3-AD-4): the log says which role and to whom, not only that a role moved.
 */
const ROLE_ACTIONS: ReadonlySet<string> = new Set([
  'track_role.actor_added',
  'track_role.actor_removed',
]);

/** What a record's details point at, named as it is now (S3-AD-4). */
export interface AuditAbout {
  role?: string;
  person?: string;
  group?: string;
}

const numericId = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/**
 * The records with their subject's name as it is now, read in one query per type (AD-2): 'Track
 * Shop' rather than 'Track 1', a ticket by its key. A record about a role given or taken also
 * names the role and the person or group (`about`, S3-AD-4). An erased person is not named, nor
 * is anything since deleted. The stored records are unchanged.
 */
async function withSubjectNames(
  db: Kysely<Database>,
  workspaceId: number,
  records: AuditView[],
): Promise<(AuditView & { subject: { name?: string } | null; about?: AuditAbout })[]> {
  const wanted = new Map<NamedType | 'ticket', Set<number | string>>();
  const want = (type: NamedType | 'ticket', id: number | string) => {
    const ids = wanted.get(type) ?? new Set<number | string>();
    ids.add(id);
    wanted.set(type, ids);
  };
  for (const record of records) {
    const subject = record.subject;
    if (subject?.id && nameableId(subject.type, subject.id)) {
      if (isNamed(subject.type) || subject.type === 'ticket') {
        want(subject.type, TEXT_IDS.has(subject.type) ? subject.id : Number(subject.id));
      }
    }
    if (ROLE_ACTIONS.has(record.action) && !record.masked) {
      const details = (record.details ?? {}) as Record<string, unknown>;
      const role = numericId(details.roleId);
      const user = numericId(details.userId);
      const group = numericId(details.groupId);
      if (role !== null) want('role', role);
      if (user !== null) want('user', user);
      if (group !== null) want('group', group);
    }
  }
  const names = new Map<string, string>();
  for (const [type, ids] of wanted) {
    if (type === 'ticket') {
      const rows = await db
        .selectFrom('ticket as k')
        .innerJoin('track as t', 't.id', 'k.track_id')
        .select(['k.id', 't.key', 'k.number'])
        .where('k.workspace_id', '=', workspaceId)
        .where('k.id', 'in', [...ids].map(Number))
        .execute();
      for (const row of rows) names.set(`ticket:${row.id}`, `${row.key}-${row.number}`);
      continue;
    }
    // Every table here has an id and workspace column as track has, and its name in `name` or
    // the column NAME_COLUMNS gives; an app connection's id is text.
    const table = NAMED_SUBJECTS[type] as 'track';
    let query = db
      .selectFrom(table)
      .select(['id', (NAME_COLUMNS[type] ?? sql<string>`name`).as('name')])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', [...ids] as number[]);
    if (type === 'user') {
      query = query.where(sql<boolean>`erased_at IS NULL`);
    }
    for (const row of await query.execute()) names.set(`${type}:${row.id}`, row.name);
  }
  return records.map((record) => {
    const name = record.subject
      ? names.get(`${record.subject.type}:${record.subject.id}`)
      : undefined;
    let named: AuditView & { subject: { name?: string } | null; about?: AuditAbout } =
      name === undefined || !record.subject
        ? record
        : { ...record, subject: { ...record.subject, name } };
    if (ROLE_ACTIONS.has(record.action) && !record.masked) {
      const details = (record.details ?? {}) as Record<string, unknown>;
      const about: AuditAbout = {};
      const role = names.get(`role:${numericId(details.roleId)}`);
      const person = names.get(`user:${numericId(details.userId)}`);
      const group = names.get(`group:${numericId(details.groupId)}`);
      if (role !== undefined) about.role = role;
      if (person !== undefined) about.person = person;
      if (group !== undefined) about.group = group;
      if (Object.keys(about).length > 0) named = { ...named, about };
    }
    return named;
  });
}

function toFilter(query: FilterQuery): AuditFilter {
  const filter: AuditFilter = {};
  if (query.from) filter.from = query.from;
  if (query.to) filter.to = query.to;
  if (query.actor !== undefined) filter.actorId = query.actor;
  if (query.action) filter.action = query.action;
  if (query.subject) {
    const at = query.subject.indexOf(':');
    filter.subjectType = at < 0 ? query.subject : query.subject.slice(0, at);
    if (at >= 0) filter.subjectId = query.subject.slice(at + 1);
  }
  return filter;
}

/** The filter as the export's own audit record states it. */
function describeFilter(query: FilterQuery): Record<string, unknown> {
  return {
    ...(query.from ? { from: query.from.toISOString() } : {}),
    ...(query.to ? { to: query.to.toISOString() } : {}),
    ...(query.actor !== undefined ? { actor: query.actor } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.subject ? { subject: query.subject } : {}),
  };
}

/**
 * The audit log API for site administrators (M1-003, IAM-013): search with filters and a
 * cursor, streamed export as CSV or JSON Lines (itself recorded in the log), chain
 * verification and the retention setting. The admin UI (M1-053) builds on these.
 */
const syslogBody = z
  .object({
    enabled: z.boolean(),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:[\]-]+$/),
    port: z.number().int().min(1).max(65535),
    transport: z.enum(['udp', 'tcp', 'tls']),
  })
  .strict();

export function registerAuditRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: {
    hostname?: string;
    send?: (t: SyslogTarget, m: readonly string[]) => Promise<void>;
  } = {},
): void {
  const send = options.send ?? sendSyslog;
  const hostname = options.hostname ?? 'taskmoor';
  app.get('/api/v1/audit', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = searchQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { cursor, limit, ...rest } = parsed.data;
    const found = await searchAudit(db, request.workspaceId, toFilter(rest), {
      limit,
      ...(cursor ? { before: Number(cursor) } : {}),
    });
    return { ...found, records: await withSubjectNames(db, request.workspaceId, found.records) };
  });

  app.get('/api/v1/audit/export', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = exportQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { format, separator, ...rest } = parsed.data;
    const workspaceId = request.workspaceId;
    // Reading the log out is recorded before the first line leaves.
    await appendAudit(db, [
      {
        workspaceId,
        action: AUDIT_ACTIONS.exported,
        actorId: admin.id,
        ip: request.ip,
        details: { format, filter: describeFilter(rest) },
      },
    ]);
    await countBulkExport(db, workspaceId, admin.id);
    const filter = toFilter(rest);
    async function* chunks(): AsyncGenerator<string> {
      // A CSV file starts with the byte-order mark, once (T-252), then the header.
      let buffer = format === 'csv' ? withBom(csvRecord(CSV_COLUMNS, separator)) : '';
      for await (const record of exportAudit(db, workspaceId, filter)) {
        buffer += format === 'csv' ? csvLine(record, separator) : `${JSON.stringify(record)}\n`;
        if (buffer.length >= 64 * 1024) {
          yield buffer;
          buffer = '';
        }
      }
      if (buffer) yield buffer;
    }
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header(
        'content-type',
        format === 'csv' ? CSV_CONTENT_TYPE : 'application/x-ndjson; charset=utf-8',
      )
      .header('content-disposition', `attachment; filename="audit-${day}.${format}"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(chunks()));
  });

  app.get('/api/v1/audit/verify', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return verifyChain(db, request.workspaceId);
  });

  app.get('/api/v1/audit/settings', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { retentionMonths: await retentionMonths(db) };
  });

  app.put('/api/v1/audit/settings', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const to = parsed.data.retentionMonths;
    return withEvent(db, { workspaceId: request.workspaceId, actorId: admin.id }, async (trx) => {
      const from = await retentionMonths(trx);
      if (from === to) return { result: { retentionMonths: to }, event: null };
      await writeSetting(trx, RETENTION_SETTING, { months: to });
      return {
        result: { retentionMonths: to },
        event: {
          type: 'audit.settings_updated',
          subjectId: request.workspaceId,
          payload: { changes: { retentionMonths: { from, to } } },
        },
      };
    });
  });

  // Forwarding to syslog (M1-085): where, and how far it has got.
  const syslogView = async (workspaceId: number) => {
    const row = await db
      .selectFrom('audit_syslog')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return {
      syslog: row
        ? {
            enabled: row.enabled,
            host: row.host,
            port: row.port,
            transport: row.transport,
            lastSeq: Number(row.last_seq),
            lastSentAt: row.last_sent_at?.toISOString() ?? null,
            lastError: row.last_error,
          }
        : null,
    };
  };

  app.get('/api/v1/audit/syslog', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return syslogView(request.workspaceId);
  });

  app.put('/api/v1/audit/syslog', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = syslogBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const next = parsed.data;
    await withEvent(db, { workspaceId: ws, actorId: admin.id }, async (trx) => {
      const before = await trx
        .selectFrom('audit_syslog')
        .select(['enabled', 'host', 'port', 'transport'])
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      // A new receiver starts with what happens from now on; the file export has the past.
      const moved = !before?.enabled || before.host !== next.host || before.port !== next.port;
      const start = moved ? await latestSeq(trx as never, ws) : undefined;
      const row = {
        enabled: next.enabled,
        host: next.host,
        port: next.port,
        transport: next.transport,
        ...(start !== undefined ? { last_seq: start, last_error: null } : {}),
        updated_at: new Date(),
      };
      await trx
        .insertInto('audit_syslog')
        .values({ workspace_id: ws, ...row, last_seq: start ?? 0 })
        .onConflict((oc) => oc.column('workspace_id').doUpdateSet(row))
        .execute();
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of ['enabled', 'host', 'port', 'transport'] as const) {
        if (before?.[key] !== next[key])
          changes[key] = { from: before?.[key] ?? null, to: next[key] };
      }
      return {
        result: null,
        event:
          Object.keys(changes).length === 0
            ? null
            : { type: 'audit.syslog_updated', subjectId: ws, payload: { changes } },
      };
    });
    return syslogView(ws);
  });

  // Sends one message to check the receiver, without moving the position.
  app.post('/api/v1/audit/syslog/test', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = syslogBody.omit({ enabled: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const now = new Date().toISOString();
    const message = syslogMessage(
      {
        seq: 0,
        occurredAt: now,
        recordedAt: now,
        actor: null,
        action: 'audit.syslog_test',
        subject: null,
        details: { test: true },
        ip: request.ip,
        sourceEventId: null,
        prevHash: '',
        hash: '',
      },
      hostname,
    );
    try {
      await send(parsed.data, [message]);
      return { ok: true };
    } catch (error) {
      return reply
        .code(502)
        .send({ error: 'syslog_unreachable', reason: error instanceof Error ? error.message : '' });
    }
  });
}
