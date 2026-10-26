import { type Kysely, sql } from 'kysely';

/**
 * Tickets (M1-008; CORE-001, CORE-008, CORE-023, CORE-025, AGL-009; spec 01a sections 1.2 and
 * 1.3; ADR-009, ADR-037).
 *
 * - `ticket`: a ticket's identity (track, number, type, parent), its content and people
 *   fields, its dates and its place in the global rank. `version` counts changes for
 *   optimistic saves. Statuses, priorities, labels, releases, areas and custom fields arrive
 *   with their own tasks (M1-010 onwards) as columns or side tables of their own.
 * - `ticket_counter`: the last number given out per track, so a key is KEY-n with n counting
 *   up per track. Taking a number locks the track's counter row until the transaction ends,
 *   so concurrent creates in one track get consecutive numbers and never the same one.
 * - `ticket_key_history`: every track and number a ticket has had, the current one with
 *   `replaced_at` null. A trigger on `ticket` writes it whichever path changes the ticket. A
 *   number belongs to one ticket in its track for good, so an old key keeps resolving after a
 *   move (CORE-023 (3)); old track keys resolve through `track_key_history`.
 * - `rank` is a fractional key in the "C" collation, unique per workspace (AGL-009). New
 *   tickets take the next value of `ticket_rank_seq` as their key, so creates never wait for
 *   each other to find the bottom of the order.
 * - The trash (CORE-025 (3)): a deleted ticket keeps its row with `deleted_at` and
 *   `deleted_by`; its subtickets go with it (`trashed_with` names the ticket whose deletion
 *   took them along). Children above the subticket level lose the link to a deleted parent;
 *   `ticket_detached_parent` remembers it so a restore puts it back.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE ticket_rank_seq AS bigint`.execute(db);

  await sql`
    CREATE TABLE ticket (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id),
      number integer NOT NULL CHECK (number > 0),
      ticket_type_id integer NOT NULL REFERENCES ticket_type (id),
      parent_id integer REFERENCES ticket (id),
      summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 255),
      description jsonb,
      environment jsonb,
      assignee_id integer REFERENCES app_user (id),
      requester_id integer REFERENCES app_user (id),
      creator_id integer REFERENCES app_user (id),
      start_date date,
      due_date date,
      rank text COLLATE "C" NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer REFERENCES app_user (id),
      trashed_with integer REFERENCES ticket (id),
      CONSTRAINT ticket_parent_self_check CHECK (parent_id <> id),
      CONSTRAINT ticket_deleted_by_check CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL),
      CONSTRAINT ticket_trashed_with_check CHECK (trashed_with IS NULL OR deleted_at IS NOT NULL)
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_track_number_key ON ticket (track_id, number)`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_rank_key ON ticket (workspace_id, rank)`.execute(db);
  // A track's live tickets in rank order: backlogs and lists.
  await sql`CREATE INDEX ticket_track_rank_idx ON ticket (track_id, rank) WHERE deleted_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_parent_idx ON ticket (parent_id) WHERE parent_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_type_idx ON ticket (ticket_type_id)`.execute(db);
  await sql`CREATE INDEX ticket_assignee_idx ON ticket (assignee_id) WHERE assignee_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_trash_idx ON ticket (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_trashed_with_idx ON ticket (trashed_with) WHERE trashed_with IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE ticket_counter (
      track_id integer PRIMARY KEY REFERENCES track (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      last_number integer NOT NULL CHECK (last_number >= 0)
    )`.execute(db);

  await sql`
    CREATE TABLE ticket_key_history (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      track_id integer NOT NULL REFERENCES track (id),
      number integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      replaced_at timestamptz
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_key_history_key ON ticket_key_history (track_id, number)`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX ticket_key_history_current_idx ON ticket_key_history (ticket_id) WHERE replaced_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_key_history_ticket_idx ON ticket_key_history (ticket_id)`.execute(
    db,
  );
  // A new track or number retires the current one. A number another ticket had in that track
  // fails the unique index, which aborts the statement that wrote the ticket.
  await sql`
    CREATE FUNCTION ticket_key_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.track_id = OLD.track_id AND NEW.number = OLD.number THEN
          RETURN NULL;
        END IF;
        UPDATE ticket_key_history SET replaced_at = clock_timestamp()
         WHERE ticket_id = OLD.id AND replaced_at IS NULL;
      END IF;
      UPDATE ticket_key_history SET replaced_at = NULL
       WHERE ticket_id = NEW.id AND track_id = NEW.track_id AND number = NEW.number;
      IF NOT FOUND THEN
        INSERT INTO ticket_key_history (workspace_id, ticket_id, track_id, number)
        VALUES (NEW.workspace_id, NEW.id, NEW.track_id, NEW.number);
      END IF;
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER ticket_key_history_record
    AFTER INSERT OR UPDATE OF track_id, number ON ticket
    FOR EACH ROW EXECUTE FUNCTION ticket_key_record()`.execute(db);

  await sql`
    CREATE TABLE ticket_detached_parent (
      ticket_id integer PRIMARY KEY REFERENCES ticket (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      parent_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      detached_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX ticket_detached_parent_parent_idx ON ticket_detached_parent (parent_id)`.execute(
    db,
  );
}
