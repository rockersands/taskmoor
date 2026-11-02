import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AttachmentStores } from '../attachments/stores';
import { requireSiteAdmin, requireUser } from '../auth';
import { emit } from '../events/bus';
import { type EraseRefusal, eraseUser } from '../privacy/erase';
import {
  EXPORT_COLUMNS,
  type PersonalExportView,
  requestPersonalExport,
  toExportView,
} from '../privacy/export';

/**
 * A person's own data (ASVS 8.3.2; IAM-008; ADR-111).
 *
 * - `POST /api/v1/account/data-exports` asks for a download of one's own data, made in the
 *   background; `GET /api/v1/account/data-exports` lists one's downloads and
 *   `GET /api/v1/account/data-exports/:id/download` fetches a finished one. Signed-in browsers
 *   only: an API token cannot take a person's data out.
 * - Site administrators do the same for anyone under `/api/v1/users/:id/data-exports`; each
 *   download belongs to whoever asked for it.
 * - `POST /api/v1/users/:id/erase` erases a person (`privacy/erase.ts`), confirmed by typing
 *   their email.
 *
 * Asking for a download and erasing are audited (`personal_data.export_requested`,
 * `user.erased`).
 */
const idParams = z.object({ id: z.coerce.number().int().positive() });
const downloadParams = z.object({ id: z.coerce.number().int().positive() });
const adminDownloadParams = z.object({
  id: z.coerce.number().int().positive(),
  exportId: z.coerce.number().int().positive(),
});
const eraseBody = z.object({ confirmEmail: z.string().max(320) }).strict();

const LIST_LIMIT = 20;

const ERASE_STATUS: Record<EraseRefusal, number> = {
  not_found: 404,
  already_erased: 409,
  cannot_erase_self: 409,
  last_admin: 409,
  confirmation_mismatch: 400,
  managed_by_directory: 409,
  managed_by_scim: 409,
};

export function registerPersonalDataRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  stores: AttachmentStores,
): void {
  const list = async (ws: number, userId: number, requestedBy?: number) => {
    let query = db
      .selectFrom('personal_export')
      .select([...EXPORT_COLUMNS])
      .where('workspace_id', '=', ws)
      .where('user_id', '=', userId);
    if (requestedBy !== undefined) query = query.where('requested_by', '=', requestedBy);
    const rows = await query.orderBy('created_at', 'desc').limit(LIST_LIMIT).execute();
    return rows.map(toExportView);
  };

  const request = async (
    ws: number,
    userId: number,
    requestedBy: number,
    by: 'self' | 'admin',
  ): Promise<PersonalExportView | 'in_progress'> =>
    db.transaction().execute(async (trx) => {
      const made = await requestPersonalExport(trx, { workspaceId: ws, userId, requestedBy });
      if (made === 'in_progress') return made;
      await emit(
        trx,
        { workspaceId: ws, actorId: requestedBy },
        {
          type: 'personal_data.export_requested',
          subjectId: userId,
          payload: { exportId: made.id, by },
        },
      );
      return made;
    });

  const download = async (
    reply: FastifyReply,
    ws: number,
    where: { id: number; userId: number; requestedBy: number },
  ) => {
    const row = await db
      .selectFrom('personal_export')
      .select(['id', 'state', 'storage', 'storage_key', 'size', 'created_at'])
      .where('workspace_id', '=', ws)
      .where('id', '=', String(where.id))
      .where('user_id', '=', where.userId)
      .where('requested_by', '=', where.requestedBy)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.state !== 'ready' || !row.storage || !row.storage_key) {
      return reply.code(409).send({ error: 'not_ready', state: row.state });
    }
    const store = stores.stores[row.storage];
    if (!store) return reply.code(503).send({ error: 'storage_unavailable' });
    const day = row.created_at.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="taskmoor-personal-data-${where.userId}-${day}.zip"`,
      )
      .header('content-length', String(row.size))
      .header('cache-control', 'no-store')
      .send(await store.read(row.storage_key));
  };

  // The person's own ---------------------------------------------------------------------------
  app.post('/api/v1/account/data-exports', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    if (!stores.active) return reply.code(503).send({ error: 'storage_unavailable' });
    const made = await request(req.workspaceId, user.id, user.id, 'self');
    if (made === 'in_progress') return reply.code(409).send({ error: 'export_in_progress' });
    return reply.code(202).send({ export: made });
  });

  app.get('/api/v1/account/data-exports', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return { exports: await list(req.workspaceId, user.id, user.id) };
  });

  app.get('/api/v1/account/data-exports/:id/download', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const params = downloadParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    return download(reply, req.workspaceId, {
      id: params.data.id,
      userId: user.id,
      requestedBy: user.id,
    });
  });

  // Site administrators, for anyone ------------------------------------------------------------
  const person = (ws: number, id: number) =>
    db
      .selectFrom('app_user')
      .select(['id', 'erased_at'])
      .where('workspace_id', '=', ws)
      .where('id', '=', id)
      .where('kind', '=', 'person')
      .executeTakeFirst();

  app.post('/api/v1/users/:id/data-exports', async (req, reply) => {
    const admin = await requireSiteAdmin(req, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const target = await person(req.workspaceId, params.data.id);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.erased_at !== null) return reply.code(409).send({ error: 'already_erased' });
    if (!stores.active) return reply.code(503).send({ error: 'storage_unavailable' });
    const made = await request(req.workspaceId, target.id, admin.id, 'admin');
    if (made === 'in_progress') return reply.code(409).send({ error: 'export_in_progress' });
    return reply.code(202).send({ export: made });
  });

  app.get('/api/v1/users/:id/data-exports', async (req, reply) => {
    const admin = await requireSiteAdmin(req, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await person(req.workspaceId, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { exports: await list(req.workspaceId, params.data.id, admin.id) };
  });

  app.get('/api/v1/users/:id/data-exports/:exportId/download', async (req, reply) => {
    const admin = await requireSiteAdmin(req, reply);
    if (!admin) return reply;
    const params = adminDownloadParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    return download(reply, req.workspaceId, {
      id: params.data.exportId,
      userId: params.data.id,
      requestedBy: admin.id,
    });
  });

  app.post('/api/v1/users/:id/erase', async (req, reply) => {
    const admin = await requireSiteAdmin(req, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(req.params);
    const body = eraseBody.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const outcome = await db.transaction().execute((trx) =>
      eraseUser(trx, {
        workspaceId: req.workspaceId,
        userId: params.data.id,
        actorId: admin.id,
        confirmEmail: body.data.confirmEmail,
      }),
    );
    if (typeof outcome === 'string') {
      return reply.code(ERASE_STATUS[outcome]).send({ error: outcome });
    }
    return { erased: outcome };
  });
}
