import type { DashboardLayout, Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import {
  LAYOUTS,
  MAX_WIDGETS,
  readWidgets,
  storedWidgets,
  type Widget,
  widgetInput,
} from '../dashboards/model';
import { widgetData } from '../dashboards/widgets';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { DEFAULT_QUERY_TIMEOUT_MS } from '../search/run';
import {
  checkShares,
  DASHBOARD_SHARES,
  type ShareInput,
  sharedWith,
  shareInput,
  shareKey,
  sharesOf,
  writeShares,
} from '../sharing/shares';
import { searchRefusal } from './search';

/**
 * Dashboards (M1-064; RPT-004; ADR-060).
 *
 * - `GET /api/v1/dashboards` lists those the person sees (`?filter=mine`); `POST` makes one;
 *   `GET`, `PATCH` and `DELETE /api/v1/dashboards/:id` read, change and remove one;
 *   `POST /api/v1/dashboards/:id/copy` copies one the person sees as their own.
 * - A dashboard is seen by its owner, those its shares reach (the scopes of saved searches,
 *   ADR-053) and, for the default one, every signed-in person; anonymous visitors read public
 *   ones. One the person cannot see answers 404. Its owner changes and deletes it; site
 *   administrators may too, and only they give it to another owner. Sharing needs "Share
 *   dashboards and saved searches".
 * - `GET /api/v1/dashboards/default` is the home dashboard administrators chose, and
 *   `PUT /api/v1/dashboards/default` chooses it (site and configuration administrators). The
 *   default cannot be deleted while it is the default.
 * - Widgets are checked per kind on save (`dashboards/model.ts`); their data is read as the
 *   viewer, so a shared dashboard never shows a ticket the viewer may not browse (RPT-004 (1)).
 *
 * Each write emits one `dashboard.*` event in its transaction.
 */
const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const widgetParam = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    widgetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  })
  .strict();
const listQuery = z.object({ filter: z.enum(['visible', 'mine']).default('visible') }).strict();
const name = z.string().trim().min(1).max(255);
const createBody = z
  .object({
    name,
    description: z.string().max(4000).optional(),
    layout: z.enum(LAYOUTS).default('two'),
    widgets: z.array(widgetInput).max(MAX_WIDGETS).default([]),
    shares: z.array(shareInput).max(100).optional(),
  })
  .strict();
const updateBody = z
  .object({
    name: name.optional(),
    description: z.string().max(4000).optional(),
    layout: z.enum(LAYOUTS).optional(),
    widgets: z.array(widgetInput).max(MAX_WIDGETS).optional(),
    shares: z.array(shareInput).max(100).optional(),
    /** Site administrators: give the dashboard to another person. */
    ownerId: idNum.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
const copyBody = z.object({ name: name.optional() }).strict();
const defaultBody = z.object({ dashboardId: idNum.nullable() }).strict();

type Db = Kysely<Database> | Transaction<Database>;
type Row = {
  id: number;
  name: string;
  description: string;
  layout: DashboardLayout;
  widgets: unknown;
  is_default: boolean;
  owner_id: number;
  owner_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

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

/** Whether dashboard `d` is visible to the person (null: an anonymous visitor). */
export function dashboardVisible(ws: number, userId: number | null): RawBuilder<boolean> {
  const shared = sharedWith(DASHBOARD_SHARES, sql<number>`d.id`, ws, userId);
  if (userId === null) return shared;
  return sql<boolean>`(d.owner_id = ${userId} OR d.is_default OR ${shared})`;
}

export interface DashboardRouteOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: DashboardRouteOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  const rows = (trx: Db, ws: number) =>
    trx
      .selectFrom('dashboard as d')
      .innerJoin('app_user as o', 'o.id', 'd.owner_id')
      .select([
        'd.id',
        'd.name',
        'd.description',
        'd.layout',
        'd.widgets',
        'd.is_default',
        'd.owner_id',
        'o.name as owner_name',
        'd.version',
        'd.created_at',
        'd.updated_at',
      ])
      .where('d.workspace_id', '=', ws);

  async function view(request: FastifyRequest, list: Row[], full: boolean) {
    const userId = request.user?.id ?? null;
    const shares = await sharesOf(
      db,
      DASHBOARD_SHARES,
      list.map((r) => r.id),
    );
    const admin = userId !== null && (await request.authz.isSiteAdmin());
    return list.map((r) => {
      const widgets = storedWidgets(r.widgets);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        layout: r.layout,
        owner: { id: r.owner_id, name: r.owner_name },
        isDefault: r.is_default,
        shares: shares.get(r.id) ?? [],
        editable: userId !== null && (r.owner_id === userId || admin),
        ...(full ? { widgets } : { widgetCount: widgets.length }),
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  /** The dashboard when the person sees it (site administrators see every one). */
  async function visible(request: FastifyRequest, id: number): Promise<Row | undefined> {
    const userId = request.user?.id ?? null;
    const ws = request.workspaceId;
    const admin = userId !== null && (await request.authz.isSiteAdmin());
    let q = rows(db, ws).where('d.id', '=', id);
    if (!admin) q = q.where(dashboardVisible(ws, userId));
    return q.executeTakeFirst() as Promise<Row | undefined>;
  }

  async function mayManage(request: FastifyRequest, row: Row): Promise<boolean> {
    const userId = request.user?.id ?? null;
    if (userId === null) return false;
    return row.owner_id === userId || (await request.authz.isSiteAdmin());
  }

  /** Checks the shares; true when refused and answered. */
  async function refuseShares(
    request: FastifyRequest,
    reply: FastifyReply,
    shares: readonly ShareInput[],
    all: readonly ShareInput[] = shares,
  ): Promise<boolean> {
    const checked = await checkShares(db, request, shares);
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

  const fresh = async (request: FastifyRequest, id: number) => {
    const row = (await rows(db, request.workspaceId)
      .where('d.id', '=', id)
      .executeTakeFirstOrThrow()) as Row;
    return (await view(request, [row], true))[0];
  };

  app.get('/api/v1/dashboards', async (request, reply) => {
    const q = listQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const userId = request.user?.id ?? null;
    if (q.data.filter === 'mine' && userId === null) return { dashboards: [] };
    const ws = request.workspaceId;
    let query = rows(db, ws).where(dashboardVisible(ws, userId));
    if (q.data.filter === 'mine') query = query.where('d.owner_id', '=', userId as number);
    const list = (await query.orderBy(sql`lower(d.name)`).orderBy('d.id').execute()) as Row[];
    return { dashboards: await view(request, list, false) };
  });

  app.post('/api/v1/dashboards', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const read = readWidgets(body.widgets, body.layout);
    if ('fields' in read) return invalidFields(reply, read.fields);
    const shares = body.shares ?? [];
    if (await refuseShares(request, reply, shares)) return reply;
    const ws = request.workspaceId;
    const id = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('dashboard')
        .values({
          workspace_id: ws,
          owner_id: user.id,
          name: body.name,
          description: body.description ?? '',
          layout: body.layout,
          widgets: JSON.stringify(read.widgets),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeShares(trx, DASHBOARD_SHARES, ws, row.id, shares);
      await emit(trx, by(request), {
        type: 'dashboard.created',
        subjectId: row.id,
        payload: {
          name: body.name,
          widgets: read.widgets.map((w) => w.kind),
          shares: shares.map(shareKey).sort(),
        },
      });
      return row.id;
    });
    return reply.code(201).send({ dashboard: await fresh(request, id) });
  });

  // The administrators' home dashboard (RPT-004).
  app.get('/api/v1/dashboards/default', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const row = (await rows(db, request.workspaceId)
      .where('d.is_default', '=', true)
      .executeTakeFirst()) as Row | undefined;
    if (!row) return reply.code(404).send({ error: 'no_default' });
    return { dashboard: (await view(request, [row], true))[0] };
  });

  app.put('/api/v1/dashboards/default', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const global = await request.authz.global();
    if (!global.has('site_admin') && !global.has('configuration_admin')) {
      return forbidden(reply, 'configuration_admin');
    }
    const parsed = defaultBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const ws = request.workspaceId;
    const target = parsed.data.dashboardId;
    if (target !== null) {
      const exists = await db
        .selectFrom('dashboard')
        .select('id')
        .where('id', '=', target)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!exists) return invalidFields(reply, { dashboardId: 'not_found' });
    }
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('dashboard')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('is_default', '=', true)
        .forUpdate()
        .executeTakeFirst();
      if ((before?.id ?? null) === target) return;
      await trx
        .updateTable('dashboard')
        .set({ is_default: false })
        .where('workspace_id', '=', ws)
        .where('is_default', '=', true)
        .execute();
      if (target !== null) {
        await trx
          .updateTable('dashboard')
          .set({ is_default: true })
          .where('id', '=', target)
          .execute();
      }
      await emit(trx, by(request), {
        type: 'dashboard.default_set',
        subjectId: ws,
        payload: { dashboardId: target, previousId: before?.id ?? null },
      });
    });
    return { dashboardId: target };
  });

  app.get('/api/v1/dashboards/:id', async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    return { dashboard: (await view(request, [row], true))[0] };
  });

  // A widget's data, read as the viewer from its settings (RPT-004 (1); dashboards/widgets.ts).
  app.get('/api/v1/dashboards/:id/widgets/:widgetId', async (request, reply) => {
    const p = widgetParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const widget = storedWidgets(row.widgets).find((w) => w.id === p.data.widgetId);
    if (!widget) return notFound(reply);
    try {
      const data = await widgetData({ db, catalogs: options.catalogs, timeoutMs, request }, widget);
      return { widget: { id: widget.id, kind: widget.kind }, data };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.patch('/api/v1/dashboards/:id', async (request, reply) => {
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
    if (!(await mayManage(request, row))) return forbidden(reply, 'edit_dashboard');
    if (body.ownerId !== undefined && body.ownerId !== row.owner_id) {
      if (!(await request.authz.isSiteAdmin())) return forbidden(reply, 'site_admin');
      const owner = await db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', body.ownerId)
        .where('workspace_id', '=', ws)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst();
      if (!owner) return invalidFields(reply, { ownerId: 'not_found' });
    }
    const layout = body.layout ?? row.layout;
    let widgets: Widget[] | undefined;
    if (body.widgets !== undefined || body.layout !== undefined) {
      const read = readWidgets(body.widgets ?? storedWidgets(row.widgets), layout);
      if ('fields' in read) return invalidFields(reply, read.fields);
      widgets = read.widgets;
    }
    const sharesBefore = (await sharesOf(db, DASHBOARD_SHARES, [row.id])).get(row.id) ?? [];
    if (body.shares !== undefined) {
      const before = new Set(sharesBefore.map(shareKey));
      const added = body.shares.filter((s) => !before.has(shareKey(s)));
      if (await refuseShares(request, reply, added, body.shares)) return reply;
    }
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('dashboard')
        .select('version')
        .where('id', '=', row.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      if (body.version !== undefined && body.version !== current.version) {
        return { conflict: current.version };
      }
      const kinds = (list: Widget[]) => list.map((w) => `${w.id}:${w.kind}:${w.column}`);
      const before = {
        name: row.name,
        description: row.description,
        layout: row.layout,
        widgets: kinds(storedWidgets(row.widgets)),
        settings: JSON.stringify(storedWidgets(row.widgets)),
        ownerId: row.owner_id,
        shares: sharesBefore.map(shareKey).sort(),
      };
      const after = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.layout !== undefined ? { layout: body.layout } : {}),
        ...(widgets !== undefined
          ? { widgets: kinds(widgets), settings: JSON.stringify(widgets) }
          : {}),
        ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
        ...(body.shares !== undefined ? { shares: body.shares.map(shareKey).sort() } : {}),
      };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      // Widget settings change as a whole; the event says that they did, not what they hold.
      if ('settings' in changes) changes.settings = { from: null, to: null };
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('dashboard')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.layout !== undefined ? { layout: body.layout } : {}),
          ...(widgets !== undefined ? { widgets: JSON.stringify(widgets) } : {}),
          ...(body.ownerId !== undefined ? { owner_id: body.ownerId } : {}),
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      if (body.shares !== undefined) {
        await writeShares(trx, DASHBOARD_SHARES, ws, row.id, body.shares);
      }
      await emit(trx, by(request), {
        type: 'dashboard.updated',
        subjectId: row.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    return { dashboard: await fresh(request, row.id) };
  });

  app.post('/api/v1/dashboards/:id/copy', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = copyBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const widgets = storedWidgets(row.widgets);
    const copyName = parsed.data.name ?? `${row.name} (copy)`.slice(0, 255);
    const id = await db.transaction().execute(async (trx) => {
      const made = await trx
        .insertInto('dashboard')
        .values({
          workspace_id: request.workspaceId,
          owner_id: user.id,
          name: copyName,
          description: row.description,
          layout: row.layout,
          widgets: JSON.stringify(widgets),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'dashboard.created',
        subjectId: made.id,
        payload: { name: copyName, widgets: widgets.map((w) => w.kind), shares: [] },
      });
      return made.id;
    });
    return reply.code(201).send({ dashboard: await fresh(request, id) });
  });

  app.delete('/api/v1/dashboards/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await mayManage(request, row))) return forbidden(reply, 'edit_dashboard');
    if (row.is_default) return reply.code(409).send({ error: 'is_default' });
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('dashboard').where('id', '=', row.id).execute();
      await emit(trx, by(request), {
        type: 'dashboard.deleted',
        subjectId: row.id,
        payload: { name: row.name },
      });
    });
    return reply.code(204).send();
  });
}
