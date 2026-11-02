import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { erasedEmail, erasedName } from '../privacy/placeholder';

/**
 * Searching and exporting the audit log (M1-003, IAM-013). Search pages newest first with a
 * cursor (the last seq seen); export streams oldest first in batches, so a log of any size
 * leaves the server in constant memory.
 */
export interface AuditFilter {
  /** occurred_at >= from */
  from?: Date;
  /** occurred_at < to */
  to?: Date;
  actorId?: number;
  /** Matches actions starting with this text: `user.` finds every user event. */
  action?: string;
  subjectType?: string;
  subjectId?: string;
}

export interface AuditView {
  seq: number;
  occurredAt: string;
  recordedAt: string;
  actor: { id: number; name: string | null; email: string | null } | null;
  action: string;
  subject: { type: string; id: string | null } | null;
  details: unknown;
  ip: string | null;
  sourceEventId: string | null;
  prevHash: string;
  hash: string;
  /**
   * The record is about an erased person (ADR-111): their name, email and address are shown as
   * the placeholder. The stored record is unchanged, so `hash` covers what was written, not
   * what is shown here; `audit-verify` checks the stored records.
   */
  masked?: true;
}

/** Keys whose values name a person in the details of a record about them. */
const PERSONAL_KEYS = new Set([
  'email',
  'name',
  'displayName',
  'userName',
  'givenName',
  'familyName',
]);

/** Details of a record about an erased person, with their personal values replaced. */
export function maskDetails(details: unknown, userId: number): unknown {
  const placeholder = (key: string) => (key === 'email' ? erasedEmail(userId) : erasedName(userId));
  const walk = (value: unknown, key: string | null): unknown => {
    if (key !== null && PERSONAL_KEYS.has(key)) {
      if (typeof value === 'string') return placeholder(key);
      // A change of a personal field: { from, to }.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? placeholder(key) : v]),
        );
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, null));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return walk(details, null);
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function selectRecords(db: Kysely<Database>, workspaceId: number, filter: AuditFilter) {
  let query = db
    .selectFrom('audit_event as e')
    .leftJoin('app_user as u', (join) =>
      join.onRef('u.id', '=', 'e.actor_id').onRef('u.workspace_id', '=', 'e.workspace_id'),
    )
    // The person a record is about, when it is about one: an erased one's values are masked.
    .leftJoin('app_user as s', (join) =>
      join
        .on(
          's.id',
          '=',
          sql<number>`(CASE WHEN e.subject_type = 'user' AND e.subject_id ~ '^[0-9]{1,9}$'
                        THEN e.subject_id::integer END)`,
        )
        .onRef('s.workspace_id', '=', 'e.workspace_id'),
    )
    .select([
      'e.seq',
      'e.occurred_at',
      'e.recorded_at',
      'e.actor_id',
      'u.name as actor_name',
      'u.email as actor_email',
      'u.erased_at as actor_erased_at',
      's.id as subject_user_id',
      's.erased_at as subject_erased_at',
      'e.action',
      'e.subject_type',
      'e.subject_id',
      'e.details',
      'e.ip',
      'e.source_event_id',
      'e.prev_hash',
      'e.hash',
    ])
    .where('e.workspace_id', '=', workspaceId);
  if (filter.from) {
    // recorded_at is never earlier than occurred_at, so older partitions are skipped.
    query = query
      .where('e.occurred_at', '>=', filter.from)
      .where('e.recorded_at', '>=', filter.from);
  }
  if (filter.to) query = query.where('e.occurred_at', '<', filter.to);
  if (filter.actorId !== undefined) query = query.where('e.actor_id', '=', filter.actorId);
  if (filter.action) query = query.where('e.action', 'like', `${escapeLike(filter.action)}%`);
  if (filter.subjectType) query = query.where('e.subject_type', '=', filter.subjectType);
  if (filter.subjectId) query = query.where('e.subject_id', '=', filter.subjectId);
  return query;
}

type Row = Awaited<ReturnType<ReturnType<typeof selectRecords>['execute']>>[number];

function toView(row: Row): AuditView {
  const subjectErased = row.subject_erased_at != null && row.subject_user_id != null;
  const actorErased = row.actor_erased_at != null;
  const view: AuditView = {
    seq: Number(row.seq),
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    actor:
      row.actor_id === null
        ? null
        : { id: row.actor_id, name: row.actor_name ?? null, email: row.actor_email ?? null },
    action: row.action,
    subject: row.subject_type === null ? null : { type: row.subject_type, id: row.subject_id },
    details: row.details,
    ip: row.ip,
    sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
  if (!subjectErased && !actorErased) return view;
  return {
    ...view,
    details: subjectErased ? maskDetails(row.details, row.subject_user_id as number) : view.details,
    // The address of a request is the person's who made it.
    ip: actorErased ? null : view.ip,
    masked: true,
  };
}

/** One page, newest first; `before` is the cursor (the last seq of the previous page). */
export async function searchAudit(
  db: Kysely<Database>,
  workspaceId: number,
  filter: AuditFilter,
  page: { before?: number; limit: number },
): Promise<{ records: AuditView[]; nextCursor: string | null }> {
  let query = selectRecords(db, workspaceId, filter);
  if (page.before !== undefined) query = query.where('e.seq', '<', String(page.before));
  const rows = await query
    .orderBy('e.seq', 'desc')
    .limit(page.limit + 1)
    .execute();
  const records = rows.slice(0, page.limit).map(toView);
  const last = records[records.length - 1];
  return { records, nextCursor: rows.length > page.limit && last ? String(last.seq) : null };
}

/** Every matching record after `from` (a seq), oldest first, read in batches. */
export async function* exportAudit(
  db: Kysely<Database>,
  workspaceId: number,
  filter: AuditFilter,
  batch = 1000,
  from = 0,
): AsyncGenerator<AuditView> {
  let after = from;
  for (;;) {
    const rows = await selectRecords(db, workspaceId, filter)
      .where('e.seq', '>', String(after))
      .orderBy('e.seq')
      .limit(batch)
      .execute();
    for (const row of rows) yield toView(row);
    const last = rows[rows.length - 1];
    if (!last || rows.length < batch) return;
    after = Number(last.seq);
  }
}

export const CSV_COLUMNS = [
  'seq',
  'occurred_at',
  'recorded_at',
  'actor_id',
  'actor_email',
  'actor_name',
  'action',
  'subject_type',
  'subject_id',
  'ip',
  'source_event_id',
  'details',
  'prev_hash',
  'hash',
] as const;

/**
 * One CSV field (RFC 4180). Text a spreadsheet would run as a formula (starting with =, +, -,
 * @, tab or carriage return) gets a leading apostrophe, so an exported name cannot become one.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(record: AuditView): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    seq: record.seq,
    occurred_at: record.occurredAt,
    recorded_at: record.recordedAt,
    actor_id: record.actor?.id,
    actor_email: record.actor?.email,
    actor_name: record.actor?.name,
    action: record.action,
    subject_type: record.subject?.type,
    subject_id: record.subject?.id,
    ip: record.ip,
    source_event_id: record.sourceEventId,
    details: JSON.stringify(record.details),
    prev_hash: record.prevHash,
    hash: record.hash,
  };
  return `${CSV_COLUMNS.map((c) => csvField(values[c])).join(',')}\r\n`;
}
