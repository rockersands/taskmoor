import type { Database } from '@taskmoor/db';
import {
  IMPORTED_LINK_KINDS,
  type ImportedLinkKind,
  importedTargetRoute,
} from '@taskmoor/webconfig';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { savedSearchVisible } from '../search/saved';
import { visibleBoardRecord } from './boards';
import { dashboardVisible } from './dashboards';

/**
 * Links from the tracker an import came from (M1-128; IMP-011; ADR-097): a saved filter, board or
 * dashboard named by the source's id, mapped through the import's external ids to the object it
 * became. `GET /api/v1/imported-links/:kind/:sourceId` (kinds `saved-search`, `board`,
 * `dashboard`) answers the target's id and the app's route for it, to a signed-in person who may
 * see it; anyone else, and a source id no import mapped, gets the same 404, so a link never
 * confirms that a hidden object exists. When several imports (several `system` names) mapped the
 * same source id, the most recently written mapping wins. Ticket keys need no lookup: tickets
 * keep their keys, and earlier keys still open them (`resolveTicket`).
 */
const ENTITY: Readonly<Record<ImportedLinkKind, string>> = {
  'saved-search': 'saved_search',
  board: 'board',
  dashboard: 'dashboard',
};

const params = z
  .object({
    kind: z.enum(IMPORTED_LINK_KINDS),
    sourceId: z.string().regex(/^\d{1,18}$/),
  })
  .strict();

/** The newest target an import mapped the source id of a kind to; null when none did. */
export async function importedTarget(
  db: Kysely<Database>,
  workspaceId: number,
  entityKind: string,
  sourceId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom('import_external_id')
    .select('target_id')
    .where('workspace_id', '=', workspaceId)
    .where('entity_kind', '=', entityKind)
    .where('source_id', '=', sourceId)
    .orderBy('updated_at', 'desc')
    .orderBy('target_id', 'desc')
    .executeTakeFirst();
  const id = row ? Number(row.target_id) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function sees(
  db: Kysely<Database>,
  request: FastifyRequest,
  kind: ImportedLinkKind,
  id: number,
): Promise<boolean> {
  const ws = request.workspaceId;
  const userId = request.user?.id ?? null;
  const admin = userId !== null && (await request.authz.isSiteAdmin());
  switch (kind) {
    case 'saved-search': {
      let q = db
        .selectFrom('saved_search as s')
        .select('s.id')
        .where('s.workspace_id', '=', ws)
        .where('s.id', '=', id);
      if (!admin) q = q.where(savedSearchVisible(ws, userId));
      return (await q.executeTakeFirst()) !== undefined;
    }
    case 'dashboard': {
      let q = db
        .selectFrom('dashboard as d')
        .select('d.id')
        .where('d.workspace_id', '=', ws)
        .where('d.id', '=', id);
      if (!admin) q = q.where(dashboardVisible(ws, userId));
      return (await q.executeTakeFirst()) !== undefined;
    }
    case 'board':
      return (await visibleBoardRecord(db, request, id)) !== null;
  }
}

export function registerImportedLinkRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/imported-links/:kind/:sourceId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const { kind, sourceId } = parsed.data;
    const target = await importedTarget(db, request.workspaceId, ENTITY[kind], sourceId);
    if (target === null || !(await sees(db, request, kind, target))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { kind, sourceId, targetId: target, route: importedTargetRoute(kind, target) };
  });
}
