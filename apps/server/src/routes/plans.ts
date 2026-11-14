import type { Database, PlanCapacityUnit } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { planEditable } from '../plans/access';
import { dependencyOptions, linkTypesNamed } from '../plans/dependencies';
import {
  createBody,
  duplicateBody,
  EXPORT_SORTS,
  exportQuery,
  filterQuery,
  idParam,
  listQuery,
  MAX_SOURCES,
  type PlanFilters,
  type SourceInput,
  sourceKey,
  updateBody,
} from '../plans/model';
import { samePeriods } from '../plans/periods';
import {
  browsedTracks,
  type PlanTickets,
  planScope,
  planTickets,
  type SourceRow,
  sourceRows,
  viewerSources,
} from '../plans/query';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { savedSearchVisible } from '../search/saved';
import {
  checkShares,
  PLAN_SHARES,
  type ShareInput,
  sharedWith,
  shareKey,
  sharesOf,
  writeShares,
} from '../sharing/shares';
import { searchRefusal } from './search';
import { sendTicketExport } from './search-export';

/**
 * Multi-track plans (T-088; PLN-001, PLN-012; ADR-122).
 *
 * - `GET /api/v1/plans` lists those the person sees (`?filter=mine`); `POST` makes one;
 *   `GET`, `PATCH` and `DELETE /api/v1/plans/:id` read, change and remove one.
 * - A plan is seen by its owner and those its shares reach (a dashboard's scopes, without
 *   `public`); site administrators see every one. One the person cannot see answers 404. Its
 *   owner and site administrators change and delete it; sharing needs "Share dashboards and
 *   saved searches". A change carries the version read, and a stale one answers 409.
 * - Sources are tracks and saved searches. Each person sees only the sources they may see
 *   (`plans/query.ts`), and a change of sources replaces those, keeping the ones hidden from the
 *   editor. Adding one the editor cannot see answers `not_found` for it, as for none.
 * - `GET /api/v1/plans/:id` takes the views' filters and answers the plan's `query` with them,
 *   the search a List runs; `GET /api/v1/plans/:id/choices` is what the filters offer: the
 *   plan's tracks, ticket types and up to 50 assignees, counted in one statement.
 * - `POST /api/v1/plans/:id/duplicate` copies a plan for anyone who sees it (PLN-014): the sources
 *   they may see, the settings, the teams and the Grid's structures; never hidden sources (only
 *   counted), shares or capacity. The copy is private to them and has no tie to the original.
 * - `GET /api/v1/plans/:id/export` is the List's file (PLN-014): every ticket of the plan the person
 *   sees, through the search export's stream.
 *
 * Every view reads the plan's tickets as the viewer (`routes/plan-views.ts`). Each write emits
 * one `plan.*` event in its transaction.
 */
type Db = Kysely<Database> | Transaction<Database>;
type Row = {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  owner_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  capacity_unit: PlanCapacityUnit;
  period_kind: 'weeks' | 'month';
  period_weeks: number;
  period_anchor: string;
};

/** The plan's periods as the API says them (PLN-005). */
export const periodOf = (row: Pick<Row, 'period_kind' | 'period_weeks' | 'period_anchor'>) =>
  row.period_kind === 'month'
    ? ({ kind: 'month' } as const)
    : ({ kind: 'weeks', weeks: row.period_weeks, anchor: row.period_anchor } as const);

/** A plan's name as a file's: safe characters only, as release notes do; never empty. */
export const planFile = (name: string) => {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${safe || 'plan'}-list`;
};

/** How many assignees the filters offer; the rest are reached by a search. */
const CHOICE_PEOPLE = 50;

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const forbidden = (reply: FastifyReply, permission: string) =>
  reply.code(403).send({ error: 'forbidden', permission });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

/** Whether plan `p` is visible to the person: theirs, or shared with them. */
export function planVisible(ws: number, userId: number): RawBuilder<boolean> {
  return sql<boolean>`(p.owner_id = ${userId} OR ${sharedWith(PLAN_SHARES, sql<number>`p.id`, ws, userId)})`;
}

/**
 * The site teams a plan plans with, in order (PLN-005). Everyone signed in reads teams and their
 * members (ADR-076), so naming them adds nothing a viewer could not already read.
 */
export async function planTeams(db: Db, planId: number): Promise<{ id: number; name: string }[]> {
  return db
    .selectFrom('plan_team as pt')
    .innerJoin('team as t', 't.id', 'pt.team_id')
    .select(['t.id', 't.name'])
    .where('pt.plan_id', '=', planId)
    .orderBy('pt.position')
    .orderBy('t.id')
    .execute();
}

export interface PlanRouteOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

/** A source row as the input that would make it, for comparing and keeping. */
const inputOf = (r: SourceRow): SourceInput =>
  r.kind === 'track'
    ? { kind: 'track', trackId: r.track_id as number }
    : { kind: 'savedSearch', savedSearchId: r.saved_search_id as number };

export function registerPlanRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: PlanRouteOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  const rows = (trx: Db, ws: number) =>
    trx
      .selectFrom('plan as p')
      .innerJoin('app_user as o', 'o.id', 'p.owner_id')
      .select([
        'p.id',
        'p.name',
        'p.description',
        'p.owner_id',
        'o.name as owner_name',
        'p.version',
        'p.created_at',
        'p.updated_at',
        'p.capacity_unit',
        'p.period_kind',
        'p.period_weeks',
        'p.period_anchor',
      ])
      .where('p.workspace_id', '=', ws);

  /** The plan when the person sees it (site administrators see every one). */
  async function visible(request: FastifyRequest, id: number): Promise<Row | undefined> {
    const userId = request.user?.id as number;
    const ws = request.workspaceId;
    let q = rows(db, ws).where('p.id', '=', id);
    if (!(await request.authz.isSiteAdmin())) q = q.where(planVisible(ws, userId));
    return q.executeTakeFirst() as Promise<Row | undefined>;
  }

  /**
   * The plan's capacity settings and teams (PLN-005) and its dependency options (PLN-013), the
   * same for every viewer: everyone signed in reads teams and link types.
   */
  async function settingsView(row: Row, ws: number) {
    const deps = await dependencyOptions(db, row.id);
    return {
      capacityUnit: row.capacity_unit,
      period: periodOf(row),
      teams: await planTeams(db, row.id),
      dependencies: {
        linkTypes: await linkTypesNamed(db, ws, deps.linkTypeIds),
        sameSprint: deps.sameSprint,
      },
    };
  }

  /** The plan as the API says it; with `tickets`, its sources as this viewer sees them. */
  async function view(request: FastifyRequest, row: Row, tickets: PlanTickets) {
    const shares = (await sharesOf(db, PLAN_SHARES, [row.id])).get(row.id) ?? [];
    return {
      ...(await settingsView(row, request.workspaceId)),
      id: row.id,
      name: row.name,
      description: row.description,
      owner: { id: row.owner_id, name: row.owner_name },
      shares,
      editable: await planEditable(request, row.owner_id),
      sources: tickets.sources,
      hiddenSources: tickets.hidden,
      query: tickets.query,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Checks the shares; true when refused and answered. */
  async function refuseShares(
    request: FastifyRequest,
    reply: FastifyReply,
    added: readonly ShareInput[],
    all: readonly ShareInput[],
  ): Promise<boolean> {
    const checked = await checkShares(db, request, added);
    if (checked.forbidden) {
      await forbidden(reply, 'share_saved_searches');
      return true;
    }
    const keys = all.map(shareKey);
    if (new Set(keys).size !== keys.length) checked.fields.shares = 'duplicate';
    if (Object.keys(checked.fields).length > 0) {
      await invalidFields(reply, checked.fields);
      return true;
    }
    return false;
  }

  /**
   * Field errors for sources: duplicates, and new ones the person may not see (`not_found`,
   * as for one that does not exist). `known` are those already in the plan.
   */
  async function sourceErrors(
    request: FastifyRequest,
    sources: readonly SourceInput[],
    known: ReadonlySet<string> = new Set(),
  ): Promise<Record<string, string>> {
    const fields: Record<string, string> = {};
    const keys = sources.map(sourceKey);
    if (new Set(keys).size !== keys.length) fields.sources = 'duplicate';
    const ws = request.workspaceId;
    const userId = request.user?.id as number;
    for (const [i, s] of sources.entries()) {
      if (known.has(sourceKey(s))) continue;
      if (s.kind === 'track') {
        const track = await db
          .selectFrom('track')
          .select('id')
          .where('id', '=', s.trackId)
          .where('workspace_id', '=', ws)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const held = track ? await request.authz.track(track.id) : null;
        if (!held?.has('browse_track')) fields[`sources.${i}.trackId`] = 'not_found';
      } else {
        const found = await db
          .selectFrom('saved_search as s')
          .select('s.id')
          .where('s.id', '=', s.savedSearchId)
          .where('s.workspace_id', '=', ws)
          .where(savedSearchVisible(ws, userId))
          .executeTakeFirst();
        if (!found) fields[`sources.${i}.savedSearchId`] = 'not_found';
      }
    }
    return fields;
  }

  async function writeSources(trx: Db, ws: number, planId: number, list: readonly SourceInput[]) {
    await trx.deleteFrom('plan_source').where('plan_id', '=', planId).execute();
    if (list.length === 0) return;
    await trx
      .insertInto('plan_source')
      .values(
        list.map((s, position) => ({
          workspace_id: ws,
          plan_id: planId,
          kind: s.kind === 'track' ? ('track' as const) : ('saved_search' as const),
          track_id: s.kind === 'track' ? s.trackId : null,
          saved_search_id: s.kind === 'savedSearch' ? s.savedSearchId : null,
          position,
        })),
      )
      .execute();
  }

  /** Field errors for a plan's teams: duplicates, and teams the workspace does not have. */
  async function teamErrors(ws: number, teams: readonly number[]) {
    const fields: Record<string, string> = {};
    if (new Set(teams).size !== teams.length) fields.teams = 'duplicate';
    const found = new Set(
      teams.length === 0
        ? []
        : (
            await db
              .selectFrom('team')
              .select('id')
              .where('workspace_id', '=', ws)
              .where('id', 'in', [...teams])
              .execute()
          ).map((t) => t.id),
    );
    for (const [i, id] of teams.entries()) if (!found.has(id)) fields[`teams.${i}`] = 'not_found';
    return fields;
  }

  /**
   * Field errors for the link types a plan counts (PLN-013): duplicates, types the workspace does
   * not have, and blocking ones, which are always counted.
   */
  async function dependencyErrors(ws: number, ids: readonly number[]) {
    const fields: Record<string, string> = {};
    if (new Set(ids).size !== ids.length) fields['dependencies.linkTypeIds'] = 'duplicate';
    const found = new Map(
      (ids.length === 0
        ? []
        : await db
            .selectFrom('link_type')
            .select(['id', 'outward'])
            .where('workspace_id', '=', ws)
            .where('id', 'in', [...ids])
            .execute()
      ).map((t) => [t.id, t.outward]),
    );
    for (const [i, id] of ids.entries()) {
      const outward = found.get(id);
      if (outward === undefined) fields[`dependencies.linkTypeIds.${i}`] = 'not_found';
      else if (outward.trim().toLowerCase() === 'blocks') {
        fields[`dependencies.linkTypeIds.${i}`] = 'always_counted';
      }
    }
    return fields;
  }

  async function writeDependencyTypes(trx: Db, ws: number, planId: number, ids: readonly number[]) {
    await trx.deleteFrom('plan_dependency_type').where('plan_id', '=', planId).execute();
    if (ids.length === 0) return;
    await trx
      .insertInto('plan_dependency_type')
      .values(ids.map((id) => ({ workspace_id: ws, plan_id: planId, link_type_id: id })))
      .execute();
  }

  /**
   * The plan's teams replaced, in order. Capacity set for a team that leaves goes with it, and so
   * does that of people who are in none of the teams left; both come back empty if they return.
   */
  async function writeTeams(
    trx: Db,
    ws: number,
    planId: number,
    teams: readonly number[],
  ): Promise<number> {
    await trx.deleteFrom('plan_team').where('plan_id', '=', planId).execute();
    if (teams.length > 0) {
      await trx
        .insertInto('plan_team')
        .values(
          teams.map((teamId, position) => ({
            workspace_id: ws,
            plan_id: planId,
            team_id: teamId,
            position,
          })),
        )
        .execute();
    }
    const kept = teams.length === 0 ? [0] : [...teams];
    const ofTeams = await trx
      .deleteFrom('plan_capacity')
      .where('plan_id', '=', planId)
      .where('team_id', 'is not', null)
      .where('team_id', 'not in', kept)
      .executeTakeFirst();
    const ofPeople = await trx
      .deleteFrom('plan_capacity')
      .where('plan_id', '=', planId)
      .where('user_id', 'is not', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('team_member as m')
              .select('m.user_id')
              .whereRef('m.user_id', '=', 'plan_capacity.user_id')
              .where('m.team_id', 'in', kept),
          ),
        ),
      )
      .executeTakeFirst();
    return Number(ofTeams.numDeletedRows) + Number(ofPeople.numDeletedRows);
  }

  /** The plan read again and answered, as the person sees it, with the filters. */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    row: Row,
    filters: PlanFilters = {},
  ) {
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [row.id]),
        filters,
      );
      return { plan: await view(request, row, tickets) };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  }

  const fresh = async (id: number, ws: number) =>
    (await rows(db, ws).where('p.id', '=', id).executeTakeFirstOrThrow()) as Row;

  app.get('/api/v1/plans', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = listQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const ws = request.workspaceId;
    let query = rows(db, ws).where(planVisible(ws, user.id));
    if (q.data.filter === 'mine') query = query.where('p.owner_id', '=', user.id);
    const list = (await query.orderBy(sql`lower(p.name)`).orderBy('p.id').execute()) as Row[];
    const shares = await sharesOf(
      db,
      PLAN_SHARES,
      list.map((r) => r.id),
    );
    const counts = new Map(
      list.length === 0
        ? []
        : (
            await db
              .selectFrom('plan_source')
              .select(['plan_id', sql<number>`count(*)::int`.as('n')])
              .where(
                'plan_id',
                'in',
                list.map((r) => r.id),
              )
              .groupBy('plan_id')
              .execute()
          ).map((r) => [r.plan_id, r.n]),
    );
    const admin = await request.authz.isSiteAdmin();
    return {
      plans: list.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        owner: { id: r.owner_id, name: r.owner_name },
        shares: shares.get(r.id) ?? [],
        editable: r.owner_id === user.id || admin,
        sourceCount: counts.get(r.id) ?? 0,
        version: r.version,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/v1/plans', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const fields = await sourceErrors(request, body.sources);
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const shares = body.shares ?? [];
    if (await refuseShares(request, reply, shares, shares)) return reply;
    const ws = request.workspaceId;
    const id = await db.transaction().execute(async (trx) => {
      const made = await trx
        .insertInto('plan')
        .values({
          workspace_id: ws,
          owner_id: user.id,
          name: body.name,
          description: body.description ?? '',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeSources(trx, ws, made.id, body.sources);
      await writeShares(trx, PLAN_SHARES, ws, made.id, shares);
      await emit(trx, by(request), {
        type: 'plan.created',
        subjectId: made.id,
        payload: {
          name: body.name,
          sources: body.sources.map(sourceKey),
          shares: shares.map(shareKey).sort(),
        },
      });
      return made.id;
    });
    const created = await answer(request, reply, await fresh(id, ws));
    return reply.code(201).send(created);
  });

  app.get('/api/v1/plans/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const f = filterQuery.safeParse(request.query ?? {});
    if (!f.success) return invalidFields(reply, shapeErrors(f.error));
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    return answer(request, reply, row, f.data);
  });

  // A copy for whoever sees the plan (PLN-014). What they may not see stays behind, only counted.
  app.post('/api/v1/plans/:id/duplicate', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = duplicateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const ws = request.workspaceId;
    // What they see of the sources is decided first: permissions read on their own connections.
    const scope = await planScope(db, options.catalogs, request);
    const seen = await viewerSources(db, request, scope, await sourceRows(db, [row.id]));
    const offered: SourceInput[] = seen.sources.map((s) =>
      s.kind === 'track'
        ? { kind: 'track', trackId: s.id }
        : { kind: 'savedSearch', savedSearchId: s.id },
    );
    // A plan copied never holds what its maker could not add by hand.
    const refused = await sourceErrors(request, offered);
    const allowed = new Set(
      offered
        .filter((_, i) => !Object.keys(refused).some((k) => k.startsWith(`sources.${i}.`)))
        .map(sourceKey),
    );
    const made = await db.transaction().execute(async (trx) => {
      const held = await trx
        .selectFrom('plan')
        .select(['description', 'capacity_unit', 'period_kind', 'period_weeks', 'period_anchor'])
        .where('id', '=', row.id)
        .forShare()
        .executeTakeFirst();
      if (!held) return null;
      // Read again under the lock: one added meanwhile was not decided on, so it stays behind.
      const current = await sourceRows(trx, [row.id]);
      const sources = current.map(inputOf).filter((s) => allowed.has(sourceKey(s)));
      const teams = (await planTeams(trx, row.id)).map((t) => t.id);
      const deps = await dependencyOptions(trx, row.id);
      const copy = await trx
        .insertInto('plan')
        .values({
          workspace_id: ws,
          owner_id: user.id,
          name: parsed.data.name,
          description: held.description,
          capacity_unit: held.capacity_unit,
          period_kind: held.period_kind,
          period_weeks: held.period_weeks,
          period_anchor: held.period_anchor,
          flag_same_sprint: deps.sameSprint,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeSources(trx, ws, copy.id, sources);
      await writeTeams(trx, ws, copy.id, teams);
      await writeDependencyTypes(trx, ws, copy.id, deps.linkTypeIds);
      // The Grid's structures go with the plan's settings (ADR-122 stage 10, question 15): recipes,
      // never tickets, so each reader of the copy still sees only their own rows.
      await sql`
        INSERT INTO plan_structure (workspace_id, plan_id, name, spec, created_by, updated_by)
        SELECT workspace_id, ${copy.id}::int, name, spec, ${user.id}::int, ${user.id}::int
          FROM plan_structure WHERE plan_id = ${row.id}::int ORDER BY id`.execute(trx);
      const hiddenSources = current.length - sources.length;
      await emit(trx, by(request), {
        type: 'plan.duplicated',
        subjectId: copy.id,
        payload: {
          name: parsed.data.name,
          from: row.id,
          sources: sources.map(sourceKey),
          teams,
          hiddenSources,
        },
      });
      return { id: copy.id, hiddenSources };
    });
    if (!made) return notFound(reply);
    const answered = await answer(request, reply, await fresh(made.id, ws));
    return reply.code(201).send({ ...answered, left: { hiddenSources: made.hiddenSources } });
  });

  // The List's file (PLN-014): composed here, as a plan's query can pass what an address holds.
  app.get('/api/v1/plans/:id/export', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = exportQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const { format, columns, sort, ...filters } = q.data;
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    let query: string | null;
    try {
      ({ query } = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [row.id]),
        filters,
      ));
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
    return sendTicketExport(db, options.catalogs, request, reply, {
      q: query === null ? null : `${query} ORDER BY ${EXPORT_SORTS[sort]}`,
      format,
      columns,
      file: planFile(row.name),
      timeoutMs,
    });
  });

  // What the filters offer: the plan's tracks, types and most frequent assignees (PLN-012).
  app.get('/api/v1/plans/:id/choices', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [row.id]),
      );
      const where = tickets.where;
      if (!where) return { tracks: [], types: [], assignees: [], unassigned: 0 };
      const counted = await readOnly(db, timeoutMs, async (trx) => {
        const { rows: groups } = await sql<{
          by_track: number;
          by_type: number;
          track_id: number | null;
          type_name: string | null;
          assignee_id: number | null;
          n: number;
        }>`
          SELECT GROUPING(k.track_id)::int AS by_track, GROUPING(y.name)::int AS by_type,
                 k.track_id, y.name AS type_name, k.assignee_id, count(*)::int AS n
            FROM ticket k JOIN ticket_type y ON y.id = k.ticket_type_id
           WHERE ${where}
           GROUP BY GROUPING SETS ((k.track_id), (y.name), (k.assignee_id))`.execute(trx);
        const trackIds = groups.flatMap((g) =>
          g.by_track === 0 && g.track_id !== null ? [g.track_id] : [],
        );
        const people = groups
          .filter((g) => g.by_track === 1 && g.by_type === 1 && g.assignee_id !== null)
          .sort((a, b) => b.n - a.n)
          .slice(0, CHOICE_PEOPLE);
        const names = await Promise.all([
          trackIds.length === 0
            ? []
            : trx
                .selectFrom('track')
                .select(['id', 'key', 'name'])
                .where('id', 'in', trackIds)
                .execute(),
          people.length === 0
            ? []
            : trx
                .selectFrom('app_user')
                .select(['id', 'name'])
                .where(
                  'id',
                  'in',
                  people.map((g) => g.assignee_id as number),
                )
                .execute(),
        ]);
        return { groups, people, tracks: names[0], users: names[1] };
      });
      const browses = await browsedTracks(request);
      const countOfTrack = new Map(
        counted.groups.filter((g) => g.by_track === 0).map((g) => [g.track_id, g.n]),
      );
      const userName = new Map(counted.users.map((u) => [u.id, u.name]));
      return {
        tracks: counted.tracks
          // A track known only from tickets the person may see by a ticket-level grant: its key.
          .map((t) => ({
            id: t.id,
            key: t.key,
            name: browses(t.id) ? t.name : null,
            count: countOfTrack.get(t.id) ?? 0,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        types: counted.groups
          .filter((g) => g.by_type === 0 && g.by_track === 1 && g.type_name !== null)
          .map((g) => ({ name: g.type_name as string, count: g.n }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        assignees: counted.people.map((g) => ({
          id: g.assignee_id as number,
          name: userName.get(g.assignee_id as number) ?? '',
          count: g.n,
        })),
        unassigned:
          counted.groups.find((g) => g.by_track === 1 && g.by_type === 1 && g.assignee_id === null)
            ?.n ?? 0,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.patch('/api/v1/plans/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = updateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await planEditable(request, row.owner_id))) return forbidden(reply, 'edit_plan');

    const current = await sourceRows(db, [row.id]);
    let sources: SourceInput[] | undefined;
    if (body.sources !== undefined) {
      // The editor's sources replace those they see; the ones hidden from them stay, after.
      const scope = await planScope(db, options.catalogs, request);
      const seen = await viewerSources(db, request, scope, current);
      const visibleKeys = new Set(
        seen.sources.map((s) =>
          sourceKey(
            s.kind === 'track'
              ? { kind: 'track', trackId: s.id }
              : { kind: 'savedSearch', savedSearchId: s.id },
          ),
        ),
      );
      const kept = current.map(inputOf).filter((s) => !visibleKeys.has(sourceKey(s)));
      // A source hidden from the editor answers exactly as one that does not exist, so a refusal
      // never says which hidden sources the plan holds.
      const fields = await sourceErrors(request, body.sources, visibleKeys);
      if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
      const given = new Set(body.sources.map(sourceKey));
      sources = [...body.sources, ...kept.filter((s) => !given.has(sourceKey(s)))];
      if (sources.length > MAX_SOURCES) return invalidFields(reply, { sources: 'too_many' });
    }
    const sharesBefore = (await sharesOf(db, PLAN_SHARES, [row.id])).get(row.id) ?? [];
    if (body.shares !== undefined) {
      const before = new Set(sharesBefore.map(shareKey));
      const added = body.shares.filter((s) => !before.has(shareKey(s)));
      if (await refuseShares(request, reply, added, body.shares)) return reply;
    }
    if (body.teams !== undefined) {
      const fields = await teamErrors(ws, body.teams);
      if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    }
    if (body.dependencies !== undefined) {
      const fields = await dependencyErrors(ws, body.dependencies.linkTypeIds);
      if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    }
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan')
        .select(['version', 'capacity_unit', 'period_kind', 'period_weeks', 'period_anchor'])
        .where('id', '=', row.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (body.version !== undefined && body.version !== locked.version) {
        return { conflict: locked.version };
      }
      const teamsBefore =
        body.teams === undefined ? [] : (await planTeams(trx, row.id)).map((t) => t.id);
      const depsBefore = await dependencyOptions(trx, row.id);
      const before = {
        name: row.name,
        description: row.description,
        sources: current.map((r) => sourceKey(inputOf(r))),
        shares: sharesBefore.map(shareKey).sort(),
        teams: teamsBefore,
        capacityUnit: locked.capacity_unit,
        period: periodOf(locked),
        dependencyTypes: depsBefore.linkTypeIds,
        sameSprint: depsBefore.sameSprint,
      };
      const after = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(sources !== undefined ? { sources: sources.map(sourceKey) } : {}),
        ...(body.shares !== undefined ? { shares: body.shares.map(shareKey).sort() } : {}),
        ...(body.teams !== undefined ? { teams: body.teams } : {}),
        ...(body.capacityUnit !== undefined ? { capacityUnit: body.capacityUnit } : {}),
        ...(body.period !== undefined ? { period: body.period } : {}),
        ...(body.dependencies !== undefined
          ? {
              dependencyTypes: [...body.dependencies.linkTypeIds].sort((a, b) => a - b),
              sameSprint: body.dependencies.sameSprint,
            }
          : {}),
      };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      // Amounts in one unit mean nothing in another, and a period's own capacity belongs to a
      // period that no longer exists: both are cleared, and the event says how many went. An
      // anchor moved by whole periods makes the same periods, so it clears nothing.
      const cleared = changes.capacityUnit
        ? await trx.deleteFrom('plan_capacity').where('plan_id', '=', row.id).executeTakeFirst()
        : body.period !== undefined && !samePeriods(periodOf(locked), body.period)
          ? await trx
              .deleteFrom('plan_capacity')
              .where('plan_id', '=', row.id)
              .where('period_start', 'is not', null)
              .executeTakeFirst()
          : null;
      let removed = Number(cleared?.numDeletedRows ?? 0);
      if (body.teams !== undefined && changes.teams) {
        removed += await writeTeams(trx, ws, row.id, body.teams);
      }
      if (removed > 0) changes.capacityCleared = { from: removed, to: 0 };
      await trx
        .updateTable('plan')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.capacityUnit !== undefined ? { capacity_unit: body.capacityUnit } : {}),
          ...(body.period !== undefined
            ? body.period.kind === 'month'
              ? { period_kind: 'month' as const }
              : {
                  period_kind: 'weeks' as const,
                  period_weeks: body.period.weeks,
                  period_anchor: body.period.anchor,
                }
            : {}),
          ...(body.dependencies !== undefined
            ? { flag_same_sprint: body.dependencies.sameSprint }
            : {}),
          version: locked.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      if (changes.dependencyTypes && body.dependencies !== undefined) {
        await writeDependencyTypes(trx, ws, row.id, body.dependencies.linkTypeIds);
      }
      if (sources !== undefined) await writeSources(trx, ws, row.id, sources);
      if (body.shares !== undefined) await writeShares(trx, PLAN_SHARES, ws, row.id, body.shares);
      await emit(trx, by(request), {
        type: 'plan.updated',
        subjectId: row.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    return answer(request, reply, await fresh(row.id, ws));
  });

  app.delete('/api/v1/plans/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await planEditable(request, row.owner_id))) return forbidden(reply, 'edit_plan');
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('plan').where('id', '=', row.id).execute();
      await emit(trx, by(request), {
        type: 'plan.deleted',
        subjectId: row.id,
        payload: { name: row.name },
      });
    });
    return reply.code(204).send();
  });
}
