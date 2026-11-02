import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AttachmentStores } from '../attachments/stores';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import { zipSink } from '../export/sinks';
import { exportWorkspace } from '../export/write';
import type { FieldCatalogs } from '../fields/catalog';
import { countBulkExport } from '../security/alerts';

/**
 * The full export (M1-098; IMP-014): `GET /api/v1/admin/export` streams the workspace as
 * Taskmoor's export format in a ZIP (`docs/export-format.md`), at any time and without a
 * throttle; `?tracks=KEY,KEY` takes those tracks and what belongs to them, with the whole
 * configuration. The archive is written while it downloads, a page of records at a time, so
 * a large workspace never sits in memory. Site administrators only (it holds everything, people
 * and restricted comments included); each download is audited (`workspace.exported`).
 */
const exportQuery = z
  .object({
    tracks: z
      .string()
      .max(4000)
      .regex(/^[A-Za-z0-9_,]*$/)
      .optional(),
  })
  .strict();

export function registerExportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  stores: AttachmentStores,
): void {
  app.get('/api/v1/admin/export', async (request, reply) => {
    const user = await requireSiteAdmin(request, reply);
    if (!user) return reply;
    const parsed = exportQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const keys = parsed.data.tracks
      ?.split(',')
      .map((k) => k.trim().toUpperCase())
      .filter((k) => k !== '');
    let tracks: number[] | null = null;
    if (keys !== undefined) {
      const rows = await db
        .selectFrom('track')
        .select(['id', 'key'])
        .where('workspace_id', '=', ws)
        .where('deleted_at', 'is', null)
        .where('key', 'in', keys.length > 0 ? keys : [''])
        .execute();
      const unknown = keys.filter((k) => !rows.some((r) => r.key === k));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'unknown_tracks', tracks: unknown });
      }
      tracks = rows.map((r) => r.id);
    }
    await emit(
      db,
      { workspaceId: ws, actorId: user.id },
      { type: 'workspace.exported', subjectId: ws, payload: { tracks: keys ?? null } },
    );
    await countBulkExport(db, ws, user.id);
    const sink = zipSink();
    const day = new Date().toISOString().slice(0, 10);
    // Written while the client reads; a failure part way ends the download short (the
    // manifest, written last, is then missing, and an import refuses the archive).
    exportWorkspace(db, { workspaceId: ws, sink, stores, catalogs, tracks })
      .then(() => sink.finish())
      .catch((error: unknown) => {
        request.log.error({ error }, 'export failed');
        (sink.output as unknown as { destroy(e?: Error): void }).destroy(error as Error);
      });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="taskmoor-export-${day}.zip"`)
      .header('cache-control', 'no-store')
      .send(sink.output);
  });
}
