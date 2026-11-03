import type { Database } from '@taskmoor/db';
import { parseQuery } from '@taskmoor/query';
import type { Kysely } from 'kysely';

/**
 * A board belongs to one track and shows only that track (ADR-116). The key a query is confined
 * to: `track = KEY`, alone or as one of the conditions joined by AND. Null when the query could
 * reach another track, or cannot be read.
 */
export function confinedTrackKey(query: string): string | null {
  let where: ReturnType<typeof parseQuery>['where'];
  try {
    where = parseQuery(query).where;
  } catch {
    return null;
  }
  if (where === null) return null;
  const items = where.kind === 'and' ? where.items : [where];
  for (const item of items) {
    if (item.kind !== 'compare' || item.op !== '=' || item.field.custom !== undefined) continue;
    if (item.field.name.toLowerCase() !== 'track') continue;
    const { value } = item;
    if ((value.kind === 'word' || value.kind === 'string') && typeof value.value === 'string') {
      return value.value;
    }
  }
  return null;
}

/** The query of a track's board. Quoted, so a key that is a word of the grammar stays a key. */
export const trackBoardQuery = (key: string) => `track = ${JSON.stringify(key)}`;

/**
 * The boards a saved search carries that this query would take out of their track (ADR-116): a
 * track's board shows only that track, so a saved search under one has to stay confined to it.
 * Boards an upgrade left kept by a person have no track to leave.
 */
export async function boardsLeftByQuery(
  db: Kysely<Database>,
  workspaceId: number,
  savedSearchId: number,
  query: string,
): Promise<{ id: number; name: string; trackKey: string }[]> {
  const boards = await db
    .selectFrom('board as b')
    .innerJoin('track as t', 't.id', 'b.location_track_id')
    .select(['b.id', 'b.name', 't.key as trackKey'])
    .where('b.workspace_id', '=', workspaceId)
    .where('b.saved_search_id', '=', savedSearchId)
    .orderBy('b.id')
    .execute();
  const confined = confinedTrackKey(query)?.toLowerCase();
  return boards.filter((b) => b.trackKey.toLowerCase() !== confined);
}
