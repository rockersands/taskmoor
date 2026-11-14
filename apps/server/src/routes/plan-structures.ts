import type { Database } from '@taskmoor/db';
import { dayOfIso } from '@taskmoor/formula';
import { QueryError } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { compileCondition, compileQuery, type Scope } from '../boards/data';
import { diff, emit } from '../events/bus';
import type { Catalog, FieldCatalogs } from '../fields/catalog';
import { formulaEnv, formulaPlan, readableType, SYSTEM_REFS } from '../fields/formulas';
import { planEditable } from '../plans/access';
import { lockPlan, versionQuery } from '../plans/drafts';
import { filterShape, scenarioShape } from '../plans/model';
import { planScope, planTickets, sourceRows } from '../plans/query';
import {
  CHILD_LEVELS,
  type CheckContext,
  checkStructure,
  DEFAULT_STRUCTURE,
  GRID_ROWS,
  type LinksStep,
  MAX_GRID_IDS,
  MAX_STRUCTURES,
  type ReadField,
  resolveStructure,
  STRUCTURE_LIMITS,
  type StructureProblem,
  type StructureSpec,
  structureSpec,
} from '../plans/structures';
import {
  buildStructure,
  type ExpandLevel,
  type GroupLevel,
  type TreeTicket,
} from '../plans/structureTree';
import { names as axisNames, axisValues, parseAxis } from '../reports/general';
import { SearchError } from '../search/bind';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { todayIn } from '../templates/model';
import { viewScenario } from './plan-scenarios';
import { planVisible } from './plans';
import { project, projection, searchRefusal, searchViews } from './search';

/**
 * The Grid of a Multi-track plan (T-089a; PLN-010; ADR-122 stage 10).
 *
 * - `GET /plans/:id/structures` lists the plan's structures for anyone who sees the plan, each
 *   with whether it is broken for this reader; `POST` saves one, `PATCH` changes and `DELETE`
 *   removes one, with its `version`, for the plan's editors (`planEditable`). At most 20 a plan,
 *   names unique in the plan ignoring case.
 * - `GET .../structures/:sid/rows` (`default` in place of `:sid` for the unsaved default) is the
 *   skeleton: the structure's rows for this reader, columnar, with keys, the fields totals and
 *   formulas read and their values, today on the reader's clock and the working week. It is read
 *   in one read-only transaction under the plan views' statement timeout; a read that runs too
 *   long answers 503 `query_timeout`, never part of an answer. Inside a scenario (`scenario=`) the
 *   Grid shows live values: the answer is the same.
 * - `POST .../grid/tickets` answers up to 500 tickets in the search route's shape, each with its
 *   `version`, for the rows in view. An id the reader may not see is left out silently, as a
 *   missing one.
 *
 * A plan gives no access: rows are only tickets the reader may see, through `planTickets()` for
 * the Add tickets step and the reader's ticket filter for the rest. A hidden ticket below a row is
 * only counted (`notShown`), never keyed, valued or totalled; a hidden parent breaks the path.
 * A plan the reader may not see, and a structure of another plan, answer 404 word for word as a
 * missing id; a write by someone who may not change the plan answers 403 `edit_plan`. Each write
 * emits one `plan.structure_*` event in its transaction, audited: ids and the name.
 *
 * There is no write route for rows: an edit or a move is the ticket's own `PATCH /tickets/:id`.
 */
type Db = Kysely<Database>;
type Trx = Transaction<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const structureName = z.string().trim().min(1).max(100);

const createBody = z.object({ name: structureName, spec: structureSpec }).strict();
const changeBody = z
  .object({ name: structureName.optional(), spec: structureSpec.optional(), version: idNum })
  .strict();
const planParams = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const structureParams = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    sid: z.coerce.number().int().positive().max(MAX_INT),
  })
  .strict();
const rowsParams = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    sid: z.union([z.literal('default'), z.coerce.number().int().positive().max(MAX_INT)]),
  })
  .strict();
const rowsQuery = z.object({ ...filterShape, ...scenarioShape }).strict();
const ticketsBody = z
  .object({
    ids: z.array(idNum).max(MAX_GRID_IDS),
    fields: z.union([z.string().max(4000), z.array(z.string().max(100)).max(200)]).optional(),
  })
  .strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const prefixed = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [`spec.${k}`, v]));

const unreadable = (error: unknown) => error instanceof QueryError || error instanceof SearchError;

/** Each skeleton is numbered, so a page can drop an older answer that arrives after a newer one. */
let generations = Date.now();

export interface PlanStructureOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

interface StructureRow {
  id: number;
  name: string;
  spec: StructureSpec;
  updated_at: Date;
  version: number;
}

/** A ticket's facts as the tree needs them. */
interface InfoRow {
  id: number;
  key: string;
  rank: string;
  track_id: number;
  level: number;
  parent_id: number | null;
  closed: boolean;
  in_plan: boolean;
}

/** A ticket as a value row reads it, the fields asked for only. */
interface ValueRow {
  id: number;
  track_id: number;
  ticket_type_id: number;
  parent_id: number | null;
  summary: string;
  due_date: string | null;
  start_date: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  original_estimate: number | null;
  remaining_estimate: number | null;
  time_spent: number;
  fields: Record<string, unknown>;
}

const SYSTEM_BY_ID = new Map(SYSTEM_REFS.map((s) => [s.id, s]));

/** A value as formulas read it: dates as day numbers, durations in seconds; null where empty. */
function readValue(catalog: Catalog, row: ValueRow, ref: string): number | string | null {
  const system = SYSTEM_BY_ID.get(ref);
  if (system) {
    const v = system.read({ ...row, fields: {} } as Parameters<typeof system.read>[0]);
    return typeof v === 'boolean' ? null : v;
  }
  const m = /^cf\[(\d{1,10})\]$/.exec(ref);
  const field = m ? catalog.fields.get(Number(m[1])) : undefined;
  if (!field) return null;
  const stored = row.fields[String(field.id)];
  if (stored === undefined || stored === null) return null;
  if (!catalog.contextOf(field.id, row.track_id, row.ticket_type_id)) return null;
  const type = readableType(field);
  if (type === 'date') return typeof stored === 'string' ? dayOfIso(stored) : null;
  if (type === 'text') return typeof stored === 'string' ? stored : null;
  return typeof stored === 'number' ? stored : null;
}

const structureView = (s: StructureRow, broken: boolean) => ({
  id: s.id,
  name: s.name,
  spec: s.spec,
  updatedAt: s.updated_at,
  version: s.version,
  broken,
});

export function registerPlanStructureRoutes(
  app: FastifyInstance,
  db: Db,
  options: PlanStructureOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  const structureRows = (ws: number, planId: number) =>
    db
      .selectFrom('plan_structure')
      .select(['id', 'name', 'spec', 'updated_at', 'version'])
      .where('workspace_id', '=', ws)
      .where('plan_id', '=', planId);

  const structureOf = async (ws: number, planId: number, sid: number) =>
    (await structureRows(ws, planId).where('id', '=', sid).executeTakeFirst()) as
      | StructureRow
      | undefined;

  /**
   * Opens a plan the person sees, with whether they may change it: 401, or 404 for a plan not
   * seen, word for word as a missing id. Writes then answer 403 `edit_plan` to readers.
   */
  async function openPlan(request: FastifyRequest, reply: FastifyReply, id: number) {
    const user = requireUser(request, reply);
    if (!user) return null;
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select(['p.id', 'p.name', 'p.owner_id'])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', id);
    if (!(await request.authz.isSiteAdmin())) q = q.where(planVisible(ws, user.id));
    const found = await q.executeTakeFirst();
    if (!found) {
      await notFound(reply);
      return null;
    }
    const plan = { ...found, editable: await planEditable(request, found.owner_id) };
    return { user, plan };
  }

  /** The workspace's fields and link types, as checks need them. */
  async function checkContext(ws: number): Promise<CheckContext> {
    const catalog = await options.catalogs.get(ws);
    const types = await db
      .selectFrom('link_type')
      .select('id')
      .where('workspace_id', '=', ws)
      .execute();
    return { catalog, linkTypeIds: new Set(types.map((t) => t.id)) };
  }

  /** The Add tickets step's query for this reader, or why it does not run for them. */
  async function stepQuery(
    scope: Scope,
    spec: StructureSpec,
  ): Promise<{ cond: RawBuilder<boolean> | null } | { problem: StructureProblem }> {
    const index = spec.steps.findIndex((s) => s.kind === 'insert');
    const step = spec.steps[index];
    const text = step?.kind === 'insert' ? (step.query ?? '').trim() : '';
    if (text === '') return { cond: null };
    try {
      return { cond: await compileCondition(db, scope, text, new Date()) };
    } catch (error) {
      if (!unreadable(error)) throw error;
      return {
        problem: {
          path: `steps.${index}.query`,
          reason: 'invalid_query',
          message: (error as Error).message,
        },
      };
    }
  }

  /** Field errors of a spec as saved, or the checked spec; a query compiled as the editor. */
  async function checked(request: FastifyRequest, reply: FastifyReply, spec: StructureSpec) {
    const ws = request.workspaceId;
    const result = checkStructure(spec, await checkContext(ws));
    if (!result.ok) {
      await reply.code(400).send({
        error: 'invalid_fields',
        fields: prefixed(result.fields),
        ...(result.check ? { check: result.check } : {}),
      });
      return null;
    }
    const insert = result.spec.steps.find((s) => s.kind === 'insert');
    const text = insert?.kind === 'insert' ? (insert.query ?? '').trim() : '';
    if (text !== '') {
      try {
        await compileCondition(
          db,
          await planScope(db, options.catalogs, request),
          text,
          new Date(),
        );
      } catch (error) {
        await searchRefusal(reply, error, timeoutMs);
        return null;
      }
    }
    return result.spec;
  }

  const nameTaken = async (trx: Trx, planId: number, name: string, except: number | null) => {
    let q = trx
      .selectFrom('plan_structure')
      .select('id')
      .where('plan_id', '=', planId)
      .where(sql<boolean>`lower(name) = lower(${name})`);
    if (except !== null) q = q.where('id', '<>', except);
    return (await q.executeTakeFirst()) !== undefined;
  };

  app.get('/api/v1/plans/:id/structures', async (request, reply) => {
    const p = planParams.safeParse(request.params);
    if (!p.success) {
      if (!requireUser(request, reply)) return reply;
      return notFound(reply);
    }
    const o = await openPlan(request, reply, p.data.id);
    if (!o) return reply;
    const ws = request.workspaceId;
    const rows = (await structureRows(ws, o.plan.id)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute()) as StructureRow[];
    const ctx = await checkContext(ws);
    const scope = await planScope(db, options.catalogs, request);
    const structures = [];
    for (const row of rows) {
      const resolved = resolveStructure(row.spec, ctx);
      const query = await stepQuery(scope, row.spec);
      structures.push(structureView(row, resolved.problems.length > 0 || 'problem' in query));
    }
    return {
      plan: { id: o.plan.id, name: o.plan.name },
      editable: o.plan.editable,
      structures,
      default: DEFAULT_STRUCTURE,
      limits: STRUCTURE_LIMITS,
    };
  });

  app.post('/api/v1/plans/:id/structures', async (request, reply) => {
    const p = planParams.safeParse(request.params);
    if (!p.success) {
      if (!requireUser(request, reply)) return reply;
      return notFound(reply);
    }
    const o = await openPlan(request, reply, p.data.id);
    if (!o) return reply;
    if (!o.plan.editable)
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const spec = await checked(request, reply, parsed.data.spec);
    if (!spec) return reply;
    const ws = request.workspaceId;
    const name = parsed.data.name;
    const outcome = await db.transaction().execute(async (trx) => {
      // The plan's row orders saves, so two never pass the limit or take one name together.
      await lockPlan(trx, o.plan.id);
      const held = await trx
        .selectFrom('plan_structure')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('plan_id', '=', o.plan.id)
        .executeTakeFirstOrThrow();
      if (Number(held.n) >= MAX_STRUCTURES) {
        return { refused: 'too_many_structures' as const };
      }
      if (await nameTaken(trx, o.plan.id, name, null)) return { taken: true as const };
      const made = await trx
        .insertInto('plan_structure')
        .values({
          workspace_id: ws,
          plan_id: o.plan.id,
          name,
          spec: JSON.stringify(spec),
          created_by: o.user.id,
          updated_by: o.user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'plan.structure_created',
        subjectId: o.plan.id,
        payload: { structureId: made.id, name },
      });
      return { id: made.id };
    });
    if ('refused' in outcome) {
      return reply.code(409).send({ error: outcome.refused, limit: MAX_STRUCTURES });
    }
    if ('taken' in outcome) return reply.code(409).send({ error: 'name_taken' });
    const row = (await structureOf(ws, o.plan.id, outcome.id)) as StructureRow;
    return reply.code(201).send({ structure: structureView(row, false) });
  });

  /** Opens a structure of a plan for a write; 404 for one missing or of another plan. */
  async function openStructure(request: FastifyRequest, reply: FastifyReply) {
    const p = structureParams.safeParse(request.params);
    if (!p.success) {
      if (!requireUser(request, reply)) return null;
      await notFound(reply);
      return null;
    }
    const o = await openPlan(request, reply, p.data.id);
    if (!o) return null;
    const structure = await structureOf(request.workspaceId, o.plan.id, p.data.sid);
    if (!structure) {
      await notFound(reply);
      return null;
    }
    if (!o.plan.editable) {
      await reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
      return null;
    }
    return { ...o, structure };
  }

  app.patch('/api/v1/plans/:id/structures/:sid', async (request, reply) => {
    const o = await openStructure(request, reply);
    if (!o) return reply;
    const parsed = changeBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    let spec: StructureSpec | undefined;
    if (parsed.data.spec !== undefined) {
      const ok = await checked(request, reply, parsed.data.spec);
      if (!ok) return reply;
      spec = ok;
    }
    const outcome = await db.transaction().execute(async (trx) => {
      await lockPlan(trx, o.plan.id);
      const locked = await trx
        .selectFrom('plan_structure')
        .select(['name', 'spec', 'version'])
        .where('id', '=', o.structure.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== parsed.data.version) return { conflict: locked.version };
      const next = { name: parsed.data.name ?? locked.name, spec: spec ?? locked.spec };
      const changes = diff(
        { name: locked.name, spec: JSON.stringify(locked.spec) },
        { name: next.name, spec: JSON.stringify(next.spec) },
      );
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      if (await nameTaken(trx, o.plan.id, next.name, o.structure.id))
        return { taken: true as const };
      await trx
        .updateTable('plan_structure')
        .set({
          name: next.name,
          spec: JSON.stringify(next.spec),
          version: locked.version + 1,
          updated_by: o.user.id,
          updated_at: new Date(),
        })
        .where('id', '=', o.structure.id)
        .execute();
      await emit(trx, by(request), {
        type: 'plan.structure_changed',
        subjectId: o.plan.id,
        payload: { structureId: o.structure.id, name: next.name },
      });
      return { changed: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    if ('taken' in outcome) return reply.code(409).send({ error: 'name_taken' });
    const row = (await structureOf(request.workspaceId, o.plan.id, o.structure.id)) as StructureRow;
    return { structure: structureView(row, false) };
  });

  app.delete('/api/v1/plans/:id/structures/:sid', async (request, reply) => {
    const o = await openStructure(request, reply);
    if (!o) return reply;
    const q = versionQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan_structure')
        .select(['name', 'version'])
        .where('id', '=', o.structure.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== q.data.version) return { conflict: locked.version };
      await trx.deleteFrom('plan_structure').where('id', '=', o.structure.id).execute();
      await emit(trx, by(request), {
        type: 'plan.structure_deleted',
        subjectId: o.plan.id,
        payload: { structureId: o.structure.id, name: locked.name },
      });
      return { deleted: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    return reply.code(204).send();
  });

  app.get('/api/v1/plans/:id/structures/:sid/rows', async (request, reply) => {
    const p = rowsParams.safeParse(request.params);
    if (!p.success) {
      if (!requireUser(request, reply)) return reply;
      return notFound(reply);
    }
    const o = await openPlan(request, reply, p.data.id);
    if (!o) return reply;
    const ws = request.workspaceId;
    let saved: StructureRow | null = null;
    if (p.data.sid !== 'default') {
      saved = (await structureOf(ws, o.plan.id, p.data.sid)) ?? null;
      if (!saved) return notFound(reply);
    }
    const q = rowsQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const { scenario: scenarioParam, ...filters } = q.data;
    const spec = saved?.spec ?? DEFAULT_STRUCTURE;
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [o.plan.id]),
        filters,
      );
      const scenario = await viewScenario(db, ws, o.plan.id, scenarioParam, tickets.unfiltered);
      if (scenario === 'not_found') return invalidFields(reply, { scenario: 'not_found' });
      const ctx = await checkContext(ws);
      const catalog = ctx.catalog;
      const resolved = resolveStructure(spec, ctx);
      const query = await stepQuery(tickets.scope, spec);
      const problems = [...resolved.problems, ...('problem' in query ? [query.problem] : [])];
      const env = await formulaEnv(db, { ...formulaPlan(catalog), workingWeek: true }, ws);
      const today = dayOfIso(todayIn(request.user?.timeZone ?? null)) ?? env.today;
      const head = {
        plan: { id: o.plan.id, name: o.plan.name },
        structure: saved
          ? { id: saved.id, name: saved.name, spec: saved.spec, version: saved.version }
          : { id: null, name: null, spec, version: null },
        ...(scenario ? { scenario: { id: scenario.id, name: scenario.name }, live: true } : {}),
        editable: o.plan.editable,
        broken: problems.length > 0,
        problems,
        query: tickets.query,
        generation: ++generations,
        today,
        workingWeek: env.workingWeek,
        fields: resolved.reads,
      };
      const where = tickets.where;
      const unfiltered = tickets.unfiltered;
      if (!where || !unfiltered || 'problem' in query) {
        return { ...head, ...emptySkeleton(resolved.reads) };
      }
      const narrowed = query.cond ? sql<boolean>`(${where} AND ${query.cond})` : where;
      // The reader's tickets of any track: children and linked tickets beyond the plan.
      const seen = await compileQuery(db, tickets.scope, '', new Date());
      const read = await readOnly(db, timeoutMs, (trx) =>
        readSkeleton(trx, {
          ws,
          scope: tickets.scope,
          catalog,
          where: narrowed,
          unfiltered,
          seen,
          steps: resolved.steps.map((s) => s.step),
          reads: resolved.reads,
        }),
      );
      return { ...head, ...read };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/plans/:id/grid/tickets', async (request, reply) => {
    const p = planParams.safeParse(request.params);
    if (!p.success) {
      if (!requireUser(request, reply)) return reply;
      return notFound(reply);
    }
    const o = await openPlan(request, reply, p.data.id);
    if (!o) return reply;
    const parsed = ticketsBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const shape = projection(parsed.data.fields);
    if (typeof shape === 'string') return invalidFields(reply, { fields: 'unknown_field' });
    // Each ticket carries its version, so an edit from the grid keeps the 409.
    shape?.keys.add('version');
    try {
      const scope = await planScope(db, options.catalogs, request);
      const seen = await compileQuery(db, scope, '', new Date());
      const ids = [...new Set(parsed.data.ids)];
      const views = await searchViews(db, options.catalogs, request, ids, seen);
      return { tickets: views.map((v) => project(v, shape)) };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}

/** A skeleton with no rows. */
function emptySkeleton(reads: readonly ReadField[]) {
  return {
    total: 0,
    more: false,
    rows: {
      ticket: [],
      key: [],
      parent: [],
      depth: [],
      level: [],
      track: [],
      inPlan: [],
      via: [],
      closed: [],
      notShown: [],
      elsewhere: [],
    },
    groups: [],
    values: Object.fromEntries(reads.map((r) => [r.ref, []])),
  };
}

interface SkeletonInput {
  ws: number;
  scope: Scope;
  catalog: Catalog;
  /** The Add tickets step: the plan with the page's filters and the step's query. */
  where: RawBuilder<boolean>;
  /** The plan without the filters: whether a row is in the plan. */
  unfiltered: RawBuilder<boolean>;
  /** Every ticket the reader may see. */
  seen: RawBuilder<boolean>;
  steps: StructureSpec['steps'];
  reads: readonly ReadField[];
}

const counts = (rows: { id: number; n: number }[]) => new Map(rows.map((r) => [r.id, r.n]));

/** The skeleton, read in the caller's read-only transaction. */
async function readSkeleton(trx: Trx, input: SkeletonInput) {
  const { ws, seen, steps } = input;
  // 1. Add tickets: by rank and id, one past the limit.
  const chosen = (
    await sql<{ id: number }>`
      SELECT k.id FROM ticket k WHERE ${input.where} ORDER BY k.rank, k.id
       LIMIT ${GRID_ROWS + 1}`.execute(trx)
  ).rows.map((r) => r.id);
  let more = chosen.length > GRID_ROWS;
  const inserted = chosen.slice(0, GRID_ROWS);
  const candidates = new Set(inserted);

  // 2. Add children: every visible descendant down the guard's levels, a visited path besides it;
  // inserted tickets start their own walk. Then the hidden live children of each expanded row.
  let children: ExpandLevel | null = null;
  const childEdges: { id: number; parent: number }[] = [];
  if (steps.some((s) => s.kind === 'children') && inserted.length > 0) {
    const walk = (
      await sql<{ id: number; parent: number; depth: number }>`
        WITH RECURSIVE ins AS MATERIALIZED (SELECT unnest(${inserted}::int[]) AS id),
        walk (id, parent, depth, path) AS (
          SELECT k.id, k.parent_id, 1, ARRAY[k.parent_id, k.id]
            FROM ticket k
           WHERE k.parent_id IN (SELECT id FROM ins) AND k.id NOT IN (SELECT id FROM ins)
             AND ${seen}
          UNION ALL
          SELECT k.id, k.parent_id, w.depth + 1, w.path || k.id
            FROM walk w JOIN ticket k ON k.parent_id = w.id
           WHERE w.depth < ${CHILD_LEVELS}::int AND k.id <> ALL(w.path)
             AND k.id NOT IN (SELECT id FROM ins) AND ${seen}
        )
        SELECT id, parent, depth FROM walk LIMIT ${GRID_ROWS + 1}`.execute(trx)
    ).rows;
    if (walk.length > GRID_ROWS) more = true;
    for (const w of walk.slice(0, GRID_ROWS)) {
      candidates.add(w.id);
      childEdges.push({ id: w.id, parent: w.parent });
    }
    const expandable = [
      ...inserted,
      ...walk.filter((w) => w.depth < CHILD_LEVELS).map((w) => w.id),
    ];
    const hidden = (
      await sql<{ id: number; n: number }>`
        SELECT k.parent_id AS id, count(*)::int AS n
          FROM ticket k
         WHERE k.workspace_id = ${ws}::int AND k.parent_id = ANY(${expandable}::int[])
           AND k.deleted_at IS NULL AND (${seen}) IS NOT TRUE
         GROUP BY k.parent_id`.execute(trx)
    ).rows;
    children = { edges: new Map(), hidden: counts(hidden), depth: CHILD_LEVELS };
  }

  // 3. Add linked tickets: per step, the visible tickets linked by its type in its direction from
  // every possible row, `depth` levels down, a ticket on the path stopping it; then the hidden ones.
  const links: ExpandLevel[] = [];
  for (const step of steps.filter((s): s is LinksStep => s.kind === 'links')) {
    const start = [...candidates];
    const [from, to] =
      step.direction === 'outward'
        ? [sql.ref('l.source_id'), sql.ref('l.target_id')]
        : [sql.ref('l.target_id'), sql.ref('l.source_id')];
    const reached =
      start.length === 0
        ? []
        : (
            await sql<{ src: number; dst: number; depth: number }>`
              WITH RECURSIVE start AS MATERIALIZED (SELECT unnest(${start}::int[]) AS id),
              walk (src, dst, depth, path) AS (
                SELECT ${from}, ${to}, 1, ARRAY[${from}, ${to}]
                  FROM ticket_link l JOIN ticket k ON k.id = ${to}
                 WHERE l.workspace_id = ${ws}::int AND l.link_type_id = ${step.linkTypeId}::int
                   AND ${from} IN (SELECT id FROM start) AND ${to} <> ${from} AND ${seen}
                UNION ALL
                SELECT ${from}, ${to}, w.depth + 1, w.path || ${to}
                  FROM walk w
                  JOIN ticket_link l ON ${from} = w.dst AND l.link_type_id = ${step.linkTypeId}::int
                  JOIN ticket k ON k.id = ${to}
                 WHERE w.depth < ${step.depth}::int AND w.dst NOT IN (SELECT id FROM start)
                   AND ${to} <> ALL(w.path) AND ${seen}
              )
              SELECT src, dst, min(depth)::int AS depth FROM walk GROUP BY src, dst
               LIMIT ${GRID_ROWS + 1}`.execute(trx)
          ).rows;
    if (reached.length > GRID_ROWS) more = true;
    const edges = new Map<number, number[]>();
    const expandable = new Set(start);
    for (const r of reached.slice(0, GRID_ROWS)) {
      edges.set(r.src, [...(edges.get(r.src) ?? []), r.dst]);
      if (r.depth < step.depth) expandable.add(r.dst);
    }
    for (const r of reached.slice(0, GRID_ROWS)) candidates.add(r.dst);
    const hidden =
      expandable.size === 0
        ? []
        : (
            await sql<{ id: number; n: number }>`
              SELECT ${from} AS id, count(*)::int AS n
                FROM ticket_link l JOIN ticket k ON k.id = ${to}
               WHERE l.workspace_id = ${ws}::int AND l.link_type_id = ${step.linkTypeId}::int
                 AND ${from} = ANY(${[...expandable]}::int[])
                 AND k.deleted_at IS NULL AND (${seen}) IS NOT TRUE
               GROUP BY 1`.execute(trx)
          ).rows;
    links.push({ edges, hidden: counts(hidden), depth: step.depth });
  }

  // The facts of every ticket a step may place.
  const ids = [...candidates];
  const info =
    ids.length === 0
      ? []
      : (
          await sql<InfoRow>`
            SELECT k.id, t.key || '-' || k.number AS key, k.rank, k.track_id, h.rank AS level,
                   k.parent_id, s.stage = 'closed' AS closed,
                   COALESCE(${input.unfiltered}, false) AS in_plan
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
             WHERE k.id = ANY(${ids}::int[])`.execute(trx)
        ).rows;
  const tickets = new Map<number, TreeTicket>(
    info.map((r) => [
      r.id,
      {
        id: r.id,
        // Only an inserted parent nests a row; any other is reached by a step, or none.
        parent: r.parent_id,
        rank: r.rank,
        key: r.key,
        track: r.track_id,
        level: r.level,
        inPlan: r.in_plan,
        closed: r.closed,
      },
    ]),
  );
  if (children) {
    const edges = new Map<number, number[]>();
    const add = (parent: number, id: number) =>
      edges.set(parent, [...(edges.get(parent) ?? []), id]);
    for (const e of childEdges) add(e.parent, e.id);
    // An inserted ticket under a ticket the walk reached: that row reaches it, and counts it as
    // shown elsewhere.
    const walked = new Set(childEdges.map((e) => e.id));
    for (const id of inserted) {
      const parent = tickets.get(id)?.parent ?? null;
      if (parent !== null && walked.has(parent)) add(parent, id);
    }
    children = { ...children, edges };
  }

  // Group by: each inserted ticket's value and the values' names.
  const groups: GroupLevel[] = [];
  for (const step of steps) {
    if (step.kind !== 'group' || inserted.length === 0) continue;
    const axis = parseAxis(step.field, input.scope);
    if (typeof axis === 'string') continue;
    const values = (
      await sql<{ id: number; v: string | null }>`
        SELECT k.id, (${axisValues(axis)})[1] AS v FROM ticket k
         WHERE k.id = ANY(${inserted}::int[])`.execute(trx)
    ).rows;
    const distinct = [...new Set(values.flatMap((r) => (r.v === null ? [] : [r.v])))];
    const named = await axisNames(trx, ws, axis, distinct);
    groups.push({
      field: step.field,
      values: new Map(values.map((r) => [r.id, r.v])),
      labels: new Map(distinct.map((v) => [v, named.get(v)?.name ?? ''])),
    });
  }

  const built = buildStructure({
    tickets,
    inserted,
    groups,
    children,
    links,
    limit: GRID_ROWS,
  });

  // Values of the fields totals and formulas read, on ticket rows only.
  const values: Record<string, (number | string | null)[]> = {};
  for (const r of input.reads) values[r.ref] = built.rows.ticket.map(() => null);
  const rowTickets = built.rows.ticket.filter((t) => t !== 0);
  if (input.reads.length > 0 && rowTickets.length > 0) {
    const customKeys = input.reads.flatMap((r) => {
      const m = /^cf\[(\d{1,10})\]$/.exec(r.ref);
      return m ? [m[1] as string] : [];
    });
    const rows = (
      await sql<ValueRow>`
        SELECT k.id, k.track_id, k.ticket_type_id, k.parent_id, k.summary,
               k.due_date::text AS due_date, k.start_date::text AS start_date, k.created_at,
               k.updated_at, k.closed_at, k.original_estimate, k.remaining_estimate, k.time_spent,
               COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(k.fields) e
                          WHERE e.key = ANY(${customKeys}::text[])), '{}'::jsonb) AS fields
          FROM ticket k
         WHERE k.id = ANY(${rowTickets}::int[])`.execute(trx)
    ).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    built.rows.ticket.forEach((t, i) => {
      const row = byId.get(t);
      if (!row) return;
      for (const r of input.reads) {
        (values[r.ref] as (number | string | null)[])[i] = readValue(input.catalog, row, r.ref);
      }
    });
  }
  return {
    total: built.total,
    more: more || built.more,
    rows: built.rows,
    groups: built.groups,
    values,
  };
}
