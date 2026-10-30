import { type Kysely, sql } from 'kysely';

/**
 * Full-text search (M1-040; QRY-007; ADR-065). Replaces the word indexes of 0043, which read
 * words as written (`simple`), with stemmed ones kept in stored columns, and adds trigram
 * indexes for patterns on short text.
 *
 * - `taskmoor_search`, a text search configuration: English stemming (the site's language; the
 *   only one the product ships) without stop words, so "the", "not" and "it" are searchable
 *   and a phrase keeps every word. Changing the language later means altering this
 *   configuration and rewriting the columns below (ADR-065).
 * - `taskmoor_document_text(jsonb)`: the text of a rich-text document (ADR-014), the text nodes
 *   of each block joined as written (marks split a word into several nodes) and blocks and hard
 *   breaks apart; null for a document without text.
 * - Stored word columns, written by Postgres with every write of their source, so a ticket is
 *   findable as soon as its transaction commits (QRY-007 (3)): `ticket.summary_words`,
 *   `description_words`, `environment_words` and `ticket_comment.body_words`. A document's
 *   first 200,000 characters are indexed (a tsvector holds at most 1 MB). Each has a GIN index
 *   over rows outside the trash.
 * - Custom text values are short (`v_text`, a paragraph's first 255 characters): a GIN index on
 *   their words as an expression.
 * - `pg_trgm` (a trusted extension since PostgreSQL 13: the database's owner creates it) with
 *   trigram indexes on summaries and custom text values, for patterns (`*Exception`).
 *
 * Adding the stored columns rewrites `ticket` and `ticket_comment` once; no release holds
 * enough tickets for that to matter.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
  await sql`
    CREATE TEXT SEARCH DICTIONARY taskmoor_stem (TEMPLATE = snowball, Language = english)`.execute(
    db,
  );
  await sql`CREATE TEXT SEARCH CONFIGURATION taskmoor_search (COPY = pg_catalog.english)`.execute(
    db,
  );
  await sql`
    ALTER TEXT SEARCH CONFIGURATION taskmoor_search
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
      WITH taskmoor_stem`.execute(db);
  await sql`
    CREATE FUNCTION taskmoor_document_text(doc jsonb) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      WITH RECURSIVE node (value, path, parent) AS (
        SELECT doc, ARRAY[]::int[], NULL::int[]
        UNION ALL
        SELECT c.value, n.path || c.ord::int, n.path
          FROM node n,
               jsonb_array_elements(CASE jsonb_typeof(n.value -> 'content')
                 WHEN 'array' THEN n.value -> 'content' ELSE '[]'::jsonb END)
                 WITH ORDINALITY AS c (value, ord)
      )
      SELECT string_agg(block, ' ' ORDER BY parent)
        FROM (SELECT parent,
                     string_agg(CASE WHEN value ->> 'type' = 'text' THEN value ->> 'text' ELSE ' ' END,
                                '' ORDER BY path) AS block
                FROM node
               WHERE value ->> 'type' IN ('text', 'hardBreak')
               GROUP BY parent) b
    $$`.execute(db);
  const words = (column: string) =>
    sql.raw(
      `tsvector GENERATED ALWAYS AS (to_tsvector('taskmoor_search'::regconfig, left(taskmoor_document_text(${column}), 200000))) STORED`,
    );
  await sql`
    ALTER TABLE ticket
      ADD COLUMN summary_words tsvector
        GENERATED ALWAYS AS (to_tsvector('taskmoor_search'::regconfig, summary)) STORED,
      ADD COLUMN description_words ${words('description')},
      ADD COLUMN environment_words ${words('environment')}`.execute(db);
  await sql`ALTER TABLE ticket_comment ADD COLUMN body_words ${words('body')}`.execute(db);
  for (const index of [
    'ticket_summary_words_idx',
    'ticket_description_words_idx',
    'ticket_environment_words_idx',
    'ticket_comment_words_idx',
  ]) {
    await sql`DROP INDEX ${sql.raw(index)}`.execute(db);
  }
  for (const column of ['summary', 'description', 'environment']) {
    await sql`
      CREATE INDEX ${sql.raw(`ticket_${column}_words_idx`)} ON ticket
        USING gin (${sql.raw(`${column}_words`)}) WHERE deleted_at IS NULL`.execute(db);
  }
  await sql`
    CREATE INDEX ticket_comment_words_idx ON ticket_comment USING gin (body_words)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX v_text_words_idx ON v_text
      USING gin (to_tsvector('taskmoor_search'::regconfig, value))`.execute(db);
  await sql`
    CREATE INDEX ticket_summary_trigram_idx ON ticket USING gin (summary gin_trgm_ops)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX v_text_trigram_idx ON v_text USING gin (value gin_trgm_ops)`.execute(db);
}
