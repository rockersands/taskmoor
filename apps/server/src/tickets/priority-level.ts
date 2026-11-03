import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';

/**
 * Which of the six priority icons a priority shows, from its place in the workspace's order and
 * not its name, so a renamed or added priority still reads sensibly (M1-014, CORE-014): the list,
 * however long, is stretched over levels 1 (the top) to 6 (the bottom). The first is always 1 and
 * the last always 6; a list of one sits in the middle, at 4.
 *
 * The seeded five read 1, 2, 4, 5, 6; four would read 1, 3, 4, 6; six use each once; more share.
 */
export function priorityLevel(order: number, total: number): number {
  if (total <= 1) return 4;
  const at = Math.min(Math.max(order - 1, 0), total - 1);
  return 1 + Math.round((at * 5) / (total - 1));
}

/**
 * Every priority's level in one small statement, for a list that reads priorities in its own
 * query: a lookup per row afterwards, not a query per row.
 */
export async function priorityLevels(
  db: Kysely<Database> | Transaction<Database>,
  workspaceId: number,
): Promise<ReadonlyMap<number, number>> {
  const rows = await db
    .selectFrom('priority')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .orderBy('sort_order')
    .execute();
  return new Map(rows.map((r, i) => [r.id, priorityLevel(i + 1, rows.length)]));
}
