import { Readable } from 'node:stream';
import type { Database } from '@taskmoor/db';
import { CSV_CONTENT_TYPE, csvLine as csvRecord, withBom } from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
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

const exportQuery = filterQuery.extend({ format: z.enum(['csv', 'jsonl']).default('csv') });

const settingsBody = z
  .object({ retentionMonths: z.number().int().min(0).max(MAX_RETENTION_MONTHS) })
  .strict();

type FilterQuery = z.infer<typeof filterQuery>;

/**
 * The tables that name a record's subject, by its type (AD-2): each has an id, the workspace and
 * a name. A subject of another type keeps its id alone.
 */
const NAMED_SUBJECTS = {
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
} as const satisfies Record<string, keyof Database>;

type NamedSubject = keyof typeof NAMED_SUBJECTS;
const isNamed = (type: string): type is NamedSubject => Object.hasOwn(NAMED_SUBJECTS, type);

/**
 * The records with their subject's name as it is now, read in one query per type (AD-2): 'Track
 * Shop' rather than 'Track 1'. An erased person is not named, nor is a subject since deleted.
 * The stored records are unchanged.
 */
async function withSubjectNames(
  db: Kysely<Database>,
  workspaceId: number,
  records: AuditView[],
): Promise<(AuditView & { subject: { name?: string } | null })[]> {
  const wanted = new Map<NamedSubject, Set<number>>();
  for (const record of records) {
    const subject = record.subject;
    if (!subject?.id || !isNamed(subject.type) || !/^[0-9]{1,9}$/.test(subject.id)) continue;
    const ids = wanted.get(subject.type) ?? new Set<number>();
    ids.add(Number(subject.id));
    wanted.set(subject.type, ids);
  }
  const names = new Map<string, string>();
  for (const [type, ids] of wanted) {
    // Every table here has the same id, workspace and name columns as track.
    const table = NAMED_SUBJECTS[type] as 'track';
    let query = db
      .selectFrom(table)
      .select(['id', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', [...ids]);
    if (type === 'user') {
      query = query.where(sql<boolean>`erased_at IS NULL`);
    }
    for (const row of await query.execute()) names.set(`${type}:${row.id}`, row.name);
  }
  return records.map((record) => {
    const name = record.subject
      ? names.get(`${record.subject.type}:${record.subject.id}`)
      : undefined;
    return name === undefined || !record.subject
      ? record
      : { ...record, subject: { ...record.subject, name } };
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
    const { format, ...rest } = parsed.data;
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
      let buffer = format === 'csv' ? withBom(csvRecord(CSV_COLUMNS)) : '';
      for await (const record of exportAudit(db, workspaceId, filter)) {
        buffer += format === 'csv' ? csvLine(record) : `${JSON.stringify(record)}\n`;
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
