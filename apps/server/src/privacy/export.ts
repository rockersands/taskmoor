import type { Database } from '@taskmoor/db';
import { newObjectKey } from '@taskmoor/storage';
import { type Kysely, sql, type Transaction } from 'kysely';
import { dropUpload, keepUpload, registerUpload } from '../attachments/cleanup';
import type { AttachmentStores } from '../attachments/stores';
import type { Authorizer } from '../authz/authorizer';
import { enqueue, extendLock, type JobRunner } from '../events/queue';
import { type ExportSink, zipSink } from '../export/sinks';
import { ticketKey } from '../tickets/model';

/**
 * A person's own data as a download (ASVS 8.3.2; IAM-008; ADR-111). The person asks on their
 * profile page, or a site administrator asks for anyone; a background job writes a ZIP into
 * the attachment store, and whoever asked downloads it for a week.
 *
 * The ZIP holds JSON and NDJSON files and the person's uploads:
 * - `profile.json`: the account, groups and teams, single sign-on identities, second factors
 *   (kinds and key names, never secrets), API tokens (names, scopes, dates, never the token)
 *   and sessions (when, address, browser);
 * - `preferences.json`: notification and email settings, the person's properties, their saved
 *   searches;
 * - `tickets.ndjson`: tickets the person reported, created or is assigned, with their roles;
 * - `comments.ndjson`, `time-entries.ndjson`: what they wrote and logged;
 * - `attachments.ndjson` and `attachments/`: the files they uploaded that passed the scan;
 * - `audit.ndjson`: audit records they caused or that are about them; the address of a record
 *   someone else caused is left out (it is that person's);
 * - `manifest.json`, last: every file with its records, bytes and SHA-256.
 *
 * A download the person asked for shows the content of tickets only where they may see the
 * ticket now; others appear by id with the person's roles. A site administrator's download has
 * everything (they can export the whole workspace anyway).
 */
export const PERSONAL_EXPORT_TASK = 'privacy.export';
/** How long a finished download is kept. */
export const PERSONAL_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Ceiling of one download's size; uploads are what makes it large. */
const MAX_BYTES = 64 * 1024 ** 3;
const PAGE = 1000;

export const PERSONAL_EXPORT_FORMAT = 'taskmoor-personal-data';

export interface PersonalExportView {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  requestedBy: number | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  size: number | null;
}

type Row = {
  id: string;
  state: PersonalExportView['state'];
  requested_by: number | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
  size: string | null;
};

export const EXPORT_COLUMNS = [
  'id',
  'state',
  'requested_by',
  'created_at',
  'finished_at',
  'expires_at',
  'size',
] as const;

export function toExportView(row: Row): PersonalExportView {
  return {
    id: String(row.id),
    state: row.state,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    size: row.size === null ? null : Number(row.size),
  };
}

/**
 * Queues a download of `userId`'s data for `requestedBy`. Refused while one of theirs for the
 * same person is still being made.
 */
export async function requestPersonalExport(
  trx: Transaction<Database>,
  options: { workspaceId: number; userId: number; requestedBy: number },
): Promise<PersonalExportView | 'in_progress'> {
  const { workspaceId: ws, userId, requestedBy } = options;
  // One request at a time per person and requester: the person's row orders them.
  await trx
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  const pending = await trx
    .selectFrom('personal_export')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('user_id', '=', userId)
    .where('requested_by', '=', requestedBy)
    .where('state', 'in', ['queued', 'running'])
    .executeTakeFirst();
  if (pending) return 'in_progress';
  const row = await trx
    .insertInto('personal_export')
    .values({ workspace_id: ws, user_id: userId, requested_by: requestedBy })
    .returning([...EXPORT_COLUMNS])
    .executeTakeFirstOrThrow();
  await enqueue(trx, [
    {
      workspaceId: ws,
      task: PERSONAL_EXPORT_TASK,
      payload: { exportId: String(row.id) },
      key: `${PERSONAL_EXPORT_TASK}:${row.id}`,
      maxAttempts: 3,
    },
  ]);
  return toExportView(row);
}

/** One file of the ZIP and how many records it holds, for the manifest. */
interface FileEntry {
  name: string;
  records: number;
  bytes: number;
  sha256: string;
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** A name safe as a ZIP entry: letters, digits, dots, dashes and underscores, 100 at most. */
export function entryName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return (safe || 'file').slice(0, 100);
}

async function writeJson(sink: ExportSink, name: string, value: unknown): Promise<FileEntry> {
  const file = await sink.open(name);
  await file.line(JSON.stringify(value, null, 2));
  return { name, records: 1, ...(await file.close()) };
}

/** Writes one NDJSON file from pages of rows. */
async function writeLines<T>(
  sink: ExportSink,
  name: string,
  pages: AsyncGenerator<T[]>,
): Promise<FileEntry> {
  const file = await sink.open(name);
  let records = 0;
  for await (const page of pages) {
    for (const record of page) {
      await file.line(JSON.stringify(record));
      records++;
    }
  }
  return { name, records, ...(await file.close()) };
}

/** Pages of rows by a numeric key, ascending. */
async function* keyset<R extends { id: number | string }>(
  read: (after: number | string, limit: number) => Promise<R[]>,
): AsyncGenerator<R[]> {
  let after: number | string = 0;
  for (;;) {
    const rows = await read(after, PAGE);
    if (rows.length === 0) return;
    yield rows;
    after = (rows[rows.length - 1] as R).id;
    if (rows.length < PAGE) return;
  }
}

export interface PersonalDataOptions {
  workspaceId: number;
  userId: number;
  /** The person asked themselves: ticket content only where they may see the ticket now. */
  self: boolean;
  stores: AttachmentStores;
  authorizer: Authorizer;
  /** Called between pages, so a long export keeps its job's lock. */
  heartbeat?: () => void;
}

/** Writes the person's data into the sink and returns the manifest's files. */
export async function writePersonalData(
  db: Kysely<Database>,
  sink: ExportSink,
  options: PersonalDataOptions,
): Promise<FileEntry[]> {
  const { workspaceId: ws, userId } = options;
  const files: FileEntry[] = [];
  const visible = async (ids: number[]): Promise<Set<number>> =>
    options.self ? options.authorizer.visibleTicketIds(ws, { userId }, ids) : new Set(ids);
  const keys = async (ids: number[]) => {
    const rows = ids.length
      ? await db
          .selectFrom('ticket as k')
          .innerJoin('track as t', 't.id', 'k.track_id')
          .select(['k.id', 't.key', 'k.number'])
          .where('k.id', 'in', [...new Set(ids)])
          .execute()
      : [];
    const seen = await visible(rows.map((r) => r.id));
    return new Map(
      rows.filter((r) => seen.has(r.id)).map((r) => [r.id, ticketKey(r.key, r.number)]),
    );
  };

  // Profile ------------------------------------------------------------------------------------
  const user = await db
    .selectFrom('app_user')
    .selectAll()
    .where('workspace_id', '=', ws)
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const [groups, teams, identities, totp, keysRegistered, tokens, sessions] = await Promise.all([
    db
      .selectFrom('group_member as m')
      .innerJoin('user_group as g', 'g.id', 'm.group_id')
      .select(['g.name', 'm.added_at'])
      .where('m.user_id', '=', userId)
      .orderBy('g.name')
      .execute(),
    db
      .selectFrom('team_member as m')
      .innerJoin('team as t', 't.id', 'm.team_id')
      .select(['t.name', 'm.added_at'])
      .where('m.user_id', '=', userId)
      .orderBy('t.name')
      .execute(),
    db
      .selectFrom('user_identity as i')
      .innerJoin('identity_provider as p', 'p.id', 'i.provider_id')
      .select(['p.name as provider', 'i.subject', 'i.email', 'i.created_at', 'i.last_sign_in_at'])
      .where('i.user_id', '=', userId)
      .execute(),
    db
      .selectFrom('totp_credential')
      .select('created_at')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('webauthn_credential')
      .select(['name', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('api_token')
      .select(['name', 'scopes', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('user_session')
      .select(['created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent', 'client_id'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
  ]);
  files.push(
    await writeJson(sink, 'profile.json', {
      id: user.id,
      email: user.email,
      name: user.name,
      kind: user.kind,
      isSiteAdmin: user.is_site_admin,
      timeZone: user.time_zone,
      locale: user.locale,
      appearance: user.appearance,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
      lastSignInAt: iso(user.last_sign_in_at),
      passwordChangedAt: iso(user.password_changed_at),
      deactivatedAt: iso(user.deactivated_at),
      hasPassword: user.password_hash !== null,
      groups: groups.map((g) => ({ name: g.name, since: iso(g.added_at) })),
      teams: teams.map((t) => ({ name: t.name, since: iso(t.added_at) })),
      singleSignOn: identities.map((i) => ({
        provider: i.provider,
        subject: i.subject,
        email: i.email,
        linkedAt: iso(i.created_at),
        lastSignInAt: iso(i.last_sign_in_at),
      })),
      secondFactors: {
        authenticatorApp: totp ? { addedAt: iso(totp.created_at) } : null,
        securityKeys: keysRegistered.map((k) => ({
          name: k.name,
          addedAt: iso(k.created_at),
          lastUsedAt: iso(k.last_used_at),
        })),
      },
      apiTokens: tokens.map((t) => ({
        name: t.name,
        scopes: t.scopes,
        createdAt: iso(t.created_at),
        expiresAt: iso(t.expires_at),
        lastUsedAt: iso(t.last_used_at),
        revokedAt: iso(t.revoked_at),
      })),
      sessions: sessions.map((s) => ({
        startedAt: iso(s.created_at),
        lastSeenAt: iso(s.last_seen_at),
        expiresAt: iso(s.expires_at),
        address: s.ip,
        browser: s.user_agent,
        app: s.client_id,
      })),
    }),
  );

  // Preferences ----------------------------------------------------------------------------------
  const [preference, notificationSettings, properties, savedSearches] = await Promise.all([
    db.selectFrom('user_preference').selectAll().where('user_id', '=', userId).executeTakeFirst(),
    db
      .selectFrom('notification_preference')
      .select(['event', 'channel', 'enabled'])
      .where('user_id', '=', userId)
      .orderBy('event')
      .orderBy('channel')
      .execute(),
    db
      .selectFrom('user_property')
      .select(['key', 'value', 'updated_at'])
      .where('user_id', '=', userId)
      .orderBy('key')
      .execute(),
    db
      .selectFrom('saved_search')
      .select(['name', 'description', 'query', 'created_at'])
      .where('workspace_id', '=', ws)
      .where('owner_id', '=', userId)
      .orderBy('id')
      .execute(),
  ]);
  files.push(
    await writeJson(sink, 'preferences.json', {
      autoFollow: preference?.auto_follow ?? null,
      notifyOwnChanges: preference?.notify_own_changes ?? null,
      emailDelivery: preference?.email_delivery ?? null,
      quietHours:
        preference && preference.quiet_start !== null
          ? { start: preference.quiet_start, end: preference.quiet_end }
          : null,
      notifications: notificationSettings,
      properties: properties.map((p) => ({
        key: p.key,
        value: p.value,
        updatedAt: iso(p.updated_at),
      })),
      savedSearches: savedSearches.map((s) => ({
        name: s.name,
        description: s.description,
        query: s.query,
        createdAt: iso(s.created_at),
      })),
    }),
  );
  options.heartbeat?.();

  // Tickets ----------------------------------------------------------------------------------------
  files.push(
    await writeLines(
      sink,
      'tickets.ndjson',
      (async function* () {
        for await (const rows of keyset((after, limit) =>
          db
            .selectFrom('ticket as k')
            .innerJoin('track as t', 't.id', 'k.track_id')
            .innerJoin('status as s', 's.id', 'k.status_id')
            .select([
              'k.id',
              't.key as track_key',
              'k.number',
              'k.summary',
              'k.description',
              'k.environment',
              's.name as status',
              'k.assignee_id',
              'k.requester_id',
              'k.creator_id',
              'k.created_at',
              'k.updated_at',
              'k.deleted_at',
            ])
            .where('k.workspace_id', '=', ws)
            .where((eb) =>
              eb.or([
                eb('k.assignee_id', '=', userId),
                eb('k.requester_id', '=', userId),
                eb('k.creator_id', '=', userId),
              ]),
            )
            .where('k.id', '>', Number(after))
            .orderBy('k.id')
            .limit(limit)
            .execute(),
        )) {
          const seen = await visible(rows.map((r) => r.id));
          options.heartbeat?.();
          yield rows.map((r) => {
            const roles = [
              ...(r.requester_id === userId ? ['requester'] : []),
              ...(r.creator_id === userId ? ['creator'] : []),
              ...(r.assignee_id === userId ? ['assignee'] : []),
            ];
            if (!seen.has(r.id)) {
              return { id: r.id, roles, visible: false, createdAt: iso(r.created_at) };
            }
            return {
              id: r.id,
              key: ticketKey(r.track_key, r.number),
              roles,
              summary: r.summary,
              description: r.description,
              environment: r.environment,
              status: r.status,
              createdAt: iso(r.created_at),
              updatedAt: iso(r.updated_at),
              inTrash: r.deleted_at !== null,
            };
          });
        }
      })(),
    ),
  );

  // Comments and time ----------------------------------------------------------------------------
  files.push(
    await writeLines(
      sink,
      'comments.ndjson',
      (async function* () {
        for await (const rows of keyset((after, limit) =>
          db
            .selectFrom('ticket_comment')
            .select([
              'id',
              'ticket_id',
              'body',
              'visible_role_id',
              'visible_group_id',
              'created_at',
              'edited_at',
              'deleted_at',
            ])
            .where('workspace_id', '=', ws)
            .where('author_id', '=', userId)
            .where('id', '>', Number(after))
            .orderBy('id')
            .limit(limit)
            .execute(),
        )) {
          const named = await keys(rows.map((r) => r.ticket_id));
          options.heartbeat?.();
          yield rows.map((r) => ({
            id: r.id,
            ticketId: r.ticket_id,
            ticketKey: named.get(r.ticket_id) ?? null,
            body: r.body,
            restricted: r.visible_role_id !== null || r.visible_group_id !== null,
            createdAt: iso(r.created_at),
            editedAt: iso(r.edited_at),
            deletedAt: iso(r.deleted_at),
          }));
        }
      })(),
    ),
  );
  files.push(
    await writeLines(
      sink,
      'time-entries.ndjson',
      (async function* () {
        for await (const rows of keyset((after, limit) =>
          db
            .selectFrom('time_entry')
            .select(['id', 'ticket_id', 'started_at', 'duration', 'description', 'created_at'])
            .where('workspace_id', '=', ws)
            .where('author_id', '=', userId)
            .where('id', '>', Number(after))
            .orderBy('id')
            .limit(limit)
            .execute(),
        )) {
          const named = await keys(rows.map((r) => r.ticket_id));
          yield rows.map((r) => ({
            id: r.id,
            ticketId: r.ticket_id,
            ticketKey: named.get(r.ticket_id) ?? null,
            startedAt: iso(r.started_at),
            seconds: r.duration,
            description: r.description,
            createdAt: iso(r.created_at),
          }));
        }
      })(),
    ),
  );

  // Attachments: the list, then each file ----------------------------------------------------
  const uploads: { id: number; name: string; storage: 'local' | 's3'; key: string }[] = [];
  files.push(
    await writeLines(
      sink,
      'attachments.ndjson',
      (async function* () {
        for await (const rows of keyset((after, limit) =>
          db
            .selectFrom('attachment')
            .select([
              'id',
              'ticket_id',
              'name',
              'declared_type',
              'size',
              'sha256',
              'storage',
              'storage_key',
              'created_at',
            ])
            .where('workspace_id', '=', ws)
            .where('author_id', '=', userId)
            .where('scan_state', '=', 'clean')
            .where('id', '>', Number(after))
            .orderBy('id')
            .limit(limit)
            .execute(),
        )) {
          const named = await keys(rows.map((r) => r.ticket_id));
          yield rows.map((r) => {
            const file = options.stores.stores[r.storage]
              ? `attachments/${r.id}-${entryName(r.name)}`
              : null;
            if (file)
              uploads.push({ id: r.id, name: file, storage: r.storage, key: r.storage_key });
            return {
              id: r.id,
              ticketId: r.ticket_id,
              ticketKey: named.get(r.ticket_id) ?? null,
              name: r.name,
              type: r.declared_type,
              bytes: Number(r.size),
              sha256: r.sha256,
              createdAt: iso(r.created_at),
              file,
            };
          });
        }
      })(),
    ),
  );
  for (const upload of uploads) {
    const store = options.stores.stores[upload.storage];
    if (!store) continue;
    const written = await sink.copy(upload.name, await store.read(upload.key));
    files.push({ name: upload.name, records: 1, ...written });
    options.heartbeat?.();
  }

  // Audit records ------------------------------------------------------------------------------
  files.push(
    await writeLines(
      sink,
      'audit.ndjson',
      (async function* () {
        let after = 0;
        for (;;) {
          const rows = await db
            .selectFrom('audit_event')
            .select([
              'seq',
              'occurred_at',
              'actor_id',
              'action',
              'subject_type',
              'subject_id',
              'details',
              'ip',
            ])
            .where('workspace_id', '=', ws)
            .where((eb) =>
              eb.or([
                eb('actor_id', '=', userId),
                eb.and([eb('subject_type', '=', 'user'), eb('subject_id', '=', String(userId))]),
              ]),
            )
            .where('seq', '>', String(after))
            .orderBy('seq')
            .limit(PAGE)
            .execute();
          if (rows.length === 0) return;
          yield rows.map((r) => ({
            seq: Number(r.seq),
            occurredAt: iso(r.occurred_at),
            actorId: r.actor_id,
            action: r.action,
            subject: r.subject_type ? { type: r.subject_type, id: r.subject_id } : null,
            details: r.details,
            // Someone else's address is theirs, not this person's.
            ip: r.actor_id === userId ? r.ip : null,
          }));
          after = Number(rows[rows.length - 1]?.seq ?? after);
          options.heartbeat?.();
          if (rows.length < PAGE) return;
        }
      })(),
    ),
  );
  return files;
}

/** Makes one queued download: writes the ZIP into the active store and marks it ready. */
export async function runPersonalExport(
  db: Kysely<Database>,
  stores: AttachmentStores,
  authorizer: Authorizer,
  exportId: string,
  heartbeat?: () => void,
): Promise<'ready' | 'gone'> {
  const row = await db
    .updateTable('personal_export')
    .set({ state: 'running' })
    .where('id', '=', exportId)
    .where('state', 'in', ['queued', 'running'])
    .returning(['id', 'workspace_id', 'user_id', 'requested_by'])
    .executeTakeFirst();
  if (!row) return 'gone';
  const store = stores.active;
  if (!store) throw new Error('no attachment store is configured');
  const key = newObjectKey(row.workspace_id);
  await registerUpload(db, row.workspace_id, store.kind, key);
  const sink = zipSink();
  const stored = store.put(key, sink.output, {
    maxBytes: MAX_BYTES,
    contentType: 'application/zip',
  });
  try {
    const files = await writePersonalData(db, sink, {
      workspaceId: row.workspace_id,
      userId: row.user_id,
      self: row.requested_by === row.user_id,
      stores,
      authorizer,
      ...(heartbeat ? { heartbeat } : {}),
    });
    const manifest = await sink.open('manifest.json');
    await manifest.line(
      JSON.stringify(
        {
          format: PERSONAL_EXPORT_FORMAT,
          version: 1,
          createdAt: new Date().toISOString(),
          person: row.user_id,
          files,
        },
        null,
        2,
      ),
    );
    await manifest.close();
    await sink.finish();
    const result = await stored;
    const kept = await db.transaction().execute(async (trx) => {
      if (!(await keepUpload(trx, store.kind, key))) return false;
      const done = await trx
        .updateTable('personal_export')
        .set({
          state: 'ready',
          storage: store.kind,
          storage_key: key,
          size: result.size,
          sha256: result.sha256,
          error: null,
          finished_at: sql<Date>`now()`,
          expires_at: new Date(Date.now() + PERSONAL_EXPORT_TTL_MS),
        })
        .where('id', '=', row.id)
        .where('state', '=', 'running')
        .executeTakeFirst();
      return Number(done.numUpdatedRows) > 0;
    });
    // Erased or removed meanwhile: the file goes.
    if (!kept) {
      await dropUpload(db, stores, store.kind, key);
      return 'gone';
    }
    return 'ready';
  } catch (error) {
    (sink.output as unknown as { destroy(e?: Error): void }).destroy(error as Error);
    await stored.catch(() => undefined);
    await dropUpload(db, stores, store.kind, key);
    throw error;
  }
}

export function registerPersonalExportJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  stores: AttachmentStores,
  authorizer: Authorizer,
): void {
  runner.handle(PERSONAL_EXPORT_TASK, async (job) => {
    const { exportId } = job.payload as { exportId: string };
    const keep = setInterval(() => void extendLock(db, job.id).catch(() => {}), 15_000);
    try {
      await runPersonalExport(db, stores, authorizer, exportId);
    } catch (error) {
      // The last attempt marks the download failed, so the person can ask again.
      if (job.attempts >= job.maxAttempts) {
        await db
          .updateTable('personal_export')
          .set({
            state: 'failed',
            error: String((error as Error).message ?? error).slice(0, 500),
            finished_at: sql<Date>`now()`,
          })
          .where('id', '=', exportId)
          .where('state', 'in', ['queued', 'running'])
          .execute();
      }
      throw error;
    } finally {
      clearInterval(keep);
    }
  });
}

/**
 * Expired downloads lose their file (the storage sweep deletes it); their rows, and those of
 * failed ones, go a month later.
 */
export async function expirePersonalExports(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('personal_export')
      .select(['id', 'workspace_id', 'storage', 'storage_key'])
      .where('state', '=', 'ready')
      .where('expires_at', '<=', now)
      .forUpdate()
      .skipLocked()
      .limit(500)
      .execute();
    if (due.length > 0) {
      await trx
        .insertInto('storage_cleanup')
        .values(
          due.map((r) => ({
            workspace_id: r.workspace_id,
            storage: r.storage as 'local' | 's3',
            storage_key: r.storage_key as string,
            reason: 'deleted' as const,
            not_before: now,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['storage', 'storage_key']).doUpdateSet({ reason: 'deleted' }),
        )
        .execute();
      await trx
        .updateTable('personal_export')
        .set({ state: 'expired', storage_key: null })
        .where(
          'id',
          'in',
          due.map((r) => r.id),
        )
        .execute();
    }
    await trx
      .deleteFrom('personal_export')
      .where('state', 'in', ['expired', 'failed'])
      .where('created_at', '<', new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))
      .execute();
    return due.length;
  });
}
