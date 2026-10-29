import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import { enqueue } from '../events/queue';
import { importJob } from '../import/jobs';
import { type FidelityReport, reportHtml } from '../import/report';
import { createRun, runView } from '../import/run';
import {
  parseSynthetic,
  SYNTHETIC_SOURCE,
  SyntheticFormatError,
  syntheticSource,
} from '../import/synthetic';

/**
 * Imports (M1-086; IMP-009, IMP-010, IMP-013): a site administrator starts one from an uploaded
 * file or a configured source, as a real run or a dry run; a background job runs it
 * (`import/jobs.ts`); these routes show its progress and its fidelity report (JSON, or HTML to
 * download) and take a cancel. They sit under `/api/v1/admin`, so API tokens need the admin
 * scope. Starting, cancelling and finishing are audited.
 */
const MAX_UPLOAD = 17 * 1024 * 1024;

const createBody = z
  .object({
    name: z.string().max(200).optional(),
    dryRun: z.boolean().optional(),
    source: syntheticSource,
  })
  .strict();
const idParam = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/) });
const reportQuery = z.object({ format: z.enum(['json', 'html']).optional() }).strict();

export function registerImportRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  /** The signed-in site administrator, or the refusal already sent. */
  async function admin(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request, reply);
    if (!user) return null;
    if (!(await request.authz.isSiteAdmin())) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return user;
  }

  async function find(request: FastifyRequest, reply: FastifyReply) {
    const p = idParam.safeParse(request.params);
    const row = p.success
      ? await db
          .selectFrom('import_run')
          .selectAll()
          .where('workspace_id', '=', request.workspaceId)
          .where('id', '=', p.data.id)
          .executeTakeFirst()
      : undefined;
    if (!row) {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return row;
  }

  app.post('/api/v1/admin/imports', { bodyLimit: MAX_UPLOAD }, async (request, reply) => {
    const user = await admin(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_fields',
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'body', i.code]),
        ),
      });
    }
    const body = parsed.data;
    let system: string;
    if ('data' in body.source) {
      try {
        system = parseSynthetic(body.source.data).system;
      } catch (error) {
        const line = error instanceof SyntheticFormatError ? error.line : null;
        return reply.code(400).send({ error: 'invalid_source', line });
      }
    } else {
      system = body.source.generate.system ?? `synthetic-${body.source.generate.seed}`;
    }
    const ws = request.workspaceId;
    const row = await db.transaction().execute(async (trx) => {
      const created = await createRun(trx, {
        workspaceId: ws,
        userId: user.id,
        importSource: SYNTHETIC_SOURCE,
        system,
        name: body.name ?? '',
        source: body.source,
        dryRun: body.dryRun ?? false,
      });
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'import_run.created',
          subjectId: Number(created.id),
          payload: {
            importSource: created.import_source,
            sourceSystem: created.source_system,
            name: created.name,
            dryRun: created.dry_run,
          },
        },
      );
      await enqueue(trx, [importJob(ws, created.id)]);
      return created;
    });
    return reply.code(202).send({ importRun: runView(row) });
  });

  app.get('/api/v1/admin/imports', async (request, reply) => {
    if (!(await admin(request, reply))) return reply;
    const rows = await db
      .selectFrom('import_run')
      .selectAll()
      .where('workspace_id', '=', request.workspaceId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    return { importRuns: rows.map(runView) };
  });

  app.get('/api/v1/admin/imports/:id', async (request, reply) => {
    if (!(await admin(request, reply))) return reply;
    const row = await find(request, reply);
    if (!row) return reply;
    return { importRun: runView(row) };
  });

  app.get('/api/v1/admin/imports/:id/report', async (request, reply) => {
    if (!(await admin(request, reply))) return reply;
    const q = reportQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await find(request, reply);
    if (!row) return reply;
    if (row.report === null) {
      return reply.code(409).send({ error: 'not_finished', status: row.status });
    }
    const report = row.report as unknown as FidelityReport;
    if (q.data.format === 'html') {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-disposition', `attachment; filename="import-${row.id}-report.html"`)
        .send(reportHtml(report));
    }
    return { report };
  });

  app.post('/api/v1/admin/imports/:id/cancel', async (request, reply) => {
    const user = await admin(request, reply);
    if (!user) return reply;
    const row = await find(request, reply);
    if (!row) return reply;
    if (row.status === 'done' || row.status === 'cancelled' || row.status === 'failed') {
      return reply.code(409).send({ error: 'finished', status: row.status });
    }
    const updated = await db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('import_run')
        .set({ cancel_requested: true, updated_at: new Date() })
        .where('id', '=', row.id)
        .where('cancel_requested', '=', false)
        .returningAll()
        .executeTakeFirst();
      if (changed) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: user.id },
          {
            type: 'import_run.cancelled',
            subjectId: Number(row.id),
            payload: {
              importSource: row.import_source,
              sourceSystem: row.source_system,
              dryRun: row.dry_run,
            },
          },
        );
      }
      return changed ?? row;
    });
    return reply.code(202).send({ importRun: runView(updated) });
  });
}
