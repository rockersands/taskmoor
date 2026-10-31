import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import { enqueue } from '../events/queue';
import { CSV_SOURCE, CsvFormatError, CsvSource, csvMapping, csvSource } from '../import/csv';
import { DC_SOURCE, dcBackupSource } from '../import/dc';
import { checkDcBackup, DcBackupError } from '../import/dc-backup/stage';
import { importJob } from '../import/jobs';
import { type FidelityReport, reportHtml } from '../import/report';
import { createRun, runView } from '../import/run';
import {
  parseSynthetic,
  SYNTHETIC_SOURCE,
  SyntheticFormatError,
  syntheticSource,
} from '../import/synthetic';
import { EXPORT_SOURCE, ExportFormatError, exportManifest, exportSource } from '../import/taskmoor';

/**
 * Imports (M1-086; IMP-009, IMP-010, IMP-012, IMP-013, IMP-014): a site administrator starts one
 * from an uploaded file or a file on the server, as a real run or a dry run; a background job
 * runs it (`import/jobs.ts`); these routes show its progress, its fidelity report (JSON, or
 * HTML to download) and every record's problems, and take a cancel. They sit under
 * `/api/v1/admin`, so API tokens need the admin scope. Starting, cancelling and finishing are
 * audited.
 *
 * Sources: the synthetic format (M1-086), CSV with a column mapping (M1-098; the mapping can be
 * copied from an earlier run, a saved template in effect), Taskmoor's own export (M1-098) and a
 * Data Center backup ZIP (M1-088). A file named by path must be inside the imports folder
 * (`TASKMOOR_IMPORT_DIR`, by default `TASKMOOR_DATA/imports`), so an administrator's request
 * never reads anything else on the server. The records route lists what became of each source
 * record, with the name it had there: the whole mapping the report shows the start of.
 */
const MAX_UPLOAD = 17 * 1024 * 1024;

const csvInput = z
  .object({
    format: z.literal(CSV_SOURCE),
    data: z.string().min(1).max(16_000_000).optional(),
    path: z.string().min(1).max(4096).optional(),
    system: z.string().min(1).max(200).optional(),
    mapping: csvMapping.optional(),
    /** Takes the mapping of an earlier CSV run instead (a mapping kept as a template). */
    mappingFrom: z.number().int().positive().optional(),
  })
  .strict();

const createBody = z
  .object({
    name: z.string().max(200).optional(),
    dryRun: z.boolean().optional(),
    source: z.union([syntheticSource, csvInput, exportSource, dcBackupSource]),
  })
  .strict();
const idParam = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/) });
const reportQuery = z.object({ format: z.enum(['json', 'html']).optional() }).strict();
const problemsQuery = z
  .object({
    kind: z.string().max(40).optional(),
    after: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    outcome: z.enum(['failed', 'skipped', 'warned']).optional(),
  })
  .strict();
const recordsQuery = z
  .object({
    kind: z.string().max(40).optional(),
    after: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    outcome: z.enum(['created', 'updated', 'unchanged', 'linked', 'failed', 'skipped']).optional(),
  })
  .strict();

/** A page cursor `<kind>|<source id>`: the last record of the previous page. */
function pageAfter(after: string | undefined): { kind: string; id: string } {
  const text = after ?? '|';
  const cut = text.indexOf('|');
  return { kind: text.slice(0, Math.max(cut, 0)), id: cut < 0 ? '' : text.slice(cut + 1) };
}

class SourceRefused extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** A path inside the imports folder, resolved through links, or a refusal. */
async function insideImports(importDir: string | undefined, path: string): Promise<string> {
  if (!importDir) throw new SourceRefused('no_import_folder');
  let root: string;
  let target: string;
  try {
    root = await realpath(importDir);
    target = await realpath(resolve(root, path));
  } catch {
    throw new SourceRefused('not_found');
  }
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new SourceRefused('outside_import_folder');
  await stat(target);
  return target;
}

export function registerImportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { importDir?: string } = {},
): void {
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
    const ws = request.workspaceId;
    let system: string;
    let importSource: string;
    let source: unknown = body.source;
    try {
      if (body.source.format === SYNTHETIC_SOURCE) {
        importSource = SYNTHETIC_SOURCE;
        if ('data' in body.source) {
          try {
            system = parseSynthetic(body.source.data).system;
          } catch (error) {
            const line = error instanceof SyntheticFormatError ? error.line : null;
            throw new SourceRefused('invalid_source', { line });
          }
        } else {
          system = body.source.generate.system ?? `synthetic-${body.source.generate.seed}`;
        }
      } else if (body.source.format === CSV_SOURCE) {
        importSource = CSV_SOURCE;
        const input = body.source;
        let mapping = input.mapping;
        if (mapping === undefined && input.mappingFrom !== undefined) {
          const earlier = await db
            .selectFrom('import_run')
            .select('source')
            .where('workspace_id', '=', ws)
            .where('id', '=', String(input.mappingFrom))
            .where('import_source', '=', CSV_SOURCE)
            .executeTakeFirst();
          if (!earlier) throw new SourceRefused('unknown_mapping_run');
          mapping = (earlier.source as { mapping: z.infer<typeof csvMapping> }).mapping;
        }
        if (mapping === undefined) throw new SourceRefused('mapping_required');
        const settings = csvSource.safeParse({
          format: CSV_SOURCE,
          ...(input.data !== undefined ? { data: input.data } : {}),
          ...(input.path !== undefined
            ? { path: await insideImports(options.importDir, input.path) }
            : {}),
          ...(input.system !== undefined ? { system: input.system } : {}),
          mapping,
        });
        if (!settings.success) throw new SourceRefused('invalid_source');
        try {
          // The header against the mapping, before anything is queued.
          new CsvSource(settings.data).check();
        } catch (error) {
          if (error instanceof CsvFormatError) {
            throw new SourceRefused('invalid_source', { line: error.line, message: error.message });
          }
          throw error;
        }
        system = settings.data.system;
        source = settings.data;
      } else if (body.source.format === DC_SOURCE) {
        importSource = DC_SOURCE;
        const path = await insideImports(options.importDir, body.source.path);
        try {
          // The ZIP's directory only: the backup itself is read by the job.
          await checkDcBackup(path);
        } catch (error) {
          if (error instanceof DcBackupError) {
            throw new SourceRefused('invalid_source', { message: error.message });
          }
          throw error;
        }
        system = body.source.system;
        source = { format: DC_SOURCE, path, system, scope: body.source.scope };
      } else {
        importSource = EXPORT_SOURCE;
        const path = await insideImports(options.importDir, body.source.path);
        try {
          system = (await exportManifest(path)).system;
        } catch (error) {
          if (error instanceof ExportFormatError || error instanceof SyntaxError) {
            throw new SourceRefused('invalid_source', { message: error.message });
          }
          throw error;
        }
        source = { format: EXPORT_SOURCE, path };
      }
    } catch (error) {
      if (error instanceof SourceRefused) {
        return reply.code(400).send({ error: error.code, ...error.detail });
      }
      throw error;
    }
    const row = await db.transaction().execute(async (trx) => {
      const created = await createRun(trx, {
        workspaceId: ws,
        userId: user.id,
        importSource,
        system,
        name: body.name ?? '',
        source,
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

  // Every record's problems (M1-098): failures and warnings, a page at a time, by kind and id.
  app.get('/api/v1/admin/imports/:id/problems', async (request, reply) => {
    if (!(await admin(request, reply))) return reply;
    const q = problemsQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await find(request, reply);
    if (!row) return reply;
    const limit = q.data.limit ?? 100;
    const { kind: afterKind, id: afterId } = pageAfter(q.data.after);
    const rows = await db
      .selectFrom('import_record')
      .select(['entity_kind', 'source_id', 'outcome', 'target_id', 'error'])
      .where('run_id', '=', row.id)
      .where('error', 'is not', null)
      .$if(q.data.kind !== undefined, (b) => b.where('entity_kind', '=', q.data.kind as string))
      .$if(q.data.outcome === 'warned', (b) => b.where('outcome', 'not in', ['failed', 'skipped']))
      .$if(q.data.outcome === 'failed' || q.data.outcome === 'skipped', (b) =>
        b.where('outcome', '=', q.data.outcome as 'failed' | 'skipped'),
      )
      .where((eb) =>
        eb.or([
          eb('entity_kind', '>', afterKind),
          eb.and([eb('entity_kind', '=', afterKind), eb('source_id', '>', afterId)]),
        ]),
      )
      .orderBy('entity_kind')
      .orderBy('source_id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      problems: page.map((r) => {
        const e = (r.error ?? {}) as { error?: string; warnings?: unknown[] };
        return {
          kind: r.entity_kind,
          sourceId: r.source_id,
          outcome: r.outcome,
          targetId: r.target_id === null ? null : Number(r.target_id),
          error: e.error ?? null,
          warnings: e.warnings ?? [],
        };
      }),
      next: rows.length > limit && last ? `${last.entity_kind}|${last.source_id}` : null,
    };
  });

  // Every record of a run (M1-088): what became of it, with the name it had in the source.
  app.get('/api/v1/admin/imports/:id/records', async (request, reply) => {
    if (!(await admin(request, reply))) return reply;
    const q = recordsQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await find(request, reply);
    if (!row) return reply;
    const limit = q.data.limit ?? 100;
    const { kind: afterKind, id: afterId } = pageAfter(q.data.after);
    const rows = await db
      .selectFrom('import_record')
      .select(['entity_kind', 'source_id', 'label', 'outcome', 'target_id', 'error'])
      .where('run_id', '=', row.id)
      .$if(q.data.kind !== undefined, (b) => b.where('entity_kind', '=', q.data.kind as string))
      .$if(q.data.outcome !== undefined, (b) =>
        b.where('outcome', '=', q.data.outcome as NonNullable<typeof q.data.outcome>),
      )
      .where((eb) =>
        eb.or([
          eb('entity_kind', '>', afterKind),
          eb.and([eb('entity_kind', '=', afterKind), eb('source_id', '>', afterId)]),
        ]),
      )
      .orderBy('entity_kind')
      .orderBy('source_id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      records: page.map((r) => {
        const e = (r.error ?? {}) as { error?: string; warnings?: unknown[] };
        return {
          kind: r.entity_kind,
          sourceId: r.source_id,
          label: r.label,
          outcome: r.outcome,
          targetId: r.target_id === null ? null : Number(r.target_id),
          reason: e.error ?? null,
          warnings: e.warnings ?? [],
        };
      }),
      next: rows.length > limit && last ? `${last.entity_kind}|${last.source_id}` : null,
    };
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
