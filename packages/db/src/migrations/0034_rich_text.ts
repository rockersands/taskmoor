import { type Kysely, sql } from 'kysely';

/**
 * Rich text (M1-017; NTF-007, NTF-008, IMP-008; ADR-014 "Implementation (M1-017)").
 *
 * - `ticket_text_original`: the document a ticket's description or environment was last
 *   written as in another format (the Jira-compatible document format through the API or the
 *   importer; `wiki` is kept for M1-071), exactly as it came, with the SHA-256 of the canonical
 *   document converted from it. The ticket keeps the converted document; the original stays
 *   when the text is edited later, and the hash says whether it still matches.
 * - `ticket_text_state`: the collaboration state of a field (a Yjs update holding the whole
 *   document), with the SHA-256 of the document it holds. When the ticket's text no longer
 *   matches that hash (it was written another way), the state is stale and is rebuilt.
 *
 * Both leave with their ticket.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ticket_text_original (
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field text NOT NULL CHECK (field IN ('description', 'environment')),
      format text NOT NULL CHECK (format IN ('adf', 'wiki')),
      source jsonb NOT NULL,
      doc_sha256 text NOT NULL CHECK (doc_sha256 ~ '^[0-9a-f]{64}$'),
      written_by integer REFERENCES app_user (id),
      written_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticket_id, field)
    )`.execute(db);

  await sql`
    CREATE TABLE ticket_text_state (
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field text NOT NULL CHECK (field IN ('description', 'environment')),
      state bytea NOT NULL,
      doc_sha256 text NOT NULL CHECK (doc_sha256 ~ '^[0-9a-f]{64}$'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticket_id, field)
    )`.execute(db);
}
