import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';

/**
 * Teams (M1-123; CORE-027; ADR-076): lookups the routes, the search binder and the importers
 * share. The routes are in `routes/teams.ts`.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** The team's id and name, or undefined when the workspace has no such team. */
export function findTeam(db: Db, workspaceId: number, id: number) {
  return db
    .selectFrom('team')
    .select(['id', 'name'])
    .where('id', '=', id)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
}

/** The people in a team, by id (CORE-027 (1): what `membersOf("id:<teamId>")` returns). */
export async function teamMemberIds(db: Db, workspaceId: number, teamId: number) {
  const rows = await db
    .selectFrom('team_member')
    .select('user_id')
    .where('team_id', '=', teamId)
    .where('workspace_id', '=', workspaceId)
    .orderBy('user_id')
    .execute();
  return rows.map((r) => r.user_id);
}
