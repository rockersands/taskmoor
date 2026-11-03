import { type RawBuilder, sql } from 'kysely';

export interface ChildProgressRow {
  parent_id: number;
  total: number;
  closed: number;
}

/**
 * How far along the tickets under some tickets are (ADR-120): for each parent with any, its
 * direct children the person may see, and those of them in a status of the closed stage. The one
 * definition of done for progress, read by subtickets on the ticket page, cards and lists, by the
 * backlog's outcome panel and by a track's Outcomes section (AGL-024).
 *
 * `filter` is the person's ticket filter, written on `k` as search writes it (QRY-008), so a
 * ticket they may not see counts for nothing. `parents` is a list of ticket ids, or a statement
 * that gives them, so a caller can count in the same statement that lists the parents.
 */
export function childProgress(
  workspaceId: number,
  parents: readonly number[] | RawBuilder<unknown>,
  filter: RawBuilder<boolean>,
): RawBuilder<ChildProgressRow> {
  const under = Array.isArray(parents)
    ? sql`k.parent_id = ANY(${parents}::int[])`
    : sql`k.parent_id IN (${parents})`;
  return sql<ChildProgressRow>`
    SELECT k.parent_id, count(*)::int AS total,
           count(*) FILTER (WHERE st.stage = 'closed')::int AS closed
      FROM ticket k
      JOIN status st ON st.id = k.status_id
     WHERE k.workspace_id = ${workspaceId}::int AND k.deleted_at IS NULL AND ${under}
       AND ${filter}
     GROUP BY k.parent_id`;
}
