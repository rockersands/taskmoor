import { type Kysely, sql } from 'kysely';

/**
 * Embeddings for similar tickets and duplicate suggestions (M1-078; AI-012, AI-016, NFR-011;
 * ADR-106): one vector per ticket (its summary and description) and per comment, made by the
 * bundled local model unless an external endpoint is configured.
 *
 * - `model` names what made the vector (`local:all-MiniLM-L6-v2`): a vector of another model is
 *   stale and is computed again.
 * - `source_hash` is the MD5 of the text that was embedded (`taskmoor_embedding_text`), so a
 *   write that leaves the text alone is not embedded again.
 * - `embedding` is a plain `real[]` unit vector, the same column with or without the pgvector
 *   extension. Where pgvector is installed, the server adds an HNSW index over
 *   `embedding::vector(n)` at start (ADR-106); that index is outside the migrations, so the
 *   schema is one whatever the server offers, and without it lookups scan exactly.
 * - Rows go with their ticket or comment (cascades); a trashed ticket's and a deleted comment's
 *   rows are removed by the indexer, and lookups skip both anyway.
 *
 * `taskmoor_embedding_text(summary, document)` is the text a vector is made from: the summary,
 * a line break and the document's text, at most 2,000 characters (the model reads 256 tokens,
 * about 1,000 to 1,500 characters of English).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION taskmoor_embedding_text(head text, doc jsonb) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT left(btrim(coalesce(head, '') || coalesce(E'\n' || taskmoor_document_text(doc), '')),
                  2000)
    $$`.execute(db);

  await sql`
    CREATE TABLE ticket_embedding (
      ticket_id integer PRIMARY KEY REFERENCES ticket (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
      source_hash text NOT NULL CHECK (char_length(source_hash) = 32),
      embedding real[] NOT NULL CHECK (cardinality(embedding) BETWEEN 1 AND 4096),
      embedded_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE INDEX ticket_embedding_workspace_idx ON ticket_embedding (workspace_id, model)`.execute(
    db,
  );

  await sql`
    CREATE TABLE comment_embedding (
      comment_id integer PRIMARY KEY REFERENCES ticket_comment (id) ON DELETE CASCADE,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
      source_hash text NOT NULL CHECK (char_length(source_hash) = 32),
      embedding real[] NOT NULL CHECK (cardinality(embedding) BETWEEN 1 AND 4096),
      embedded_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX comment_embedding_ticket_idx ON comment_embedding (ticket_id)`.execute(db);
  await sql`
    CREATE INDEX comment_embedding_workspace_idx ON comment_embedding (workspace_id, model)`.execute(
    db,
  );
}
