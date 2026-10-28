import { type Kysely, sql } from 'kysely';

/**
 * Ticket change history (M1-009; CORE-022; ADR-009 implementation note).
 *
 * - `ticket_change`: one row per field a mutation changed, with the actor, the time, the old
 *   and new value as text (ids for references) and the names they had then, so the history
 *   reads right after a person, a type or a track is renamed. Rows that one mutation wrote
 *   share a `change_set`. Creating a ticket writes a row for every value it starts with, so a
 *   query for what a field "was" sees the first value too (ADR-010).
 * - Partitioned by hash of the ticket into 16 partitions: a ticket's history lives in one
 *   partition and is read through the primary key (ticket, id) newest first, so a page costs
 *   the same with 20 or 20,000 changes. History is never truncated or aged out (CORE-022 (3));
 *   it goes only with the ticket when the trash purge (M1-101) removes it.
 */
export const TICKET_CHANGE_PARTITIONS = 16;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE ticket_change_set_seq AS bigint`.execute(db);
  await sql`
    CREATE TABLE ticket_change (
      id bigint GENERATED ALWAYS AS IDENTITY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      change_set bigint NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      actor_id integer REFERENCES app_user (id),
      field text NOT NULL,
      from_value text,
      to_value text,
      from_display text,
      to_display text,
      PRIMARY KEY (ticket_id, id)
    ) PARTITION BY HASH (ticket_id)`.execute(db);
  for (let i = 0; i < TICKET_CHANGE_PARTITIONS; i++) {
    await sql`
      CREATE TABLE ${sql.raw(`ticket_change_p${String(i).padStart(2, '0')}`)}
        PARTITION OF ticket_change
        FOR VALUES WITH (MODULUS ${sql.lit(TICKET_CHANGE_PARTITIONS)}, REMAINDER ${sql.lit(i)})`.execute(
      db,
    );
  }
  // "Changed by" in queries and a person's activity.
  await sql`CREATE INDEX ticket_change_actor_idx ON ticket_change (actor_id, at) WHERE actor_id IS NOT NULL`.execute(
    db,
  );
}
