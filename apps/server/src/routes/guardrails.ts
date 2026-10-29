import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import {
  GUARDRAIL_CEILING,
  GUARDRAILS,
  guardrailLimits,
  guardrailUsage,
  isGuardrail,
} from '../guardrails/model';

/**
 * The guardrails admin (M1-055; CORE-026): `GET /api/v1/admin/guardrails` shows every limit, its
 * default and where it is used most; `PUT /api/v1/admin/guardrails/:name` sets a limit, which
 * takes effect with the next addition (CORE-026 (3)). Site administrators only.
 */
const putBody = z.object({ limit: z.number().int().min(1).max(GUARDRAIL_CEILING) }).strict();

export function registerGuardrailRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/admin/guardrails', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const ws = request.workspaceId;
    const [limits, usage] = await Promise.all([guardrailLimits(db, ws), guardrailUsage(db, ws)]);
    return {
      guardrails: GUARDRAILS.map((g) => ({
        name: g.name,
        limit: limits[g.name],
        default: g.default,
        usage: usage[g.name],
      })),
      ceiling: GUARDRAIL_CEILING,
    };
  });

  app.put('/api/v1/admin/guardrails/:name', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const name = (request.params as { name: string }).name;
    if (!isGuardrail(name)) return reply.code(404).send({ error: 'not_found' });
    const body = putBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const to = body.data.limit;
    await db.transaction().execute(async (trx) => {
      const from = (await guardrailLimits(trx, ws))[name];
      await trx
        .insertInto('guardrail_limit')
        .values({ workspace_id: ws, name, value: to, updated_by: request.user?.id ?? null })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'name']).doUpdateSet({
            value: to,
            updated_at: sql`now()`,
            updated_by: request.user?.id ?? null,
          }),
        )
        .execute();
      await emit(
        trx,
        { workspaceId: ws, actorId: request.user?.id ?? null },
        { type: 'guardrail.changed', subjectId: ws, payload: { name, from, to } },
      );
    });
    return { name, limit: to };
  });
}
