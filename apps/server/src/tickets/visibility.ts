import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import { rewriteTickets } from './fields';

type Db = Kysely<Database> | Transaction<Database>;

/** The visibility levels a track offers and the one new and moved tickets take (M1-020). */
export interface TrackVisibility {
  policyId: number | null;
  defaultLevelId: number | null;
  levelIds: ReadonlySet<number>;
}

export async function trackVisibility(
  db: Db,
  workspaceId: number,
  trackId: number,
): Promise<TrackVisibility> {
  const rows = await db
    .selectFrom('track as t')
    .leftJoin('visibility_policy as p', 'p.id', 't.visibility_policy_id')
    .leftJoin('visibility_level as l', 'l.policy_id', 'p.id')
    .select(['p.id as policy_id', 'p.default_level_id', 'l.id as level_id'])
    .where('t.id', '=', trackId)
    .where('t.workspace_id', '=', workspaceId)
    .execute();
  const first = rows[0];
  return {
    policyId: first?.policy_id ?? null,
    defaultLevelId: first?.default_level_id ?? null,
    levelIds: new Set(rows.flatMap((r) => (r.level_id === null ? [] : [r.level_id]))),
  };
}

/**
 * The level a ticket takes in a track: the one asked for (null for none) when the track's
 * policy has it, else the policy's default. 'not_in_track' for a level the track lacks.
 */
export function levelFor(
  visibility: TrackVisibility,
  asked: number | null | undefined,
): number | null | 'not_in_track' {
  if (asked === undefined) return visibility.defaultLevelId;
  if (asked === null) return null;
  return visibility.levelIds.has(asked) ? asked : 'not_in_track';
}

/**
 * Gives tickets another level (a level deleted, a track's policy changed), as one change set
 * in their history. Returns how many tickets changed.
 */
export async function setLevels(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  ticketIds: readonly number[],
  levelId: number | null,
): Promise<number> {
  if (ticketIds.length === 0) return 0;
  return rewriteTickets(trx, workspaceId, actorId, ticketIds, async (ids) => {
    await trx
      .updateTable('ticket')
      .set({ visibility_level_id: levelId })
      .where('id', 'in', ids)
      .execute();
  });
}
