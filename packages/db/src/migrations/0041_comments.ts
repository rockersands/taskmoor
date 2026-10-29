import { type Kysely, sql } from 'kysely';

/**
 * Comments (M1-018; CORE-020, CORE-022, NTF-001 (3); ADR-044).
 *
 * - `ticket_comment`: a rich-text comment on a ticket (a document of the shared schema, the
 *   same as a description), its author, and an optional visibility to one role in the
 *   ticket's track or one group. `version` counts the comment's states: 1 when written, one
 *   more for every edit of its text or visibility; `edited_at`/`edited_by` mark the last edit.
 *   Deleting is soft (`deleted_at`/`deleted_by`): the row and its restriction stay, so history
 *   rows that name it stay restricted and administrators keep the text, until the ticket is
 *   purged. Comments leave with their ticket.
 * - The visibility columns carry no foreign key on purpose: when a role or group goes (a
 *   directory sync deletes groups), a comment restricted to it must stay restricted. It then
 *   fails closed, visible to its author only, and the deletion is never blocked by it.
 * - `ticket_comment_version`: every earlier state of a comment, kept when it is edited (text and
 *   visibility as they were, who wrote that state and when, who replaced it and when).
 * - `ticket_comment_reaction`: one row per person, emoji and comment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ticket_comment (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      author_id integer REFERENCES app_user (id),
      body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
      visible_role_id integer,
      visible_group_id integer,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      edited_at timestamptz,
      edited_by integer REFERENCES app_user (id),
      deleted_at timestamptz,
      deleted_by integer REFERENCES app_user (id),
      CONSTRAINT ticket_comment_one_audience
        CHECK (visible_role_id IS NULL OR visible_group_id IS NULL)
    )`.execute(db);
  await sql`CREATE INDEX ticket_comment_ticket_idx ON ticket_comment (ticket_id, id)`.execute(db);
  await sql`CREATE INDEX ticket_comment_author_idx ON ticket_comment (author_id, created_at)`.execute(
    db,
  );

  await sql`
    CREATE TABLE ticket_comment_version (
      comment_id integer NOT NULL REFERENCES ticket_comment (id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version >= 1),
      workspace_id integer NOT NULL REFERENCES workspace (id),
      body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
      visible_role_id integer,
      visible_group_id integer,
      written_by integer REFERENCES app_user (id),
      written_at timestamptz NOT NULL,
      replaced_by integer REFERENCES app_user (id),
      replaced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, version),
      CONSTRAINT ticket_comment_version_one_audience
        CHECK (visible_role_id IS NULL OR visible_group_id IS NULL)
    )`.execute(db);

  await sql`
    CREATE TABLE ticket_comment_reaction (
      comment_id integer NOT NULL REFERENCES ticket_comment (id) ON DELETE CASCADE,
      emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
      user_id integer NOT NULL REFERENCES app_user (id),
      workspace_id integer NOT NULL REFERENCES workspace (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, emoji, user_id)
    )`.execute(db);
  await sql`CREATE INDEX ticket_comment_reaction_user_idx ON ticket_comment_reaction (user_id)`.execute(
    db,
  );
}
