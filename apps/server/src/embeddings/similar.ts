import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { type VectorSearch, versionAtLeast } from './vector';

/**
 * Similar tickets (M1-078; AI-012 (2), AI-016; ADR-106): the tickets nearest to a vector, by
 * their own vector or by one of their comments', among those the person may see. The
 * permission filter is the one search uses (`TicketFilter.sql` on `k`, ADR-012) and comments
 * count only where the person reads them (`commentReadableSql` on `c`), so a hidden ticket or
 * a restricted comment can never place a result, nor be named by one.
 *
 * With pgvector, the nearest come from the HNSW index (the person's filter applied as it
 * scans; pgvector 0.8 and later keep scanning until enough pass); when the index returns too
 * few, the same filter is scanned exactly. Without pgvector, the permitted vectors are read a
 * page at a time and the best kept here.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface SimilarQuery {
  workspaceId: number;
  vector: Float32Array;
  model: string;
  /** The person's ticket filter, on `k`. */
  tickets: RawBuilder<boolean>;
  /** Which comments the person reads, on `c` with its ticket `k`. */
  comments: RawBuilder<boolean>;
  trackId?: number;
  /** The ticket the lookup is for: never its own result. */
  exclude?: number;
  limit: number;
}

export interface SimilarHit {
  ticketId: number;
  /** Cosine similarity, -1 to 1. */
  score: number;
  /** Whether the ticket's own text or one of its comments matched best. */
  match: 'ticket' | 'comment';
  commentId?: number;
}

interface Candidate {
  id: number;
  ticket_id: number;
  score: number;
}

/** How many vectors the exact scan reads per statement. */
const SCAN_PAGE = 2_000;

export async function similarTickets(
  db: Kysely<Database>,
  query: SimilarQuery,
  search: { mode: VectorSearch; version: string | null },
): Promise<SimilarHit[]> {
  const take = Math.max(1, query.limit);
  // Comments are many per ticket: read more of them so a few tickets' threads cannot crowd
  // out the rest.
  const commentTake = take * 3;
  let tickets: Candidate[];
  let comments: Candidate[];
  if (search.mode === 'pgvector') {
    ({ tickets, comments } = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('hnsw.ef_search', ${String(Math.min(1000, Math.max(100, take * 10)))}, true)`.execute(
        trx,
      );
      if (versionAtLeast(search.version, 0, 8)) {
        await sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`.execute(trx);
      }
      const t = await nearestTickets(trx, query, take, false);
      const c = await nearestComments(trx, query, commentTake, false);
      return {
        tickets: t.length < take ? await nearestTickets(trx, query, take, true) : t,
        comments: c.length < commentTake ? await nearestComments(trx, query, commentTake, true) : c,
      };
    }));
  } else {
    tickets = await scan(db, query, 'ticket', take);
    comments = await scan(db, query, 'comment', commentTake);
  }
  const best = new Map<number, SimilarHit>();
  for (const t of tickets) {
    best.set(t.ticket_id, { ticketId: t.ticket_id, score: t.score, match: 'ticket' });
  }
  for (const c of comments) {
    const held = best.get(c.ticket_id);
    if (!held || c.score > held.score) {
      best.set(c.ticket_id, {
        ticketId: c.ticket_id,
        score: c.score,
        match: 'comment',
        commentId: c.id,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.ticketId - b.ticketId)
    .slice(0, take)
    .map((hit) => ({ ...hit, score: Math.round(hit.score * 10_000) / 10_000 }));
}

const dims = (q: SimilarQuery) => sql.raw(String(q.vector.length));
const queryVector = (q: SimilarQuery) =>
  sql`${Array.from(q.vector, (v) => Number(v.toPrecision(8)))}::real[]::vector(${dims(q)})`;

function ticketScope(q: SimilarQuery): RawBuilder<boolean> {
  return sql<boolean>`k.workspace_id = ${q.workspaceId} AND k.deleted_at IS NULL
    AND (${q.trackId === undefined} OR k.track_id = ${q.trackId ?? 0})
    AND k.id <> ${q.exclude ?? 0}
    AND ${q.tickets}`;
}

/**
 * The nearest tickets by pgvector's cosine distance. `exact` keeps the planner off the HNSW
 * index (a materialised set has none), for when the index ran out before enough passed.
 */
async function nearestTickets(
  trx: Transaction<Database>,
  q: SimilarQuery,
  take: number,
  exact: boolean,
): Promise<Candidate[]> {
  const where = sql`e.workspace_id = ${q.workspaceId} AND e.model = ${q.model}
    AND cardinality(e.embedding) = ${q.vector.length} AND ${ticketScope(q)}`;
  const { rows } = exact
    ? await sql<Candidate>`
        WITH permitted AS MATERIALIZED (
          SELECT e.ticket_id, e.embedding FROM ticket_embedding e
            JOIN ticket k ON k.id = e.ticket_id
           WHERE ${where})
        SELECT ticket_id AS id, ticket_id,
               1 - ((embedding::vector(${dims(q)})) <=> ${queryVector(q)}) AS score
          FROM permitted
         ORDER BY (embedding::vector(${dims(q)})) <=> ${queryVector(q)}, ticket_id
         LIMIT ${take}`.execute(trx)
    : await sql<Candidate>`
        SELECT e.ticket_id AS id, e.ticket_id,
               1 - ((e.embedding::vector(${dims(q)})) <=> ${queryVector(q)}) AS score
          FROM ticket_embedding e
          JOIN ticket k ON k.id = e.ticket_id
         WHERE ${where}
         ORDER BY (e.embedding::vector(${dims(q)})) <=> ${queryVector(q)}
         LIMIT ${take}`.execute(trx);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

async function nearestComments(
  trx: Transaction<Database>,
  q: SimilarQuery,
  take: number,
  exact: boolean,
): Promise<Candidate[]> {
  const where = sql`e.workspace_id = ${q.workspaceId} AND e.model = ${q.model}
    AND cardinality(e.embedding) = ${q.vector.length} AND c.deleted_at IS NULL
    AND ${ticketScope(q)} AND ${q.comments}`;
  const { rows } = exact
    ? await sql<Candidate>`
        WITH permitted AS MATERIALIZED (
          SELECT e.comment_id, e.ticket_id, e.embedding FROM comment_embedding e
            JOIN ticket_comment c ON c.id = e.comment_id
            JOIN ticket k ON k.id = e.ticket_id
           WHERE ${where})
        SELECT comment_id AS id, ticket_id,
               1 - ((embedding::vector(${dims(q)})) <=> ${queryVector(q)}) AS score
          FROM permitted
         ORDER BY (embedding::vector(${dims(q)})) <=> ${queryVector(q)}, comment_id
         LIMIT ${take}`.execute(trx)
    : await sql<Candidate>`
        SELECT e.comment_id AS id, e.ticket_id,
               1 - ((e.embedding::vector(${dims(q)})) <=> ${queryVector(q)}) AS score
          FROM comment_embedding e
          JOIN ticket_comment c ON c.id = e.comment_id
          JOIN ticket k ON k.id = e.ticket_id
         WHERE ${where}
         ORDER BY (e.embedding::vector(${dims(q)})) <=> ${queryVector(q)}
         LIMIT ${take}`.execute(trx);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * `array_send` of a `real[]`: a 20-byte header for one dimension, then each element as a
 * 4-byte length and a big-endian float.
 */
export function decodeRealArray(bytes: Buffer, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = bytes.readFloatBE(20 + i * 8 + 4);
  return out;
}

/** Without pgvector: every permitted vector, a page at a time, the best `take` kept. */
async function scan(
  db: Db,
  q: SimilarQuery,
  kind: 'ticket' | 'comment',
  take: number,
): Promise<Candidate[]> {
  const n = q.vector.length;
  const best: Candidate[] = [];
  let after = 0;
  for (;;) {
    const { rows } =
      kind === 'ticket'
        ? await sql<{ id: number; ticket_id: number; bin: Buffer }>`
            SELECT e.ticket_id AS id, e.ticket_id, array_send(e.embedding) AS bin
              FROM ticket_embedding e
              JOIN ticket k ON k.id = e.ticket_id
             WHERE e.workspace_id = ${q.workspaceId} AND e.model = ${q.model}
               AND cardinality(e.embedding) = ${n} AND e.ticket_id > ${after}
               AND ${ticketScope(q)}
             ORDER BY e.ticket_id LIMIT ${SCAN_PAGE}`.execute(db)
        : await sql<{ id: number; ticket_id: number; bin: Buffer }>`
            SELECT e.comment_id AS id, e.ticket_id, array_send(e.embedding) AS bin
              FROM comment_embedding e
              JOIN ticket_comment c ON c.id = e.comment_id
              JOIN ticket k ON k.id = e.ticket_id
             WHERE e.workspace_id = ${q.workspaceId} AND e.model = ${q.model}
               AND cardinality(e.embedding) = ${n} AND e.comment_id > ${after}
               AND c.deleted_at IS NULL AND ${ticketScope(q)} AND ${q.comments}
             ORDER BY e.comment_id LIMIT ${SCAN_PAGE}`.execute(db);
    for (const row of rows) {
      const bytes = row.bin;
      let score = 0;
      for (let i = 0; i < n; i++) {
        score += bytes.readFloatBE(20 + i * 8 + 4) * (q.vector[i] as number);
      }
      if (best.length < take || score > (best.at(-1)?.score ?? -2)) {
        best.push({ id: row.id, ticket_id: row.ticket_id, score });
        best.sort((a, b) => b.score - a.score || a.id - b.id);
        if (best.length > take) best.pop();
      }
    }
    if (rows.length < SCAN_PAGE) return best;
    after = rows.at(-1)?.id ?? after;
  }
}
