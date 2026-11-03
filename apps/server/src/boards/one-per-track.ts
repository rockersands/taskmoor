import { parseQuery } from '@taskmoor/query';

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
