import type { Database, JsonValue } from '@taskmoor/db';
import { type PepperRing, sealSecret } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { diff, emit } from '../events/bus';
import { deactivateAccount } from '../ldap/accounts';
import {
  DirectoryBindError,
  DirectoryClient,
  DirectoryOperationError,
  DirectoryUnavailableError,
} from '../ldap/client';
import { groupAttributes, readGroup, readUser, userAttributes } from '../ldap/read';
import {
  ATTRIBUTE_NAME,
  attributeMap,
  DIRECTORY_COLUMNS,
  DIRECTORY_KINDS,
  type DirectoryRow,
  directorySettings,
  PRESETS,
  SealedSecretError,
  transportProblem,
  validFilter,
} from '../ldap/settings';
import { queueRun } from '../ldap/sync';
import { certificateSummary, readCertificates } from '../sso/saml';

const id = z.coerce.number().int().positive();
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
const dnText = z.string().trim().min(1).max(1000).regex(NO_CONTROL);
const filterText = z.string().trim().min(3).max(4000).refine(validFilter, 'not an LDAP filter');
const attributeName = z.string().trim().regex(ATTRIBUTE_NAME);
const attributes = z
  .object({
    id: attributeName,
    username: attributeName,
    email: attributeName,
    emailFallback: attributeName.or(z.literal('')),
    name: attributeName,
    givenName: attributeName,
    surname: attributeName,
    changeMark: attributeName,
    groupName: attributeName,
    member: attributeName,
  })
  .partial()
  .strict();
// Edits name only what changes, so the edit schema has no defaults (see routes/sso.ts).
const editFields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(500),
  startTls: z.boolean(),
  caCertificates: z.array(z.string().min(1).max(20_000)).max(10),
  bindDn: dnText,
  bindPassword: z.string().min(1).max(1000),
  baseDn: dnText,
  userBaseDn: dnText.nullable(),
  userFilter: filterText,
  groupBaseDn: dnText.nullable(),
  groupFilter: filterText,
  attributes,
  mode: z.enum(['read_only', 'read_write']),
  enabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5).max(1440),
  fullSyncHours: z.number().int().min(1).max(720),
};
const editBody = z.object(editFields).partial().strict();
const createBody = z
  .object({ ...editFields, kind: z.enum(DIRECTORY_KINDS) })
  .partial()
  .required({ name: true, kind: true, url: true, bindDn: true, bindPassword: true, baseDn: true })
  .strict();
const testBody = z
  .object({ ...editFields, kind: z.enum(DIRECTORY_KINDS), id })
  .partial()
  .strict();
const syncBody = z
  .object({
    mode: z.enum(['full', 'incremental']).default('incremental'),
    confirmRemovals: z.boolean().default(false),
  })
  .strict();
const orderBody = z.object({ ids: z.array(id).min(1).max(100) }).strict();

/** Settings whose change makes the next run a full one: what is read, or how it is matched. */
const RESCAN = new Set([
  'url',
  'bind_dn',
  'base_dn',
  'user_base_dn',
  'user_filter',
  'group_base_dn',
  'group_filter',
  'attribute_map',
]);

interface RunRow {
  id: number;
  mode: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  requested_by: number | null;
  confirm_removals: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  stats: JsonValue;
  warnings: JsonValue;
  error: string | null;
}

const RUN_COLUMNS = [
  'id',
  'mode',
  'trigger',
  'status',
  'requested_by',
  'confirm_removals',
  'created_at',
  'started_at',
  'finished_at',
  'stats',
  'warnings',
  'error',
] as const;

function runView(r: RunRow) {
  return {
    id: r.id,
    mode: r.mode,
    trigger: r.trigger,
    status: r.status,
    requestedBy: r.requested_by,
    confirmRemovals: r.confirm_removals,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    stats: r.stats,
    warnings: r.warnings,
    error: r.error,
  };
}

class Problem extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function certificates(list: string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  try {
    return readCertificates(list);
  } catch {
    throw new Problem('invalid_certificate', 'A CA certificate cannot be read');
  }
}

function checkTransport(url: string, startTls: boolean): void {
  const problem = transportProblem(url, startTls);
  if (problem === 'invalid_url') {
    throw new Problem('invalid_url', 'The URL must be ldap://host[:port] or ldaps://host[:port]');
  }
  if (problem === 'start_tls_with_ldaps') {
    throw new Problem(
      'invalid_url',
      'StartTLS upgrades ldap:// connections; ldaps:// is TLS already',
    );
  }
  if (problem === 'plain_ldap') {
    throw new Problem(
      'insecure_transport',
      'Use ldaps:// or StartTLS: passwords must not cross the network in clear',
    );
  }
}

/**
 * LDAP and Active Directory administration (M1-082, IAM-005, ADR-019) for site
 * administrators: directories with their connection, service account (the password is sealed
 * and never returned), what to read, read-only or read-write, precedence and schedule; a
 * connection test; asking for a sync; the run history. Runs themselves happen in the worker
 * (`ldap/scheduler.ts`).
 */
export function registerDirectoryRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { peppers: PepperRing | undefined },
): void {
  async function load(workspaceId: number, directoryId: number) {
    return (await db
      .selectFrom('ldap_directory')
      .select([...DIRECTORY_COLUMNS])
      .where('id', '=', directoryId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst()) as DirectoryRow | undefined;
  }

  async function views(workspaceId: number, rows: DirectoryRow[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [users, groups, runs] = await Promise.all([
      db
        .selectFrom('ldap_user')
        .select(['directory_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('directory_id', 'in', ids)
        .where('removed_at', 'is', null)
        .groupBy('directory_id')
        .execute(),
      db
        .selectFrom('ldap_group')
        .select(['directory_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('directory_id', 'in', ids)
        .groupBy('directory_id')
        .execute(),
      db
        .selectFrom('ldap_sync_run')
        .distinctOn('directory_id')
        .select(['directory_id', ...RUN_COLUMNS])
        .where('workspace_id', '=', workspaceId)
        .where('directory_id', 'in', ids)
        .orderBy('directory_id')
        .orderBy('id', 'desc')
        .execute(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      url: r.url,
      startTls: r.start_tls,
      caCertificates: r.ca_certificates.map(certificateSummary),
      bindDn: r.bind_dn,
      // Write-only: the password is never sent back.
      hasBindPassword: r.bind_password_sealed !== '',
      baseDn: r.base_dn,
      userBaseDn: r.user_base_dn,
      userFilter: r.user_filter,
      groupBaseDn: r.group_base_dn,
      groupFilter: r.group_filter,
      attributes: attributeMap(r.kind, r.attribute_map),
      attributeOverrides: r.attribute_map,
      mode: r.mode,
      position: r.position,
      enabled: r.enabled,
      syncIntervalMinutes: r.sync_interval_minutes,
      fullSyncHours: r.full_sync_hours,
      nextSyncAt: r.next_sync_at?.toISOString() ?? null,
      lastFullSyncAt: r.last_full_sync_at?.toISOString() ?? null,
      accounts: Number(users.find((u) => u.directory_id === r.id)?.n ?? 0),
      groups: Number(groups.find((g) => g.directory_id === r.id)?.n ?? 0),
      lastRun: (() => {
        const run = runs.find((x) => x.directory_id === r.id);
        return run ? runView(run as RunRow) : null;
      })(),
    }));
  }

  const presets = Object.fromEntries(
    DIRECTORY_KINDS.map((kind) => [
      kind,
      {
        userFilter: PRESETS[kind].userFilter,
        groupFilter: PRESETS[kind].groupFilter,
        attributes: PRESETS[kind].attributes,
      },
    ]),
  );

  app.get('/api/v1/directories', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const rows = (await db
      .selectFrom('ldap_directory')
      .select([...DIRECTORY_COLUMNS])
      .where('workspace_id', '=', request.workspaceId)
      .orderBy('position')
      .orderBy('id')
      .execute()) as DirectoryRow[];
    return { directories: await views(request.workspaceId, rows), presets };
  });

  app.get('/api/v1/directories/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await load(request.workspaceId, params.data.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const [view] = await views(request.workspaceId, [row]);
    return { directory: view };
  });

  app.post('/api/v1/directories', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    let cas: string[] | undefined;
    try {
      checkTransport(body.url, body.startTls ?? false);
      cas = certificates(body.caCertificates);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return reply.code(400).send({ error: error.code, detail: error.detail });
    }
    const ws = request.workspaceId;
    const preset = PRESETS[body.kind];
    try {
      const row = await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(${ws}, 82)`.execute(trx);
        const last = await trx
          .selectFrom('ldap_directory')
          .select((eb) => eb.fn.max('position').as('max'))
          .where('workspace_id', '=', ws)
          .executeTakeFirstOrThrow();
        const enabled = body.enabled ?? true;
        const created = (await trx
          .insertInto('ldap_directory')
          .values({
            workspace_id: ws,
            name: body.name,
            kind: body.kind,
            url: body.url,
            start_tls: body.startTls ?? false,
            ca_certificates: cas ?? [],
            bind_dn: body.bindDn,
            bind_password_sealed: sealSecret(body.bindPassword, options.peppers?.active),
            base_dn: body.baseDn,
            user_base_dn: body.userBaseDn ?? null,
            user_filter: body.userFilter ?? preset.userFilter,
            group_base_dn: body.groupBaseDn ?? null,
            group_filter: body.groupFilter ?? preset.groupFilter,
            attribute_map: JSON.stringify(body.attributes ?? {}),
            mode: body.mode ?? 'read_only',
            position: Number(last.max ?? 0) + 1,
            enabled,
            sync_interval_minutes: body.syncIntervalMinutes ?? 60,
            full_sync_hours: body.fullSyncHours ?? 24,
            // The worker's first run (a full one) starts at its next look.
            next_sync_at: enabled ? new Date() : null,
          })
          .returning([...DIRECTORY_COLUMNS])
          .executeTakeFirstOrThrow()) as DirectoryRow;
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'directory.created',
            subjectId: created.id,
            payload: {
              name: created.name,
              kind: created.kind,
              url: created.url,
              mode: created.mode,
              enabled: created.enabled,
              position: created.position,
            },
          },
        );
        return created;
      });
      const [view] = await views(ws, [row]);
      return reply.code(201).send({ directory: view });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/directories/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = editBody.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    const ws = request.workspaceId;
    const current = await load(ws, params.data.id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    let cas: string[] | undefined;
    try {
      checkTransport(body.url ?? current.url, body.startTls ?? current.start_tls);
      cas = certificates(body.caCertificates);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return reply.code(400).send({ error: error.code, detail: error.detail });
    }
    const next: Record<string, unknown> = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.startTls !== undefined ? { start_tls: body.startTls } : {}),
      ...(body.bindDn !== undefined ? { bind_dn: body.bindDn } : {}),
      ...(body.baseDn !== undefined ? { base_dn: body.baseDn } : {}),
      ...(body.userBaseDn !== undefined ? { user_base_dn: body.userBaseDn } : {}),
      ...(body.userFilter !== undefined ? { user_filter: body.userFilter } : {}),
      ...(body.groupBaseDn !== undefined ? { group_base_dn: body.groupBaseDn } : {}),
      ...(body.groupFilter !== undefined ? { group_filter: body.groupFilter } : {}),
      ...(body.attributes !== undefined ? { attribute_map: body.attributes } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.syncIntervalMinutes !== undefined
        ? { sync_interval_minutes: body.syncIntervalMinutes }
        : {}),
      ...(body.fullSyncHours !== undefined ? { full_sync_hours: body.fullSyncHours } : {}),
    };
    const changes = diff(current as unknown as Record<string, unknown>, next);
    const casChanged = cas !== undefined && cas.join('\n') !== current.ca_certificates.join('\n');
    const rescan = Object.keys(changes).some((k) => RESCAN.has(k));
    try {
      const row = await db.transaction().execute(async (trx) => {
        const updated = (await trx
          .updateTable('ldap_directory')
          .set({
            ...(next as object),
            ...(body.attributes !== undefined
              ? { attribute_map: JSON.stringify(body.attributes) }
              : {}),
            ...(cas !== undefined ? { ca_certificates: cas } : {}),
            ...(body.bindPassword !== undefined
              ? { bind_password_sealed: sealSecret(body.bindPassword, options.peppers?.active) }
              : {}),
            // What is read or how it is matched changed: the next run reads everything.
            ...(rescan ? { sync_cursor: null } : {}),
            ...(body.enabled === true && !current.enabled ? { next_sync_at: new Date() } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', current.id)
          .returning([...DIRECTORY_COLUMNS])
          .executeTakeFirstOrThrow()) as DirectoryRow;
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'directory.updated',
            subjectId: current.id,
            payload: {
              changes,
              bindPasswordChanged: body.bindPassword !== undefined,
              caCertificatesChanged: casChanged,
            },
          },
        );
        return updated;
      });
      const [view] = await views(ws, [row]);
      return { directory: view };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Removing a directory deactivates the accounts it manages (they keep their work) and leaves
  // its groups as ordinary Taskmoor groups. The last active site administrator stays.
  app.delete('/api/v1/directories/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('ldap_directory')
        .select(['id', 'name'])
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return 'not_found' as const;
      const accounts = await trx
        .selectFrom('ldap_user as l')
        .innerJoin('app_user as a', 'a.id', 'l.user_id')
        .select(['a.id', 'a.is_site_admin'])
        .where('l.directory_id', '=', row.id)
        .where('l.removed_at', 'is', null)
        .where('a.deactivated_at', 'is', null)
        .orderBy('a.id')
        .execute();
      const now = new Date();
      let deactivated = 0;
      for (const account of accounts) {
        const result = await deactivateAccount(trx, ws, account.id, now);
        if (result.refused === 'last_admin') return 'last_admin' as const;
        if (result.deactivated) deactivated += 1;
      }
      const groups = await trx
        .selectFrom('ldap_group')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('directory_id', '=', row.id)
        .executeTakeFirstOrThrow();
      await trx.deleteFrom('ldap_directory').where('id', '=', row.id).execute();
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        {
          type: 'directory.deleted',
          subjectId: row.id,
          payload: {
            name: row.name,
            deactivatedUsers: deactivated,
            releasedGroups: Number(groups.n),
          },
        },
      );
      return 'ok' as const;
    });
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (outcome === 'last_admin') return reply.code(409).send({ error: 'last_admin' });
    return reply.code(204).send();
  });

  // Precedence: when two directories hold the same address, the first one manages the account.
  app.put('/api/v1/directories/order', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const ids = parsed.data.ids;
    const outcome = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${ws}, 82)`.execute(trx);
      const rows = await trx
        .selectFrom('ldap_directory')
        .select('id')
        .where('workspace_id', '=', ws)
        .forUpdate()
        .execute();
      const all = new Set(rows.map((r) => r.id));
      if (
        ids.length !== all.size ||
        new Set(ids).size !== ids.length ||
        ids.some((i) => !all.has(i))
      ) {
        return 'mismatch' as const;
      }
      for (const [index, directoryId] of ids.entries()) {
        await trx
          .updateTable('ldap_directory')
          .set({ position: index + 1, updated_at: new Date() })
          .where('id', '=', directoryId)
          .execute();
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        { type: 'directory.reordered', subjectId: ws, payload: { ids } },
      );
      return 'ok' as const;
    });
    if (outcome === 'mismatch') {
      return reply.code(400).send({ error: 'invalid_order', detail: 'List every directory once' });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/directories/:id/sync', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = syncBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const directory = await load(ws, params.data.id);
    if (!directory) return reply.code(404).send({ error: 'not_found' });
    if (!directory.enabled) return reply.code(409).send({ error: 'directory_disabled' });
    const run = await db.transaction().execute(async (trx) => {
      const queued = await queueRun(trx, {
        workspaceId: ws,
        directoryId: directory.id,
        mode: parsed.data.mode,
        trigger: 'manual',
        requestedBy: admin.id,
        confirmRemovals: parsed.data.confirmRemovals,
      });
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        {
          type: 'directory.sync_requested',
          subjectId: directory.id,
          payload: {
            runId: queued.id,
            mode: parsed.data.mode,
            confirmRemovals: parsed.data.confirmRemovals,
            coalesced: queued.coalesced,
          },
        },
      );
      return (await trx
        .selectFrom('ldap_sync_run')
        .select([...RUN_COLUMNS])
        .where('id', '=', queued.id)
        .executeTakeFirstOrThrow()) as RunRow;
    });
    return reply.code(202).send({ run: runView(run) });
  });

  app.get('/api/v1/directories/:id/runs', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const directory = await load(request.workspaceId, params.data.id);
    if (!directory) return reply.code(404).send({ error: 'not_found' });
    const rows = (await db
      .selectFrom('ldap_sync_run')
      .select([...RUN_COLUMNS])
      .where('directory_id', '=', directory.id)
      .orderBy('id', 'desc')
      .limit(query.data.limit)
      .execute()) as RunRow[];
    return { runs: rows.map(runView) };
  });

  // Tries settings without saving them: connect, bind, and read a first page of people and
  // groups. With `id`, unsent fields (the password too) come from that directory.
  app.post('/api/v1/directories/test', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = testBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    const ws = request.workspaceId;
    const saved = body.id !== undefined ? await load(ws, body.id) : undefined;
    if (body.id !== undefined && !saved) return reply.code(404).send({ error: 'not_found' });
    const kind = body.kind ?? saved?.kind;
    const url = body.url ?? saved?.url;
    const bindDn = body.bindDn ?? saved?.bind_dn;
    const baseDn = body.baseDn ?? saved?.base_dn;
    if (!kind || !url || !bindDn || !baseDn || (body.bindPassword === undefined && !saved)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    let cas: string[] | undefined;
    try {
      checkTransport(url, body.startTls ?? saved?.start_tls ?? false);
      cas = certificates(body.caCertificates);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return reply.code(400).send({ error: error.code, detail: error.detail });
    }
    const row: DirectoryRow = {
      id: saved?.id ?? 0,
      workspace_id: ws,
      name: body.name ?? saved?.name ?? 'test',
      kind,
      url,
      start_tls: body.startTls ?? saved?.start_tls ?? false,
      ca_certificates: cas ?? saved?.ca_certificates ?? [],
      bind_dn: bindDn,
      bind_password_sealed: saved?.bind_password_sealed ?? '',
      base_dn: baseDn,
      user_base_dn: body.userBaseDn !== undefined ? body.userBaseDn : (saved?.user_base_dn ?? null),
      user_filter: body.userFilter ?? saved?.user_filter ?? PRESETS[kind].userFilter,
      group_base_dn:
        body.groupBaseDn !== undefined ? body.groupBaseDn : (saved?.group_base_dn ?? null),
      group_filter: body.groupFilter ?? saved?.group_filter ?? PRESETS[kind].groupFilter,
      attribute_map: (body.attributes ?? saved?.attribute_map ?? {}) as JsonValue,
      mode: body.mode ?? saved?.mode ?? 'read_only',
      position: 0,
      enabled: true,
      sync_interval_minutes: 60,
      full_sync_hours: 24,
      next_sync_at: null,
      last_full_sync_at: null,
      sync_cursor: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    let client: DirectoryClient | undefined;
    try {
      const settings = directorySettings(row, options.peppers, body.bindPassword);
      client = await DirectoryClient.connect(settings);
      const sample = async <T>(
        base: string,
        filter: string,
        attrs: string[],
        read: (e: Parameters<typeof readUser>[0]) => T,
      ) => {
        let count = 0;
        let more = false;
        const out: T[] = [];
        for await (const page of client?.search(base, filter, attrs, { pageSize: 200 }) ?? []) {
          for (const entry of page) {
            if (out.length < 5) out.push(read(entry));
            count += 1;
          }
          if (count >= 1000) {
            more = true;
            break;
          }
        }
        return { count, more, sample: out };
      };
      const users = await sample(
        settings.userBaseDn,
        settings.userFilter,
        userAttributes(settings),
        (e) => {
          const u = readUser(e, settings);
          return 'problem' in u
            ? { dn: u.dn, problem: u.problem }
            : {
                dn: u.dn,
                username: u.username,
                email: u.email,
                name: u.name,
                disabled: u.disabled,
              };
        },
      );
      const groups = await sample(
        settings.groupBaseDn,
        settings.groupFilter,
        groupAttributes(settings),
        (e) => {
          const g = readGroup(e, settings);
          return 'problem' in g
            ? { dn: g.dn, problem: g.problem }
            : { dn: g.dn, name: g.name, members: g.members.length };
        },
      );
      return { ok: true, users, groups };
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) {
        return {
          ok: false,
          error: error.reason === 'tls' ? 'tls_failed' : 'unreachable',
          detail: error.message.slice(0, 300),
        };
      }
      if (error instanceof DirectoryBindError) return { ok: false, error: 'bind_refused' };
      if (error instanceof SealedSecretError) return { ok: false, error: 'password_unreadable' };
      if (error instanceof DirectoryOperationError) {
        return { ok: false, error: 'search_failed', detail: error.message.slice(0, 300) };
      }
      throw error;
    } finally {
      await client?.close();
    }
  });
}
