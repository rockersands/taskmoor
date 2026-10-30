import { type Kysely, sql } from 'kysely';

/**
 * Clone and deep clone (M1-124; CORE-023; ADR-077). A clone runs as a bulk operation of its
 * own action, `clone`: one item per ticket to copy, parents before their children, each made
 * through the ticket create route as the person who asked.
 *
 * - `bulk_item.result_ticket_id`: the ticket an item made (the copy). A child's copy finds its
 *   parent's copy here, and an item cut short after its copy was made goes on from it instead
 *   of making a second one. No foreign key, as for `ticket_id`: a purged copy keeps the result.
 * - `bulk_item.result`: what a finished item made, shown with its outcome (for a clone, the
 *   copy's key, what was copied with it and the values left out).
 * - `bulk_item_ticket_idx`: an item by the ticket it names, for that parent lookup.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bulk_operation DROP CONSTRAINT bulk_operation_action_check`.execute(db);
  await sql`
    ALTER TABLE bulk_operation ADD CONSTRAINT bulk_operation_action_check
      CHECK (action IN ('edit', 'move', 'transition', 'delete', 'clone'))`.execute(db);
  await sql`
    ALTER TABLE bulk_item
      ADD COLUMN result_ticket_id integer,
      ADD COLUMN result jsonb`.execute(db);
  await sql`CREATE INDEX bulk_item_ticket_idx ON bulk_item (operation_id, ticket_id)`.execute(db);
}
