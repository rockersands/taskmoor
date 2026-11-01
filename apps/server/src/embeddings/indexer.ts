import type { Embedder } from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * Keeps the vectors of tickets and comments current (M1-078; AI-012; ADR-106). A ticket's
 * vector is made from its summary and description, a comment's from its body, both as the SQL
 * function `taskmoor_embedding_text` reads them (migration 0079), so the hash that says "this
 * text is already embedded" is computed where the text is. Rows of another model, or of a text
 * that changed since, are stale and computed again; trashed tickets, deleted comments and
 * texts without words have no row.
 *
 * The event subscriber refreshes what an event names; the sweep (worker job and
 * `cli.mjs embeddings`) catches up with everything else: imports, which emit no ticket events,
 * a first start after the upgrade that brought embeddings, or a change of model.
 */
type Db = Kysely<Database>;

export interface SweepCursor {
  ticket: number;
  comment: number;
}

export interface SweepResult {
  tickets: number;
  comments: number;
  removed: number;
  /** Where the next run resumes; null when nothing stale is left. */
  next: SweepCursor | null;
}

const TICKET_TEXT = sql<string>`taskmoor_embedding_text(k.summary, k.description)`;
const COMMENT_TEXT = sql<string>`taskmoor_embedding_text(NULL, c.body)`;
/** Rows read and embedded per round: a few seconds of the model's time at most. */
const PAGE = 64;

interface Pending {
  id: number;
  ticket_id: number;
  text: string;
  hash: string;
}

/** A vector as Postgres takes it for `real[]`: plain numbers, eight significant digits. */
function toArray(vector: Float32Array): number[] {
  return Array.from(vector, (v) => Number(v.toPrecision(8)));
}

export class EmbeddingIndexer {
  constructor(
    private readonly db: Db,
    readonly embedder: Embedder,
  ) {}

  /** Stale or missing ticket vectors among `ids` (all tickets after `after` when ids is null). */
  private async staleTickets(
    ws: number,
    ids: readonly number[] | null,
    after = 0,
  ): Promise<Pending[]> {
    const { rows } = await sql<Pending>`
      SELECT k.id, k.id AS ticket_id, s.text, md5(s.text) AS hash
        FROM ticket k
        CROSS JOIN LATERAL (SELECT ${TICKET_TEXT} AS text) s
        LEFT JOIN ticket_embedding e ON e.ticket_id = k.id
       WHERE k.workspace_id = ${ws} AND k.deleted_at IS NULL
         AND (${ids === null} OR k.id = ANY(${[...(ids ?? [])]}::int[]))
         AND k.id > ${after}
         AND (e.ticket_id IS NULL OR e.model <> ${this.embedder.model}
              OR e.source_hash <> md5(s.text))
       ORDER BY k.id LIMIT ${PAGE}`.execute(this.db);
    return rows;
  }

  private async staleComments(
    ws: number,
    ids: readonly number[] | null,
    after = 0,
  ): Promise<Pending[]> {
    const { rows } = await sql<Pending>`
      SELECT c.id, c.ticket_id, s.text, md5(s.text) AS hash
        FROM ticket_comment c
        JOIN ticket k ON k.id = c.ticket_id AND k.deleted_at IS NULL
        CROSS JOIN LATERAL (SELECT ${COMMENT_TEXT} AS text) s
        LEFT JOIN comment_embedding e ON e.comment_id = c.id
       WHERE c.workspace_id = ${ws} AND c.deleted_at IS NULL
         AND (${ids === null} OR c.id = ANY(${[...(ids ?? [])]}::int[]))
         AND c.id > ${after}
         AND (e.comment_id IS NULL OR e.model <> ${this.embedder.model}
              OR e.source_hash <> md5(s.text))
       ORDER BY c.id LIMIT ${PAGE}`.execute(this.db);
    return rows;
  }

  /** Embeds the pending texts and writes their rows; empty texts lose theirs. Returns how many. */
  private async write(ws: number, kind: 'ticket' | 'comment', pending: Pending[]) {
    const empty = pending.filter((p) => p.text.trim() === '').map((p) => p.id);
    const work = pending.filter((p) => p.text.trim() !== '');
    if (empty.length > 0) {
      if (kind === 'ticket') {
        await this.db.deleteFrom('ticket_embedding').where('ticket_id', 'in', empty).execute();
      } else {
        await this.db.deleteFrom('comment_embedding').where('comment_id', 'in', empty).execute();
      }
    }
    if (work.length === 0) return 0;
    const vectors = await this.embedder.embed(work.map((p) => p.text));
    const model = this.embedder.model;
    if (kind === 'ticket') {
      await this.db
        .insertInto('ticket_embedding')
        .values(
          work.map((p, i) => ({
            ticket_id: p.id,
            workspace_id: ws,
            model,
            source_hash: p.hash,
            embedding: toArray(vectors[i] as Float32Array),
          })),
        )
        .onConflict((oc) =>
          oc.column('ticket_id').doUpdateSet((eb) => ({
            model: eb.ref('excluded.model'),
            source_hash: eb.ref('excluded.source_hash'),
            embedding: eb.ref('excluded.embedding'),
            embedded_at: sql`now()`,
          })),
        )
        // A ticket deleted for good while its text was being embedded has nothing to keep.
        .execute()
        .catch((error: unknown) => {
          if ((error as { code?: string }).code !== '23503') throw error;
        });
    } else {
      await this.db
        .insertInto('comment_embedding')
        .values(
          work.map((p, i) => ({
            comment_id: p.id,
            ticket_id: p.ticket_id,
            workspace_id: ws,
            model,
            source_hash: p.hash,
            embedding: toArray(vectors[i] as Float32Array),
          })),
        )
        .onConflict((oc) =>
          oc.column('comment_id').doUpdateSet((eb) => ({
            ticket_id: eb.ref('excluded.ticket_id'),
            model: eb.ref('excluded.model'),
            source_hash: eb.ref('excluded.source_hash'),
            embedding: eb.ref('excluded.embedding'),
            embedded_at: sql`now()`,
          })),
        )
        .execute()
        .catch((error: unknown) => {
          if ((error as { code?: string }).code !== '23503') throw error;
        });
    }
    return work.length;
  }

  /**
   * Brings these tickets' vectors and their comments' up to date: embeds what is stale, drops
   * the rows of tickets in the trash or gone. Returns how many texts were embedded.
   */
  async refreshTickets(ws: number, ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.dropTrashed(ws, ids);
    let embedded = 0;
    for (let from = 0; from < ids.length; from += PAGE) {
      const page = ids.slice(from, from + PAGE);
      embedded += await this.write(ws, 'ticket', await this.staleTickets(ws, page));
    }
    return embedded;
  }

  /** The same for comments, by comment id; deleted ones lose their rows. */
  async refreshComments(ws: number, ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.db
      .deleteFrom('comment_embedding')
      .where('workspace_id', '=', ws)
      .where('comment_id', 'in', [...ids])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ticket_comment as c')
              .select('c.id')
              .whereRef('c.id', '=', 'comment_embedding.comment_id')
              .where('c.deleted_at', 'is', null),
          ),
        ),
      )
      .execute();
    let embedded = 0;
    for (let from = 0; from < ids.length; from += PAGE) {
      const page = ids.slice(from, from + PAGE);
      embedded += await this.write(ws, 'comment', await this.staleComments(ws, page));
    }
    return embedded;
  }

  /** A ticket's own comments, to refresh with it after a restore. */
  async commentIdsOf(ws: number, ticketIds: readonly number[]): Promise<number[]> {
    if (ticketIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('ticket_comment')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('ticket_id', 'in', [...ticketIds])
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((r) => r.id);
  }

  /** Tickets in the trash (or gone) keep no vectors, nor do their comments. */
  async dropTrashed(ws: number, ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const trashed = sql<boolean>`NOT EXISTS (
      SELECT 1 FROM ticket k WHERE k.id = ticket_id AND k.deleted_at IS NULL)`;
    const tickets = await this.db
      .deleteFrom('ticket_embedding')
      .where('workspace_id', '=', ws)
      .where('ticket_id', 'in', [...ids])
      .where(trashed)
      .executeTakeFirst();
    const comments = await this.db
      .deleteFrom('comment_embedding')
      .where('workspace_id', '=', ws)
      .where('ticket_id', 'in', [...ids])
      .where(trashed)
      .executeTakeFirst();
    return Number(tickets.numDeletedRows) + Number(comments.numDeletedRows);
  }

  /**
   * One stretch of the catch-up: embeds stale tickets, then stale comments, from `from` on,
   * for about `budgetMs`, and says where to resume. Rows of trashed tickets and deleted
   * comments are removed on the first stretch.
   */
  async sweep(
    ws: number,
    from: SweepCursor = { ticket: 0, comment: 0 },
    budgetMs = 5_000,
  ): Promise<SweepResult> {
    const started = Date.now();
    const result: SweepResult = { tickets: 0, comments: 0, removed: 0, next: null };
    if (from.ticket === 0 && from.comment === 0) result.removed = await this.removeOrphans(ws);
    const cursor = { ...from };
    while (cursor.ticket >= 0) {
      const page = await this.staleTickets(ws, null, cursor.ticket);
      if (page.length === 0) {
        cursor.ticket = -1;
        break;
      }
      result.tickets += await this.write(ws, 'ticket', page);
      cursor.ticket = page.at(-1)?.id ?? cursor.ticket;
      if (Date.now() - started > budgetMs) return { ...result, next: cursor };
    }
    for (;;) {
      const page = await this.staleComments(ws, null, cursor.comment);
      if (page.length === 0) return result;
      result.comments += await this.write(ws, 'comment', page);
      cursor.comment = page.at(-1)?.id ?? cursor.comment;
      if (Date.now() - started > budgetMs) return { ...result, next: cursor };
    }
  }

  /** Rows whose ticket is in the trash or whose comment was deleted. */
  private async removeOrphans(ws: number): Promise<number> {
    const tickets = await sql`
      DELETE FROM ticket_embedding e USING ticket k
       WHERE e.workspace_id = ${ws} AND k.id = e.ticket_id AND k.deleted_at IS NOT NULL`.execute(
      this.db,
    );
    const comments = await sql`
      DELETE FROM comment_embedding e USING ticket_comment c, ticket k
       WHERE e.workspace_id = ${ws} AND c.id = e.comment_id AND k.id = c.ticket_id
         AND (c.deleted_at IS NOT NULL OR k.deleted_at IS NOT NULL)`.execute(this.db);
    return Number(tickets.numAffectedRows ?? 0) + Number(comments.numAffectedRows ?? 0);
  }

  /** Every vector of the workspace goes, so the next sweep computes them all again. */
  async clear(ws: number): Promise<number> {
    const tickets = await this.db
      .deleteFrom('ticket_embedding')
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    const comments = await this.db
      .deleteFrom('comment_embedding')
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    return Number(tickets.numDeletedRows) + Number(comments.numDeletedRows);
  }

  /** How many tickets and comments have a current vector, and how many could. */
  async coverage(ws: number) {
    const { rows } = await sql<{
      tickets: string;
      ticket_vectors: string;
      comments: string;
      comment_vectors: string;
    }>`
      SELECT
        (SELECT count(*) FROM ticket WHERE workspace_id = ${ws} AND deleted_at IS NULL) AS tickets,
        (SELECT count(*) FROM ticket_embedding WHERE workspace_id = ${ws}
            AND model = ${this.embedder.model}) AS ticket_vectors,
        (SELECT count(*) FROM ticket_comment c JOIN ticket k ON k.id = c.ticket_id
          WHERE c.workspace_id = ${ws} AND c.deleted_at IS NULL AND k.deleted_at IS NULL)
          AS comments,
        (SELECT count(*) FROM comment_embedding WHERE workspace_id = ${ws}
            AND model = ${this.embedder.model}) AS comment_vectors`.execute(this.db);
    const r = rows[0];
    return {
      tickets: Number(r?.tickets ?? 0),
      ticketVectors: Number(r?.ticket_vectors ?? 0),
      comments: Number(r?.comments ?? 0),
      commentVectors: Number(r?.comment_vectors ?? 0),
    };
  }
}
