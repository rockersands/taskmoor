import type { Database } from '@taskmoor/db';
import { throttleKeys } from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';
import { activeAdminCount } from '../directory';
import { emit } from '../events/bus';
import { enqueue, type JobRunner } from '../events/queue';
import { canonicalJson } from '../tickets/model';
import { erasedEmail, erasedName } from './placeholder';

export { ERASED_DOMAIN, erasedEmail, erasedName } from './placeholder';

/**
 * Erasing a person (ASVS 8.3.2; IAM-008 (2); ADR-111). A site administrator replaces the
 * account by a placeholder identity and removes what is personal about it; tickets, comments,
 * time and history stay, attributed to the placeholder.
 *
 * - The `app_user` row stays (every reference keeps pointing at it): its name becomes
 *   `Former user <id>`, its email `erased-<id>@erased.invalid`, and its password, time zone,
 *   locale, flags and dates go. It is deactivated and marked `erased_at`.
 * - Removed with it: sessions (and the OAuth tokens under them), API tokens, second factors and
 *   recovery codes, sign-in challenges, password links, single sign-on identities, directory and
 *   SCIM links, preferences, notification settings, notifications and the record of emails sent,
 *   unsubscribe links, saved-search mailings to them, recently viewed tickets, stars, outbox
 *   receipts, the AI notice acknowledgement, the person's properties, imported-identity
 *   mappings, sign-in counters kept under their email, and their personal data downloads
 *   (files included). Taskmoor stores no avatar.
 * - Domain events about the person have their old name and email replaced in the payload.
 * - Names written into other records are replaced by a job (`ERASE_SCRUB_TASK`), which finds
 *   them by the account's id alone: the history's display names of People fields, and the
 *   labels of mentions in descriptions, environments, comments, earlier comment versions and
 *   the history of rich text fields. Collaboration states and originals in another format of
 *   the documents it changes are dropped; both are rebuilt from the document.
 * - The audit log is append-only and hash-chained, so its records are never rewritten: they
 *   keep the account's id, which now names the placeholder, and the log hides the personal
 *   values its records carry about an erased account when it is read (`audit/query.ts`).
 *   `audit-verify` still verifies every record; retention removes them in time.
 *
 * Refused: the last active site administrator, oneself, an account a directory or SCIM still
 * manages (it would come back at the next sync), service accounts (not people), and a
 * confirmation that is not the account's email.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const ERASE_SCRUB_TASK = 'privacy.scrub';

export type EraseRefusal =
  | 'not_found'
  | 'already_erased'
  | 'cannot_erase_self'
  | 'last_admin'
  | 'confirmation_mismatch'
  | 'managed_by_directory'
  | 'managed_by_scim';

export interface ErasedReport {
  userId: number;
  label: string;
  endedSessions: number;
  /** Rows removed per kind of data, for the event and the administrator. */
  removed: Record<string, number>;
}

/** Tables keyed by the person whose rows simply go. Order matters where one references another. */
const PERSONAL_TABLES = [
  'notification',
  'email_delivery',
  'email_unsubscribe',
  'inbox_state',
  'api_token',
  'totp_credential',
  'webauthn_credential',
  'recovery_code',
  'sign_in_challenge',
  'password_link',
  'user_identity',
  'user_preference',
  'tutorial_progress',
  'notification_preference',
  'user_property',
  'saved_search_star',
  'ticket_visit',
  'mutation_receipt',
  'ai_notice_ack',
  'ldap_user',
  'scim_user',
] as const;

/** Every string in a JSON value equal to one of `from`'s keys (emails ignoring case) replaced. */
export function replaceStrings(value: unknown, from: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return from.get(value) ?? from.get(value.toLowerCase()) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, from));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, from)]));
  }
  return value;
}

/**
 * Erases a person in the caller's transaction and emits `user.erased`. `confirmEmail` must be
 * the account's email as the administrator typed it (case and spaces aside).
 */
export async function eraseUser(
  trx: Transaction<Database>,
  options: { workspaceId: number; userId: number; actorId: number; confirmEmail: string },
): Promise<ErasedReport | EraseRefusal> {
  const { workspaceId: ws, userId } = options;
  const user = await trx
    .selectFrom('app_user')
    .select(['id', 'email', 'name', 'is_site_admin', 'deactivated_at', 'erased_at'])
    .where('id', '=', userId)
    .where('workspace_id', '=', ws)
    .where('kind', '=', 'person')
    .forUpdate()
    .executeTakeFirst();
  if (!user) return 'not_found';
  if (user.erased_at !== null) return 'already_erased';
  if (user.id === options.actorId) return 'cannot_erase_self';
  if (options.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    return 'confirmation_mismatch';
  }
  if (user.is_site_admin && user.deactivated_at === null) {
    if ((await activeAdminCount(trx, ws)) <= 1) return 'last_admin';
  }
  const directory = await trx
    .selectFrom('ldap_user')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('removed_at', 'is', null)
    .executeTakeFirst();
  if (directory) return 'managed_by_directory';
  const scim = await trx
    .selectFrom('scim_user')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('removed_at', 'is', null)
    .executeTakeFirst();
  if (scim) return 'managed_by_scim';

  const removed: Record<string, number> = {};
  const count = (table: string, n: bigint | number | undefined) => {
    if (Number(n ?? 0) > 0) removed[table] = Number(n);
  };
  // Sessions first: OAuth codes, tokens and families under them go by cascade.
  const sessions = await trx
    .deleteFrom('user_session')
    .where('workspace_id', '=', ws)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  for (const table of PERSONAL_TABLES) {
    const result = await sql`DELETE FROM ${sql.table(table)}
      WHERE workspace_id = ${ws} AND user_id = ${userId}`.execute(trx);
    count(table, result.numAffectedRows);
  }
  // Saved-search results mailed to the person: their address is gone.
  const subscriptions = await trx
    .deleteFrom('saved_search_subscription')
    .where('workspace_id', '=', ws)
    .where('recipient_user_id', '=', userId)
    .executeTakeFirst();
  count('saved_search_subscription', subscriptions.numDeletedRows);
  const imported = await trx
    .deleteFrom('import_external_id')
    .where('workspace_id', '=', ws)
    .where('entity_kind', '=', 'user')
    .where('target_id', '=', String(userId))
    .executeTakeFirst();
  count('import_external_id', imported.numDeletedRows);
  const throttle = await trx
    .deleteFrom('sign_in_throttle')
    .where('workspace_id', '=', ws)
    .where('key', '=', throttleKeys(user.email, '').account)
    .executeTakeFirst();
  count('sign_in_throttle', throttle.numDeletedRows);
  count('personal_export', await dropPersonalExports(trx, ws, userId));
  // Invitations name the person by address (IAM-027); the role they gave stays with the row.
  const invited = await trx
    .deleteFrom('track_invitation')
    .where('workspace_id', '=', ws)
    .where('email', '=', user.email.toLowerCase())
    .executeTakeFirst();
  count('track_invitation', invited.numDeletedRows);

  const label = erasedName(userId);
  await trx
    .updateTable('app_user')
    .set((eb) => ({
      email: erasedEmail(userId),
      name: label,
      password_hash: null,
      is_site_admin: false,
      break_glass: false,
      description: '',
      time_zone: null,
      locale: null,
      appearance: 'system',
      password_changed_at: null,
      last_sign_in_at: null,
      deactivated_at: eb.fn.coalesce('deactivated_at', sql<Date>`now()`),
      erased_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    }))
    .where('id', '=', userId)
    .execute();

  // The old name and email in events about the person (created, updated, provisioned).
  const replacements = new Map<string, string>([
    [user.email.toLowerCase(), erasedEmail(userId)],
    [user.name, label],
  ]);
  const events = await trx
    .selectFrom('domain_event')
    .select(['id', 'payload'])
    .where('workspace_id', '=', ws)
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', String(userId))
    .execute();
  for (const event of events) {
    const scrubbed = replaceStrings(event.payload, replacements);
    if (canonicalJson(scrubbed) === canonicalJson(event.payload)) continue;
    await trx
      .updateTable('domain_event')
      .set({ payload: JSON.stringify(scrubbed) })
      .where('id', '=', event.id)
      .execute();
  }

  // Names written into other records go in the background, found by the id alone.
  await enqueue(trx, [
    {
      workspaceId: ws,
      task: ERASE_SCRUB_TASK,
      payload: { userId },
      key: `${ERASE_SCRUB_TASK}:${ws}:${userId}`,
      maxAttempts: 10,
    },
  ]);
  const report: ErasedReport = {
    userId,
    label,
    endedSessions: Number(sessions.numDeletedRows ?? 0),
    removed,
  };
  await emit(
    trx,
    { workspaceId: ws, actorId: options.actorId },
    {
      type: 'user.erased',
      subjectId: userId,
      payload: { label, endedSessions: report.endedSessions, removed },
    },
  );
  return report;
}

/** Removes a person's data downloads; their files go with the next storage sweep. */
export async function dropPersonalExports(db: Db, ws: number, userId: number): Promise<number> {
  const rows = await db
    .deleteFrom('personal_export')
    .where('workspace_id', '=', ws)
    .where((eb) => eb.or([eb('user_id', '=', userId), eb('requested_by', '=', userId)]))
    .returning(['storage', 'storage_key'])
    .execute();
  const files = rows.filter((r) => r.storage !== null && r.storage_key !== null);
  if (files.length > 0) {
    await db
      .insertInto('storage_cleanup')
      .values(
        files.map((r) => ({
          workspace_id: ws,
          storage: r.storage as 'local' | 's3',
          storage_key: r.storage_key as string,
          reason: 'deleted' as const,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['storage', 'storage_key'])
          .doUpdateSet({ reason: 'deleted', not_before: sql`now()` }),
      )
      .execute();
  }
  return rows.length;
}

// The scrub job ---------------------------------------------------------------------------------

/** Rows read and rewritten per statement. */
const SCRUB_BATCH = 500;

/** Whether a document mentions the person, as jsonpath over a jsonb column. */
const MENTIONS = '$.** ? (@.type == "mention" && (@.attrs.id == $sid || @.attrs.id == $nid))';

/** The document with every mention of the person labelled `label`. */
export function relabelMentions(doc: unknown, userId: number, label: string): unknown {
  if (Array.isArray(doc)) return doc.map((d) => relabelMentions(d, userId, label));
  if (!doc || typeof doc !== 'object') return doc;
  const node = doc as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
  const out: Record<string, unknown> = { ...node };
  if (node.type === 'mention' && node.attrs && String(node.attrs.id) === String(userId)) {
    out.attrs = { ...node.attrs, label };
  }
  if (Array.isArray(node.content)) {
    out.content = node.content.map((c) => relabelMentions(c, userId, label));
  }
  return out;
}

/**
 * A history display of people with the person's name replaced: the display lists the names of
 * the value's ids in order, joined by ", " (`fields/values.ts`). When the two do not line up (a
 * name holding ", "), the display is rebuilt from the names the people have now.
 */
function relabelDisplay(
  value: string | null,
  display: string | null,
  userId: number,
  label: string,
  names: ReadonlyMap<string, string>,
): string | null {
  if (value === null) return display;
  const ids = value.split(',');
  if (!ids.includes(String(userId))) return display;
  const parts = display?.split(', ') ?? [];
  if (parts.length === ids.length) {
    return ids.map((id, i) => (id === String(userId) ? label : parts[i])).join(', ');
  }
  return ids.map((id) => (id === String(userId) ? label : (names.get(id) ?? id))).join(', ');
}

export interface ScrubReport {
  historyDisplays: number;
  documents: number;
}

/**
 * Replaces the person's name where other records wrote it down (see the module comment). Safe
 * to run again: it finds what to change by the account's id and writes the placeholder.
 */
export async function scrubPersonReferences(
  db: Kysely<Database>,
  ws: number,
  userId: number,
): Promise<ScrubReport> {
  const user = await db
    .selectFrom('app_user')
    .select(['name', 'erased_at'])
    .where('workspace_id', '=', ws)
    .where('id', '=', userId)
    .executeTakeFirst();
  // Only an erased account's name is written over others' records.
  if (!user || user.erased_at === null) return { historyDisplays: 0, documents: 0 };
  const label = user.name;
  const report: ScrubReport = { historyDisplays: 0, documents: 0 };
  const id = String(userId);

  // 1. History: display names of People fields (assignee, requester, user custom fields).
  const userFields = await db
    .selectFrom('field')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('type', '=', 'user')
    .execute();
  const peopleFields = ['assignee', 'requester', ...userFields.map((f) => `cf[${f.id}]`)];
  const contains = (side: 'from_value' | 'to_value') =>
    sql<boolean>`(',' || ${sql.ref(side)} || ',') LIKE ${`%,${id},%`}`;
  let after = '0';
  for (;;) {
    const rows = await db
      .selectFrom('ticket_change')
      .select(['id', 'ticket_id', 'from_value', 'to_value', 'from_display', 'to_display'])
      .where('workspace_id', '=', ws)
      .where('field', 'in', peopleFields)
      .where((eb) => eb.or([contains('from_value'), contains('to_value')]))
      .where('id', '>', after)
      .orderBy('id')
      .limit(SCRUB_BATCH)
      .execute();
    if (rows.length === 0) break;
    const others = new Set(
      rows.flatMap((r) => [...(r.from_value?.split(',') ?? []), ...(r.to_value?.split(',') ?? [])]),
    );
    const named = await db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where(
        'id',
        'in',
        [...others].map(Number).filter((n) => Number.isSafeInteger(n) && n > 0),
      )
      .execute();
    const names = new Map(named.map((u) => [String(u.id), u.name]));
    for (const row of rows) {
      const fromDisplay = relabelDisplay(row.from_value, row.from_display, userId, label, names);
      const toDisplay = relabelDisplay(row.to_value, row.to_display, userId, label, names);
      if (fromDisplay === row.from_display && toDisplay === row.to_display) continue;
      await db
        .updateTable('ticket_change')
        .set({ from_display: fromDisplay, to_display: toDisplay })
        .where('ticket_id', '=', row.ticket_id)
        .where('id', '=', row.id)
        .execute();
      report.historyDisplays++;
    }
    after = rows[rows.length - 1]?.id ?? after;
  }

  // 2. Mentions in documents. Each statement finds the documents by jsonpath and rewrites them.
  const vars = JSON.stringify({ sid: id, nid: userId });
  const mentioned = (column: string) =>
    sql<boolean>`jsonb_path_exists(${sql.ref(column)}, ${MENTIONS}::jsonpath, ${vars}::jsonb)`;
  for (const field of ['description', 'environment'] as const) {
    let last = 0;
    for (;;) {
      const tickets = await db
        .selectFrom('ticket')
        .select(['id', field])
        .where('workspace_id', '=', ws)
        .where(field, 'is not', null)
        .where(mentioned(field))
        .where('id', '>', last)
        .orderBy('id')
        .limit(SCRUB_BATCH)
        .execute();
      if (tickets.length === 0) break;
      await db.transaction().execute(async (trx) => {
        for (const ticket of tickets) {
          const doc = (ticket as Record<string, unknown>)[field];
          await trx
            .updateTable('ticket')
            .set({ [field]: JSON.stringify(relabelMentions(doc, userId, label)) } as {
              description: string;
            })
            .where('id', '=', ticket.id)
            .execute();
          // Rebuilt from the document: the old state and original still hold the old name.
          await trx
            .deleteFrom('ticket_text_state')
            .where('ticket_id', '=', ticket.id)
            .where('field', '=', field)
            .execute();
          await trx
            .deleteFrom('ticket_text_original')
            .where('ticket_id', '=', ticket.id)
            .where('field', '=', field)
            .execute();
          report.documents++;
        }
      });
      last = tickets[tickets.length - 1]?.id ?? last;
    }
  }
  let lastComment = 0;
  for (;;) {
    const comments = await db
      .selectFrom('ticket_comment')
      .select(['id', 'body'])
      .where('workspace_id', '=', ws)
      .where(mentioned('body'))
      .where('id', '>', lastComment)
      .orderBy('id')
      .limit(SCRUB_BATCH)
      .execute();
    if (comments.length === 0) break;
    for (const comment of comments) {
      await db
        .updateTable('ticket_comment')
        .set({ body: JSON.stringify(relabelMentions(comment.body, userId, label)) })
        .where('id', '=', comment.id)
        .execute();
      report.documents++;
    }
    lastComment = comments[comments.length - 1]?.id ?? lastComment;
  }
  let lastVersion: { comment: number; version: number } = { comment: 0, version: 0 };
  for (;;) {
    const from = lastVersion;
    const versions = await db
      .selectFrom('ticket_comment_version')
      .select(['comment_id', 'version', 'body'])
      .where('workspace_id', '=', ws)
      .where(mentioned('body'))
      .where((eb) =>
        eb(eb.refTuple('comment_id', 'version'), '>', eb.tuple(from.comment, from.version)),
      )
      .orderBy('comment_id')
      .orderBy('version')
      .limit(SCRUB_BATCH)
      .execute();
    const tail = versions[versions.length - 1];
    if (!tail) break;
    lastVersion = { comment: tail.comment_id, version: tail.version };
    for (const version of versions) {
      await db
        .updateTable('ticket_comment_version')
        .set({ body: JSON.stringify(relabelMentions(version.body, userId, label)) })
        .where('comment_id', '=', version.comment_id)
        .where('version', '=', version.version)
        .execute();
      report.documents++;
    }
  }
  // The history of rich text fields keeps each document as canonical JSON text.
  let lastChange = '0';
  for (;;) {
    const rows = await db
      .selectFrom('ticket_change')
      .select(['id', 'ticket_id', 'from_value', 'to_value'])
      .where('workspace_id', '=', ws)
      .where('field', 'in', ['description', 'environment'])
      .where((eb) =>
        eb.or([eb('from_value', 'like', '%"mention"%'), eb('to_value', 'like', '%"mention"%')]),
      )
      .where('id', '>', lastChange)
      .orderBy('id')
      .limit(SCRUB_BATCH)
      .execute();
    if (rows.length === 0) break;
    for (const row of rows) {
      const rewrite = (text: string | null) => {
        if (text === null) return null;
        try {
          return canonicalJson(relabelMentions(JSON.parse(text), userId, label));
        } catch {
          return text;
        }
      };
      const from = rewrite(row.from_value);
      const to = rewrite(row.to_value);
      if (from === row.from_value && to === row.to_value) continue;
      await db
        .updateTable('ticket_change')
        .set({ from_value: from, to_value: to })
        .where('ticket_id', '=', row.ticket_id)
        .where('id', '=', row.id)
        .execute();
      report.documents++;
    }
    lastChange = rows[rows.length - 1]?.id ?? lastChange;
  }
  return report;
}

export function registerEraseJobs(runner: JobRunner, db: Kysely<Database>): void {
  runner.handle(ERASE_SCRUB_TASK, async (job) => {
    const { userId } = job.payload as { userId: number };
    await scrubPersonReferences(db, job.workspaceId, userId);
  });
}
