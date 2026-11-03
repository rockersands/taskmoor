import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import {
  setUpdateCheckEnabled,
  type UpdateCheckConfig,
  updateCheckEnabled,
  updateStatus,
} from '../updates/check';

/**
 * The new-version notice for site administrators (OPS-026, ADR-117): what the last check found,
 * with the exact command to run, and the switch that stops the checks. Nobody else may read it,
 * and the public meta endpoint says nothing about it.
 */
const putBody = z.object({ enabled: z.boolean() }).strict();

export function registerUpdateCheckRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: UpdateCheckConfig,
): void {
  app.get('/api/v1/admin/update-check', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { updateCheck: await updateStatus(db, config) };
  });

  app.put('/api/v1/admin/update-check', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const body = putBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const to = body.data.enabled;
    await db.transaction().execute(async (trx) => {
      const from = await updateCheckEnabled(trx);
      if (from === to) return;
      await setUpdateCheckEnabled(trx, to);
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: request.user?.id ?? null },
        {
          type: 'update_check.updated',
          subjectId: request.workspaceId,
          payload: { changes: { enabled: { from, to } } },
        },
      );
    });
    return { updateCheck: await updateStatus(db, config) };
  });
}
