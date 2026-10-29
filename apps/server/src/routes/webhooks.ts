import type { Database } from '@taskmoor/db';
import { type PepperRing, sealSecret } from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { bindCondition, editorScope } from '../boards/data';
import { diff, emit } from '../events/bus';
import { enqueue } from '../events/queue';
import type { FieldCatalogs } from '../fields/catalog';
import {
  createWebhookBody,
  MAX_ATTEMPTS,
  replayBody,
  updateWebhookBody,
  urlProblem,
  validPattern,
} from '../webhooks/model';
import { DELIVER_TASK, deliverKey } from '../webhooks/subscriber';

/**
 * Webhooks (M1-067; API-009; ADR-055), for site administrators.
 *
 * - `GET` and `POST /api/v1/webhooks` list and register; `GET`, `PATCH` and `DELETE
 *   /api/v1/webhooks/:id` read, change and remove one. The secret is write-only: answers say
 *   whether one is set. The query is checked as its owner (whoever registered the webhook)
 *   would run it; a Matrix webhook needs its access token as the secret.
 * - `GET /api/v1/webhooks/:id/deliveries?state=` lists deliveries, newest first;
 *   `POST /api/v1/webhooks/:id/deliveries/replay` sends named deliveries, or every failed one,
 *   again: the same body under the same delivery id, with a fresh set of retries.
 */
const MAX_INT = 2_147_483_647;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const listQuery = z
  .object({
    state: z.enum(['pending', 'delivered', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

type Row = {
  id: number;
  name: string;
  url: string;
  format: string;
  events: string[];
  filter_query: string | null;
  secret_sealed: string | null;
  enabled: boolean;
  owner_id: number;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const view = (w: Row) => ({
  id: w.id,
  name: w.name,
  url: w.url,
  format: w.format,
  events: w.events,
  filterQuery: w.filter_query,
  hasSecret: w.secret_sealed !== null,
  enabled: w.enabled,
  ownerId: w.owner_id,
  version: w.version,
  createdAt: w.created_at.toISOString(),
  updatedAt: w.updated_at.toISOString(),
});

export function registerWebhookRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: { peppers?: PepperRing | undefined } = {},
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const invalid = (reply: FastifyReply, fields: Record<string, string>) =>
    reply.code(400).send({ error: 'invalid_fields', fields });

  async function load(request: FastifyRequest, reply: FastifyReply): Promise<Row | null> {
    const p = idParam.safeParse(request.params);
    const row = p.success
      ? ((await db
          .selectFrom('webhook')
          .selectAll()
          .where('id', '=', p.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .executeTakeFirst()) as Row | undefined)
      : undefined;
    if (!row) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return row;
  }

  /** What is wrong with the address, events, query and secret, by field. */
  async function problems(
    request: FastifyRequest,
    values: {
      url?: string;
      events?: string[];
      filterQuery?: string | null;
      format?: string;
      hasSecret: boolean;
    },
  ): Promise<Record<string, string>> {
    const fields: Record<string, string> = {};
    if (values.url !== undefined) {
      const problem = urlProblem(values.url);
      if (problem) fields.url = problem;
    }
    for (const [i, pattern] of (values.events ?? []).entries()) {
      if (!validPattern(pattern)) fields[`events.${i}`] = 'unknown_event';
    }
    if (values.filterQuery) {
      try {
        // As the person saving it could run it: one that names what they cannot see fails.
        await bindCondition(
          db,
          await editorScope(db, catalogs, request),
          values.filterQuery,
          new Date(),
        );
      } catch {
        fields.filterQuery = 'invalid_query';
      }
    }
    if (values.format === 'matrix' && !values.hasSecret) fields.secret = 'required_for_matrix';
    return fields;
  }

  app.get('/api/v1/webhooks', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const rows = (await db
      .selectFrom('webhook')
      .selectAll()
      .where('workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(name)`)
      .execute()) as Row[];
    return { webhooks: rows.map(view) };
  });

  app.post('/api/v1/webhooks', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = createWebhookBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const fields = await problems(request, {
      url: body.url,
      events: body.events,
      filterQuery: body.filterQuery ?? null,
      format: body.format,
      hasSecret: Boolean(body.secret),
    });
    if (Object.keys(fields).length > 0) return invalid(reply, fields);
    const events = [...new Set(body.events)];
    try {
      const row = await db.transaction().execute(async (trx) => {
        const created = (await trx
          .insertInto('webhook')
          .values({
            workspace_id: request.workspaceId,
            name: body.name,
            url: body.url,
            format: body.format,
            events,
            filter_query: body.filterQuery ?? null,
            secret_sealed: body.secret ? sealSecret(body.secret, options.peppers?.active) : null,
            enabled: body.enabled,
            owner_id: admin.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow()) as Row;
        await emit(trx, by(request), {
          type: 'webhook.created',
          subjectId: created.id,
          payload: {
            name: created.name,
            url: created.url,
            format: created.format,
            events: created.events,
            filtered: created.filter_query !== null,
            enabled: created.enabled,
          },
        });
        return created;
      });
      return reply.code(201).send({ webhook: view(row) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return invalid(reply, { name: 'taken' });
      }
      throw error;
    }
  });

  app.get('/api/v1/webhooks/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await load(request, reply);
    if (!row) return reply;
    return { webhook: view(row) };
  });

  app.patch('/api/v1/webhooks/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await load(request, reply);
    if (!row) return reply;
    const parsed = updateWebhookBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    if (body.version !== undefined && body.version !== row.version) {
      return reply.code(409).send({ error: 'version_conflict', version: row.version });
    }
    const format = body.format ?? row.format;
    const hasSecret = body.secret === undefined ? row.secret_sealed !== null : body.secret !== null;
    const fields = await problems(request, {
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
      ...(body.filterQuery !== undefined ? { filterQuery: body.filterQuery } : {}),
      format,
      hasSecret,
    });
    if (Object.keys(fields).length > 0) return invalid(reply, fields);
    const next = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.format !== undefined ? { format: body.format } : {}),
      ...(body.events !== undefined ? { events: [...new Set(body.events)] } : {}),
      ...(body.filterQuery !== undefined ? { filter_query: body.filterQuery } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };
    try {
      const updated = await db.transaction().execute(async (trx) => {
        const changed = (await trx
          .updateTable('webhook')
          .set({
            ...next,
            ...(body.secret !== undefined
              ? {
                  secret_sealed:
                    body.secret === null ? null : sealSecret(body.secret, options.peppers?.active),
                }
              : {}),
            version: row.version + 1,
            updated_at: new Date(),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow()) as Row;
        await emit(trx, by(request), {
          type: 'webhook.updated',
          subjectId: row.id,
          payload: {
            changes: diff(row as unknown as Record<string, unknown>, next),
            secretChanged: body.secret !== undefined,
          },
        });
        return changed;
      });
      return { webhook: view(updated) };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return invalid(reply, { name: 'taken' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/webhooks/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await load(request, reply);
    if (!row) return reply;
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('webhook').where('id', '=', row.id).execute();
      await emit(trx, by(request), {
        type: 'webhook.deleted',
        subjectId: row.id,
        payload: { name: row.name },
      });
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/webhooks/:id/deliveries', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await load(request, reply);
    if (!row) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, shapeErrors(parsed.error));
    let query = db
      .selectFrom('webhook_delivery')
      .select([
        'id',
        'event_id',
        'event_type',
        'state',
        'attempts',
        'last_status',
        'last_error',
        'last_attempt_at',
        'duration_ms',
        'delivered_at',
        'replays',
        'created_at',
      ])
      .where('webhook_id', '=', row.id)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(parsed.data.limit);
    if (parsed.data.state) query = query.where('state', '=', parsed.data.state);
    const deliveries = await query.execute();
    return {
      deliveries: deliveries.map((d) => ({
        id: d.id,
        eventId: String(d.event_id),
        eventType: d.event_type,
        state: d.state,
        attempts: d.attempts,
        lastStatus: d.last_status,
        lastError: d.last_error,
        lastAttemptAt: d.last_attempt_at?.toISOString() ?? null,
        durationMs: d.duration_ms,
        deliveredAt: d.delivered_at?.toISOString() ?? null,
        replays: d.replays,
        createdAt: d.created_at.toISOString(),
      })),
    };
  });

  app.post('/api/v1/webhooks/:id/deliveries/replay', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await load(request, reply);
    if (!row) return reply;
    const parsed = replayBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const replayed = await db.transaction().execute(async (trx) => {
      let query = trx
        .updateTable('webhook_delivery')
        .set({
          state: 'pending',
          last_error: null,
          replays: sql<number>`replays + 1`,
        })
        .where('webhook_id', '=', row.id);
      query = body.deliveryIds
        ? query.where('id', 'in', body.deliveryIds)
        : query.where(
            'id',
            'in',
            trx
              .selectFrom('webhook_delivery')
              .select('id')
              .where('webhook_id', '=', row.id)
              .where('state', '=', 'failed')
              .orderBy('created_at')
              .limit(1000),
          );
      const rows = await query.returning(['id', 'replays']).execute();
      if (rows.length === 0) return [];
      await enqueue(
        trx,
        rows.map((r) => ({
          workspaceId: request.workspaceId,
          task: DELIVER_TASK,
          payload: { deliveryId: r.id },
          key: deliverKey(r.id, r.replays),
          maxAttempts: MAX_ATTEMPTS,
        })),
      );
      await emit(trx, by(request), {
        type: 'webhook.delivery_replayed',
        subjectId: row.id,
        payload: { deliveryIds: rows.map((r) => r.id) },
      });
      return rows.map((r) => r.id);
    });
    if (replayed.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { replayed };
  });
}
