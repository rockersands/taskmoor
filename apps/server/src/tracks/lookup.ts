import type { Database } from '@taskmoor/db';
import type { FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';

const MAX_INT = 2_147_483_647;

/** A track named in a path by id or key, as the track views take it (M1-048, M1-049). */
export const trackParam = z
  .object({
    id: z.union([
      z.coerce.number().int().positive().max(MAX_INT),
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/),
    ]),
  })
  .strict();

/**
 * The track the caller may browse, by id or key (any case), outside the trash; null when there
 * is none or the caller may not see it, which the views answer as 404 alike.
 */
export async function visibleTrack(
  db: Kysely<Database>,
  request: FastifyRequest,
  idOrKey: number | string,
): Promise<{ id: number; key: string; name: string } | null> {
  let lookup = db
    .selectFrom('track')
    .select(['id', 'key', 'name'])
    .where('workspace_id', '=', request.workspaceId)
    .where('deleted_at', 'is', null);
  lookup =
    typeof idOrKey === 'number'
      ? lookup.where('id', '=', idOrKey)
      : lookup.where(sql<boolean>`upper(key) = upper(${idOrKey})`);
  const track = await lookup.executeTakeFirst();
  if (!track) return null;
  const held = await request.authz.track(track.id);
  return held.has('browse_track') || held.has('administer_track') ? track : null;
}
