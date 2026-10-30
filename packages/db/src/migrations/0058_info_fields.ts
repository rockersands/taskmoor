import { type Kysely, sql } from 'kysely';

/**
 * Read-only info fields (M1-125; CORE-012; ADR-009). Two times on each ticket, kept by Postgres
 * from its comments, so a query can filter and order by them like any ticket column:
 *
 * - `last_comment_at`: when the latest comment was written;
 * - `first_response_at`: when the first comment by someone other than the requester was
 *   written (the requester's own comments are not a response).
 *
 * Only comments everyone who can see the ticket may read count: a comment restricted to a role
 * or a group, or in the trash, does not, so neither time tells anyone that a comment they cannot
 * read exists. `ticket_info_times(ticket)` recomputes both; a trigger on `ticket_comment` calls
 * it for every comment written, edited in its visibility, moved, trashed or deleted, and one on
 * `ticket` recomputes the first response when the requester changes. The importer and direct
 * SQL keep them right too.
 *
 * Time in status and participants are read when asked for (`tickets/info.ts`): the change
 * history holds every status interval, and participants are the requester, the assignee and
 * the people who wrote a counted comment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ticket
      ADD COLUMN first_response_at timestamptz,
      ADD COLUMN last_comment_at timestamptz`.execute(db);

  await sql`
    CREATE FUNCTION ticket_info_times(t_id integer) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE
      requester integer;
      first_at timestamptz;
      last_at timestamptz;
    BEGIN
      SELECT requester_id INTO requester FROM ticket WHERE id = t_id;
      IF NOT FOUND THEN
        RETURN;
      END IF;
      SELECT max(c.created_at),
             min(c.created_at) FILTER (WHERE c.author_id IS DISTINCT FROM requester)
        INTO last_at, first_at
        FROM ticket_comment c
       WHERE c.ticket_id = t_id AND c.deleted_at IS NULL
         AND c.visible_role_id IS NULL AND c.visible_group_id IS NULL;
      UPDATE ticket SET first_response_at = first_at, last_comment_at = last_at
       WHERE id = t_id
         AND (first_response_at IS DISTINCT FROM first_at
              OR last_comment_at IS DISTINCT FROM last_at);
    END $$`.execute(db);

  await sql`
    CREATE FUNCTION ticket_comment_info_times() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        PERFORM ticket_info_times(OLD.ticket_id);
      END IF;
      IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.ticket_id <> OLD.ticket_id) THEN
        PERFORM ticket_info_times(NEW.ticket_id);
      END IF;
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER ticket_comment_info_times
      AFTER INSERT OR DELETE OR UPDATE OF ticket_id, deleted_at, visible_role_id, visible_group_id
      ON ticket_comment FOR EACH ROW EXECUTE FUNCTION ticket_comment_info_times()`.execute(db);

  await sql`
    CREATE FUNCTION ticket_requester_first_response() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.first_response_at := (
        SELECT min(c.created_at) FROM ticket_comment c
         WHERE c.ticket_id = NEW.id AND c.deleted_at IS NULL
           AND c.visible_role_id IS NULL AND c.visible_group_id IS NULL
           AND c.author_id IS DISTINCT FROM NEW.requester_id);
      RETURN NEW;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER ticket_requester_first_response
      BEFORE UPDATE OF requester_id ON ticket FOR EACH ROW
      WHEN (OLD.requester_id IS DISTINCT FROM NEW.requester_id)
      EXECUTE FUNCTION ticket_requester_first_response()`.execute(db);

  // Tickets that already have comments.
  await sql`
    UPDATE ticket t SET first_response_at = c.first_at, last_comment_at = c.last_at
      FROM (
        SELECT c.ticket_id, max(c.created_at) AS last_at,
               min(c.created_at) FILTER (WHERE c.author_id IS DISTINCT FROM t2.requester_id)
                 AS first_at
          FROM ticket_comment c JOIN ticket t2 ON t2.id = c.ticket_id
         WHERE c.deleted_at IS NULL AND c.visible_role_id IS NULL AND c.visible_group_id IS NULL
         GROUP BY c.ticket_id
      ) c
     WHERE t.id = c.ticket_id`.execute(db);

  // Ordered newest first, like `created` and `closed` (0043).
  await sql`CREATE INDEX ticket_last_comment_idx ON ticket (last_comment_at DESC, id DESC)`.execute(
    db,
  );
  await sql`
    CREATE INDEX ticket_first_response_idx ON ticket (first_response_at DESC, id DESC)`.execute(db);
}
