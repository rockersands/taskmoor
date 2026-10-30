import { type Kysely, sql } from 'kysely';
import { TICKET_CHANGE_PARTITIONS } from './0015_ticket_history';

/**
 * History search (M1-039; QRY-005; ADR-010 "History operators (M1-039)"): five indexes on
 * `ticket_change` for WAS and CHANGED on every field. No new table: the change history of
 * M1-009 already holds every value a ticket starts with and every change after.
 *
 * - `ticket_change_to_idx` and `ticket_change_from_idx`: a field's rows by the value a change
 *   brought or took away, then time, so a rare value (`status WAS Cancelled`, `CHANGED FROM x`)
 *   starts from its few rows instead of every ticket, and `CHANGED TO Done AFTER -7d` reads only
 *   the week's. Values are indexed as their first 200 characters: rich text and long lists can
 *   exceed what an index entry holds, and the values a query names there (ids, numbers, days,
 *   instants, keys) are shorter, so `left(value, 200) = $1` is exact.
 * - `ticket_change_to_name_idx`: a field's rows by the name the value they brought had then
 *   (lower case), so a value renamed since is found by its old name (QRY-005 (2)) without
 *   reading every row of the field.
 * - `ticket_change_field_at_idx`: a field's rows by time (`CHANGED AFTER -7d`).
 * - `ticket_change_ticket_field_idx`: one ticket's rows of one field in time order, for the
 *   probe per ticket and for "the next change of the field after this one", which ends the
 *   stretch a value was held (WAS ... AFTER, DURING, ON), cheaply also on a ticket with tens
 *   of thousands of changes (QRY-005 (3)).
 * - "Changed by" uses `ticket_change_actor_idx` (0015).
 *
 * On a large existing history these take a while to build (one pass per index); the upgrade
 * runs them in its migration step like any other.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // By the name each partition's own index takes (`ticket_change_p03_to_idx`). Inside `up`, so
  // the test template's fingerprint (`up.toString()`) changes with the list.
  const indexes: readonly [name: string, columns: string][] = [
    ['to_idx', 'field, left(to_value, 200), at'],
    ['from_idx', 'field, left(from_value, 200), at'],
    ['to_name_idx', 'field, lower(left(to_display, 200)), at'],
    ['field_at_idx', 'field, at'],
    ['ticket_field_idx', 'ticket_id, field, at, id'],
  ];
  for (const [name, columns] of indexes) {
    // On the parent only, then one per partition attached to it, so plans name each partition's
    // index plainly (Postgres would name them after their columns, the two value ones alike).
    await sql`CREATE INDEX ${sql.raw(`ticket_change_${name}`)} ON ONLY ticket_change (${sql.raw(columns)})`.execute(
      db,
    );
    for (let i = 0; i < TICKET_CHANGE_PARTITIONS; i++) {
      const partition = `ticket_change_p${String(i).padStart(2, '0')}`;
      await sql`CREATE INDEX ${sql.raw(`${partition}_${name}`)} ON ${sql.raw(partition)} (${sql.raw(columns)})`.execute(
        db,
      );
      await sql`ALTER INDEX ${sql.raw(`ticket_change_${name}`)} ATTACH PARTITION ${sql.raw(`${partition}_${name}`)}`.execute(
        db,
      );
    }
  }
}
