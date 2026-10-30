import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  copyTypeSet,
  defaultTypeSetId,
  isSharedTypeSet,
  mapTicketTypes,
  setMembers,
  ticketTypeMapping,
  ticketTypeView,
} from '../tickets/configuration';
import { DEFAULT_TRASH_RETENTION_DAYS, purgeAfter } from '../tickets/model';
import { setLevels } from '../tickets/visibility';
import {
  checkKey,
  FEATURE_DEFAULTS,
  featureColumn,
  looksLikeKey,
  normalizeKey,
  TRACK_FEATURES,
  TRACK_MODES,
  TRACK_TYPES,
  type TrackFeatures,
} from '../tracks/model';
import { TEMPLATE_RECIPES, TRACK_TEMPLATES } from '../tracks/templates';
import { purgeTrack } from '../trash/purge';
import { defaultMapId, loadMap, workflowForType, workflowsOf } from '../workflows/maps';
import {
  impactOf,
  planMigration,
  runningMigration,
  startMigration,
  statusMappingOf,
  statusMappingSchema,
  typeStatusMappingSchema,
} from '../workflows/migration';
import { defaultWorkflowId, holdWorkflow } from '../workflows/store';
import type { BoardRoutes } from './boards';

/**
 * Tracks and track categories (M1-006; CORE-001, CORE-002, CORE-003, CORE-025).
 *
 * - Everyone sees the tracks they may browse or administer; archived tracks only through
 *   `?archived=include|only`, which is for site and configuration administrators.
 * - A track is found by id or by key, ignoring case; an old key answers with the track and a
 *   redirect to its current key.
 * - Shared-mode tracks are created by site and configuration administrators and use a shared
 *   access policy (the workspace default unless one is named). Local-mode tracks need the
 *   global permission "Create local-mode tracks" and get their own copy of the default
 *   policy, so changing it never reaches another track (section 1.1).
 * - The creator becomes owner (unless another owner is named) and joins the role the policy
 *   lets administer the track (Administrators by default).
 * - Track administrators edit the track; changing its access policy or its type set is
 *   configuration administration; the mode is fixed at creation.
 * - A shared-mode track uses a shared type set (the default of its track type unless one is
 *   named); a local-mode track gets its own copy of that default (M1-007). Everyone who sees a
 *   track reads the ticket types it offers, in set order with the default preselected.
 * - A shared-mode track uses a shared workflow map (the workspace's default map unless one is
 *   named, M1-028); a local-mode track owns its map, made with it, whose default is the
 *   workspace's default workflow. Switching map moves tickets whose status their type's new
 *   workflow lacks to the statuses `statusMapping` (and per type `typeStatusMapping`) name, in
 *   the background when there are many (`workflows/migration.ts`).
 * - Archive and restore belong to site and configuration administrators. An archived track is
 *   read-only for everyone (the authorizer keeps only read permissions there) and hidden from
 *   the search pre-filter.
 * - Deleting sends a track to the trash (M1-101, CORE-025) with its tickets, releases and
 *   areas, for the workspace's retention (30 days by default). Site and configuration
 *   administrators delete, list (`GET /api/v1/trash/tracks`) and undelete; nobody else sees a
 *   track in the trash or anything in it, and no other route touches it. It keeps its keys,
 *   so no new track can take them. Site administrators may purge it at once; otherwise the
 *   purge job removes it after the retention (`trash/purge.ts`), and only then are its keys
 *   free again.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const icon = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'an icon name: lower-case letters, digits and hyphens');
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour as #rrggbb')
  .transform((c) => c.toLowerCase());
const features = z
  .object(Object.fromEntries(TRACK_FEATURES.map((f) => [f, z.boolean().optional()])))
  .strict() as unknown as z.ZodType<Partial<TrackFeatures>>;

const trackFields = {
  name: z.string().trim().min(1).max(255),
  description: z.string().max(10_000),
  type: z.enum(TRACK_TYPES),
  ownerId: id,
  categoryId: id.nullable(),
  icon: icon.nullable(),
  color: color.nullable(),
  accessPolicyId: id,
  typeSetId: id,
  features,
};
const createBody = z
  .object({
    key: z.string(),
    mode: z.enum(TRACK_MODES),
    name: trackFields.name,
    description: trackFields.description.optional(),
    type: trackFields.type.default('software'),
    ownerId: trackFields.ownerId.optional(),
    categoryId: trackFields.categoryId.optional(),
    icon: trackFields.icon.optional(),
    color: trackFields.color.optional(),
    accessPolicyId: trackFields.accessPolicyId.optional(),
    typeSetId: trackFields.typeSetId.optional(),
    features: trackFields.features.optional(),
    /** A template (M1-054): its type, feature toggles and board. */
    template: z.enum(TRACK_TEMPLATES).optional(),
    /** A shared-mode track whose configuration the new one takes (M1-054). */
    copyFrom: id.optional(),
  })
  .strict();
const updateBody = z
  .object({
    /** Tickets of types the new type set lacks take these types (CORE-005 (2)). */
    ticketTypeMapping: ticketTypeMapping.optional(),
    key: z.string().optional(),
    name: trackFields.name.optional(),
    description: trackFields.description.optional(),
    type: trackFields.type.optional(),
    ownerId: trackFields.ownerId.optional(),
    categoryId: trackFields.categoryId.optional(),
    icon: trackFields.icon.optional(),
    color: trackFields.color.optional(),
    accessPolicyId: trackFields.accessPolicyId.optional(),
    typeSetId: trackFields.typeSetId.optional(),
    /** The priorities it offers (CORE-014 (2)); null for the workspace's default set. */
    prioritySetId: id.nullable().optional(),
    /** Its workflow map (M1-028); null for the workspace's default map. Shared mode only. */
    workflowMapId: id.nullable().optional(),
    /** Its field rule set and layout set (M1-012); null for the workspace's defaults. */
    fieldRuleSetId: id.nullable().optional(),
    layoutSetId: id.nullable().optional(),
    /** Null for none; tickets at a level the new policy lacks take its default (M1-020). */
    visibilityPolicyId: id.nullable().optional(),
    /** Null for the workspace's default notification policy (M1-056). */
    notificationPolicyId: id.nullable().optional(),
    /** For each status a new map's workflows lack that tickets are in: where they go. */
    statusMapping: statusMappingSchema.optional(),
    /** The same for one ticket type, where its tickets go elsewhere than the rest. */
    typeStatusMapping: typeStatusMappingSchema.optional(),
    features: trackFields.features.optional(),
  })
  .strict();
const listQuery = z
  .object({
    archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
    categoryId: id.optional(),
    type: z.enum(TRACK_TYPES).optional(),
    mode: z.enum(TRACK_MODES).optional(),
    q: z.string().trim().min(1).max(255).optional(),
    after: z.string().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}
const KEY_CONSTRAINTS = ['track_workspace_key_idx', 'track_key_history_key_idx'];

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** The columns a track view needs, joined with the names it shows. */
function trackQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('track as t')
    .leftJoin('app_user as o', 'o.id', 't.owner_id')
    .leftJoin('track_category as c', 'c.id', 't.category_id')
    .leftJoin('app_user as ab', 'ab.id', 't.archived_by')
    .leftJoin('app_user as del', 'del.id', 't.deleted_by')
    .leftJoin('trash_policy as tp', 'tp.workspace_id', 't.workspace_id')
    .select([
      't.id',
      't.key',
      't.name',
      't.description',
      't.type',
      't.mode',
      't.owner_id',
      'o.name as owner_name',
      't.category_id',
      'c.name as category_name',
      't.icon',
      't.color',
      't.access_policy_id',
      't.type_set_id',
      't.priority_set_id',
      't.workflow_map_id',
      't.field_rule_set_id',
      't.layout_set_id',
      't.visibility_policy_id',
      't.notification_policy_id',
      't.feature_board',
      't.feature_backlog',
      't.feature_sprints',
      't.feature_releases',
      't.feature_development',
      't.feature_forms',
      't.feature_approvals',
      't.feature_calendar',
      't.feature_timeline',
      't.archived_at',
      't.archived_by',
      'ab.name as archived_by_name',
      't.created_at',
      't.updated_at',
      't.deleted_at',
      't.deleted_by',
      'del.name as deleted_by_name',
      't.purge_started_at',
      'tp.retention_days as trash_retention_days',
    ])
    .where('t.workspace_id', '=', workspaceId);
}
type TrackRow = Awaited<ReturnType<ReturnType<typeof trackQuery>['executeTakeFirstOrThrow']>>;

function featuresOf(row: TrackRow): TrackFeatures {
  return Object.fromEntries(TRACK_FEATURES.map((f) => [f, row[featureColumn(f)]])) as TrackFeatures;
}

function trackView(row: TrackRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    type: row.type,
    mode: row.mode,
    owner: row.owner_id === null ? null : { id: row.owner_id, name: row.owner_name ?? '' },
    category:
      row.category_id === null ? null : { id: row.category_id, name: row.category_name ?? '' },
    icon: row.icon,
    color: row.color,
    accessPolicyId: row.access_policy_id,
    typeSetId: row.type_set_id,
    prioritySetId: row.priority_set_id,
    workflowMapId: row.workflow_map_id,
    fieldRuleSetId: row.field_rule_set_id,
    layoutSetId: row.layout_set_id,
    visibilityPolicyId: row.visibility_policy_id,
    notificationPolicyId: row.notification_policy_id,
    features: featuresOf(row),
    archived: row.archived_at !== null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    archivedBy:
      row.archived_by === null ? null : { id: row.archived_by, name: row.archived_by_name ?? '' },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    trash:
      row.deleted_at === null
        ? null
        : {
            deletedAt: row.deleted_at.toISOString(),
            deletedBy:
              row.deleted_by === null
                ? null
                : { id: row.deleted_by, name: row.deleted_by_name ?? '' },
            purgeAfter: purgeAfter(
              row.deleted_at,
              row.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS,
            ).toISOString(),
            purging: row.purge_started_at !== null,
          },
  };
}

/** A track by id; one in the trash only when asked for (the trash routes). */
function loadTrack(
  db: Db,
  workspaceId: number,
  trackId: number,
  trash: 'include' | 'exclude' = 'exclude',
) {
  let query = trackQuery(db, workspaceId).where('t.id', '=', trackId);
  if (trash === 'exclude') query = query.where('t.deleted_at', 'is', null);
  return query.executeTakeFirst();
}

/** Escapes LIKE wildcards so a search for "50%" means those characters. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What track routes use from routes registered after them: the boards' create, for the board a
 * template makes (M1-054). Filled in once the boards are registered.
 */
export interface TrackRouteHooks {
  createBoard?: BoardRoutes['createBoard'];
}

export function registerTrackRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  hooks: TrackRouteHooks = {},
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /** People who may browse or administer a track see it; administrators see every track. */
  async function canSee(request: FastifyRequest, trackId: number): Promise<boolean> {
    const held = await request.authz.track(trackId);
    if (held.has('browse_track') || held.has('administer_track')) return true;
    return isAdmin(request);
  }

  async function activeUser(workspaceId: number, userId: number): Promise<boolean> {
    const row = await db
      .selectFrom('app_user')
      .select('id')
      .where('id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function categoryExists(workspaceId: number, categoryId: number): Promise<boolean> {
    const row = await db
      .selectFrom('track_category')
      .select('id')
      .where('id', '=', categoryId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function prioritySetExists(workspaceId: number, setId: number): Promise<boolean> {
    const row = await db
      .selectFrom('priority_set')
      .select('id')
      .where('id', '=', setId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** A shared policy of the workspace (never one that a local-mode track owns). */
  async function sharedPolicy(workspaceId: number, policyId: number): Promise<boolean> {
    const row = await db
      .selectFrom('access_policy')
      .select('id')
      .where('id', '=', policyId)
      .where('workspace_id', '=', workspaceId)
      .where('owner_track_id', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function defaultPolicy(trx: Db, workspaceId: number): Promise<number | null> {
    const row = await trx
      .selectFrom('access_policy')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('is_default', '=', true)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** Finds a track by id or by any key it has had. `oldKey` is set when the key is retired. */
  async function resolve(
    workspaceId: number,
    ref: string,
  ): Promise<{ id: number; oldKey: string | null } | null> {
    if (/^\d+$/.test(ref)) {
      const n = Number(ref);
      return n > 0 && n <= MAX_INT ? { id: n, oldKey: null } : null;
    }
    if (!looksLikeKey(ref)) return null;
    const row = await db
      .selectFrom('track_key_history')
      .select(['track_id', 'key', 'replaced_at'])
      .where('workspace_id', '=', workspaceId)
      .where(sql<string>`upper(key)`, '=', normalizeKey(ref))
      .executeTakeFirst();
    if (!row) return null;
    return { id: row.track_id, oldKey: row.replaced_at ? row.key : null };
  }

  app.get('/api/v1/tracks', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const ws = request.workspaceId;
    if (q.archived !== 'exclude' && !(request.user && (await isAdmin(request)))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // Active tracks come through the authorizer's list, which leaves archived ones out.
    const [browse, administer] = await Promise.all([
      request.authz.allowedTracks('browse_track'),
      request.authz.allowedTracks('administer_track'),
    ]);
    const active =
      browse === 'all' || administer === 'all'
        ? sql<boolean>`t.archived_at IS NULL`
        : sql<boolean>`(t.archived_at IS NULL AND t.id = ANY(${[
            ...new Set([...browse, ...administer]),
          ]}::int[]))`;
    const visible =
      q.archived === 'exclude'
        ? active
        : q.archived === 'only'
          ? sql<boolean>`t.archived_at IS NOT NULL`
          : sql<boolean>`(${active} OR t.archived_at IS NOT NULL)`;
    let query = trackQuery(db, ws).where(visible).where('t.deleted_at', 'is', null);
    if (q.categoryId !== undefined) query = query.where('t.category_id', '=', q.categoryId);
    if (q.type !== undefined) query = query.where('t.type', '=', q.type);
    if (q.mode !== undefined) query = query.where('t.mode', '=', q.mode);
    if (q.q !== undefined) {
      const pattern = `%${likeEscape(q.q)}%`;
      query = query.where(sql<boolean>`(t.key ILIKE ${pattern} OR t.name ILIKE ${pattern})`);
    }
    if (q.after !== undefined) {
      query = query.where(sql<boolean>`upper(t.key) > ${normalizeKey(q.after)}`);
    }
    const rows = await query
      .orderBy(sql`upper(t.key)`)
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const next = rows.length > q.limit ? (page[page.length - 1]?.key ?? null) : null;
    return { tracks: page.map(trackView), next };
  });

  app.get('/api/v1/tracks/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(255) }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolve(ws, params.data.id);
    if (!found) return notFound(reply);
    const row = await loadTrack(db, ws, found.id, 'include');
    // Tracks the caller may not see do not exist for them; one in the trash only for those who
    // may restore it.
    if (!row) return notFound(reply);
    if (row.deleted_at ? !(await isAdmin(request)) : !(await canSee(request, row.id))) {
      return notFound(reply);
    }
    const history = await db
      .selectFrom('track_key_history')
      .select('key')
      .where('track_id', '=', row.id)
      .where('replaced_at', 'is not', null)
      .orderBy('replaced_at')
      .orderBy('id')
      .execute();
    return {
      track: { ...trackView(row), previousKeys: history.map((h) => h.key) },
      ...(found.oldKey ? { redirect: { from: found.oldKey, to: row.key } } : {}),
    };
  });

  // The ticket types a track offers, in set order, with the one to preselect (CORE-005 (1)).
  app.get('/api/v1/tracks/:id/ticket-types', async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(255) }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolve(ws, params.data.id);
    if (!found) return notFound(reply);
    const row = await loadTrack(db, ws, found.id);
    if (!row || !(await canSee(request, row.id))) return notFound(reply);
    if (row.type_set_id === null) {
      return { typeSetId: null, defaultTypeId: null, ticketTypes: [] };
    }
    const set = await db
      .selectFrom('type_set')
      .select('default_type_id')
      .where('id', '=', row.type_set_id)
      .executeTakeFirstOrThrow();
    const members = (await setMembers(db, ws, [row.type_set_id])).get(row.type_set_id) ?? [];
    return {
      typeSetId: row.type_set_id,
      defaultTypeId: set.default_type_id,
      ticketTypes: members.map(ticketTypeView),
    };
  });

  app.post('/api/v1/tracks', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    // A type given outright, not the schema's default (a template or a copy chooses it then).
    const typeGiven =
      typeof request.body === 'object' && request.body !== null && 'type' in request.body;
    if (body.template !== undefined && body.copyFrom !== undefined) {
      return invalid(reply, 'a template or a track to copy, not both');
    }
    const recipe = body.template === undefined ? null : TEMPLATE_RECIPES[body.template];
    if (recipe && typeGiven && body.type !== recipe.type) {
      return invalid(reply, `the ${body.template} template makes ${recipe.type} tracks`);
    }
    const global = await request.authz.global();
    const allowed =
      body.mode === 'shared'
        ? global.has('site_admin') || global.has('configuration_admin')
        : global.has('create_local_tracks');
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    const key = checkKey(body.key, 'native');
    if (!key.ok) return reply.code(400).send({ error: 'invalid_key', problem: key.problem });
    if (body.mode === 'local' && body.accessPolicyId !== undefined) {
      return invalid(reply, 'a local-mode track gets its own access policy');
    }
    if (body.mode === 'local' && body.typeSetId !== undefined) {
      return invalid(reply, 'a local-mode track gets its own type set');
    }
    const ownerId = body.ownerId ?? user.id;
    if (!(await activeUser(ws, ownerId))) return invalid(reply, 'ownerId');
    if (body.categoryId != null && !(await categoryExists(ws, body.categoryId))) {
      return invalid(reply, 'categoryId');
    }
    if (body.accessPolicyId !== undefined && !(await sharedPolicy(ws, body.accessPolicyId))) {
      return invalid(reply, 'accessPolicyId');
    }
    if (body.typeSetId !== undefined && !(await isSharedTypeSet(db, ws, body.typeSetId))) {
      return invalid(reply, 'typeSetId');
    }
    // Copying a track's configuration (M1-054): its type, policy, sets, map and toggles, all
    // shared ones, so the source must be a shared-mode track the caller sees.
    let source: TrackRow | undefined;
    if (body.copyFrom !== undefined) {
      if (body.mode === 'local')
        return invalid(reply, 'a local-mode track gets its own configuration');
      source = await loadTrack(db, ws, body.copyFrom);
      if (!source || !(await canSee(request, source.id))) return invalid(reply, 'copyFrom');
      if (source.mode !== 'shared') return reply.code(409).send({ error: 'source_not_shared' });
    }
    const trackType = recipe ? recipe.type : source && !typeGiven ? source.type : body.type;
    const chosen = {
      ...(recipe?.features ?? (source ? featuresOf(source) : FEATURE_DEFAULTS[trackType])),
      ...(body.features ?? {}),
    };
    try {
      const created = await db.transaction().execute(async (trx) => {
        const base =
          body.accessPolicyId ?? source?.access_policy_id ?? (await defaultPolicy(trx, ws));
        if (base === null) return { error: 'no_default_access_policy' as const };
        const baseTypes =
          body.typeSetId ?? source?.type_set_id ?? (await defaultTypeSetId(trx, ws, trackType));
        if (baseTypes === null) return { error: 'no_default_type_set' as const };
        const row = await trx
          .insertInto('track')
          .values({
            workspace_id: ws,
            key: key.key,
            name: body.name,
            description: body.description ?? '',
            type: trackType,
            mode: body.mode,
            owner_id: ownerId,
            category_id:
              body.categoryId !== undefined ? body.categoryId : (source?.category_id ?? null),
            icon: body.icon ?? null,
            color: body.color ?? null,
            access_policy_id: base,
            type_set_id: baseTypes,
            ...(source
              ? {
                  priority_set_id: source.priority_set_id,
                  workflow_map_id: source.workflow_map_id,
                  field_rule_set_id: source.field_rule_set_id,
                  layout_set_id: source.layout_set_id,
                  visibility_policy_id: source.visibility_policy_id,
                  notification_policy_id: source.notification_policy_id,
                }
              : {}),
            ...Object.fromEntries(TRACK_FEATURES.map((f) => [featureColumn(f), chosen[f]])),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        let policyId = base;
        let typeSetId = baseTypes;
        let workflowMapId: number | null = null;
        if (body.mode === 'local') {
          policyId = await copyPolicy(trx, ws, base, row.id, key.key);
          typeSetId = await copyTypeSet(trx, ws, baseTypes, row.id, key.key);
          // Its own workflow map (M1-028): every type starts on the default workflow, and its
          // administrators give types the track's own workflows.
          const map = await trx
            .insertInto('workflow_map')
            .values({
              workspace_id: ws,
              name: `${key.key} workflows`,
              default_workflow_id: await defaultWorkflowId(trx, ws),
              owner_track_id: row.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          workflowMapId = map.id;
          await trx
            .updateTable('track')
            .set({
              access_policy_id: policyId,
              type_set_id: typeSetId,
              workflow_map_id: workflowMapId,
            })
            .where('id', '=', row.id)
            .execute();
        }
        // The creator joins the role this policy lets administer the track.
        const adminRole = await trx
          .selectFrom('access_grant')
          .select('role_id')
          .where('policy_id', '=', policyId)
          .where('permission', '=', 'administer_track')
          .where('grantee', '=', 'role')
          .orderBy('role_id')
          .limit(1)
          .executeTakeFirst();
        const roleId = adminRole?.role_id ?? null;
        if (roleId !== null) {
          await trx
            .insertInto('track_role_actor')
            .values({ workspace_id: ws, track_id: row.id, role_id: roleId, user_id: user.id })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        await emit(trx, by(request), {
          type: 'track.created',
          subjectId: row.id,
          payload: {
            key: key.key,
            name: body.name,
            type: trackType,
            mode: body.mode,
            ownerId,
            categoryId:
              body.categoryId !== undefined ? body.categoryId : (source?.category_id ?? null),
            accessPolicyId: policyId,
            administratorRoleId: roleId,
            typeSetId,
            ...(workflowMapId !== null ? { workflowMapId } : {}),
            ...(body.template ? { template: body.template } : {}),
            ...(source ? { copiedFrom: source.id } : {}),
          },
        });
        return { track: await loadTrack(trx, ws, row.id) };
      });
      if ('error' in created) return reply.code(409).send({ error: created.error });
      if (!created.track) return notFound(reply);
      // The template's board, made as the creator once the track exists (its own event).
      let board: { board?: unknown; boardProblem?: unknown } = {};
      if (recipe?.board && hooks.createBoard) {
        const made = await hooks.createBoard(request, {
          name: body.name,
          kind: recipe.board.kind,
          trackId: created.track.id,
          source: { query: recipe.board.query(key.key) },
        });
        board =
          made.statusCode === 201
            ? { board: (made.payload as { board: unknown }).board }
            : { boardProblem: made.payload };
      }
      return reply.code(201).send({ track: trackView(created.track), ...board });
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint !== null && KEY_CONSTRAINTS.includes(constraint)) {
        return reply.code(409).send({ error: 'key_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/tracks/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const raw = (request.body ?? {}) as Record<string, unknown>;
    if (typeof raw === 'object' && raw !== null && 'mode' in raw) {
      return invalid(reply, 'the mode is chosen when the track is created');
    }
    const parsed = updateBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = params.data.id;
    const current = await loadTrack(db, ws, trackId);
    if (!current || !(await canSee(request, trackId))) return notFound(reply);
    if (current.archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.can('administer_track', trackId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    let key: string | undefined;
    if (body.key !== undefined) {
      const checked = checkKey(body.key, 'native');
      if (!checked.ok) {
        return reply.code(400).send({ error: 'invalid_key', problem: checked.problem });
      }
      key = checked.key;
    }
    if (body.accessPolicyId !== undefined && body.accessPolicyId !== current.access_policy_id) {
      if (!(await isAdmin(request))) return reply.code(403).send({ error: 'forbidden' });
      if (current.mode === 'local') {
        return invalid(reply, 'a local-mode track keeps its own access policy');
      }
      if (!(await sharedPolicy(ws, body.accessPolicyId))) return invalid(reply, 'accessPolicyId');
    }
    if (body.typeSetId !== undefined && body.typeSetId !== current.type_set_id) {
      if (!(await isAdmin(request))) return reply.code(403).send({ error: 'forbidden' });
      if (current.mode === 'local') {
        return invalid(reply, 'a local-mode track keeps its own type set');
      }
      if (!(await isSharedTypeSet(db, ws, body.typeSetId))) return invalid(reply, 'typeSetId');
    }
    const switchesMap =
      body.workflowMapId !== undefined && body.workflowMapId !== current.workflow_map_id;
    if (switchesMap) {
      if (!(await isAdmin(request))) return reply.code(403).send({ error: 'forbidden' });
      if (current.mode === 'local') {
        return invalid(reply, 'a local-mode track keeps its own workflow map');
      }
      if (body.workflowMapId != null) {
        const map = await db
          .selectFrom('workflow_map')
          .select('id')
          .where('id', '=', body.workflowMapId)
          .where('workspace_id', '=', ws)
          .where('owner_track_id', 'is', null)
          .executeTakeFirst();
        if (!map) return invalid(reply, 'workflowMapId');
      }
    }
    // Read through the pool before the transaction: formulas recompute for moved tickets.
    const catalog = switchesMap ? await catalogs.get(ws) : null;
    // A shared set needs administrators; a local-mode track's own set, its administrators.
    for (const [kind, value, had] of [
      ['field_rule_set', body.fieldRuleSetId, current.field_rule_set_id],
      ['layout_set', body.layoutSetId, current.layout_set_id],
      ['visibility_policy', body.visibilityPolicyId, current.visibility_policy_id],
      ['notification_policy', body.notificationPolicyId, current.notification_policy_id],
    ] as const) {
      if (value === undefined || value === had || value === null) {
        if (value === null && value !== had && !(await isAdmin(request))) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        continue;
      }
      const set = await db
        .selectFrom(kind)
        .select('track_id')
        .where('id', '=', value)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!set || (set.track_id !== null && set.track_id !== trackId)) {
        return invalid(
          reply,
          kind === 'field_rule_set'
            ? 'fieldRuleSetId'
            : kind === 'layout_set'
              ? 'layoutSetId'
              : kind === 'visibility_policy'
                ? 'visibilityPolicyId'
                : 'notificationPolicyId',
        );
      }
      if (set.track_id === null && !(await isAdmin(request))) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    if (body.prioritySetId !== undefined && body.prioritySetId !== current.priority_set_id) {
      // Priority sets are the workspace's; a ticket keeps a priority its track stops offering.
      if (!(await isAdmin(request))) return reply.code(403).send({ error: 'forbidden' });
      if (body.prioritySetId !== null && !(await prioritySetExists(ws, body.prioritySetId))) {
        return invalid(reply, 'prioritySetId');
      }
    }
    if (body.ownerId !== undefined && !(await activeUser(ws, body.ownerId))) {
      return invalid(reply, 'ownerId');
    }
    if (body.categoryId != null && !(await categoryExists(ws, body.categoryId))) {
      return invalid(reply, 'categoryId');
    }
    try {
      const updated = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('track')
          .selectAll()
          .where('id', '=', trackId)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        // Deleted between the check and the lock: gone for everyone.
        if (!locked || locked.deleted_at) return { missing: true as const };
        // Archived between the check and the lock: still read-only.
        if (locked.archived_at) return { archived: true as const };
        const before: Record<string, unknown> = {
          key: locked.key,
          name: locked.name,
          description: locked.description,
          type: locked.type,
          ownerId: locked.owner_id,
          categoryId: locked.category_id,
          icon: locked.icon,
          color: locked.color,
          accessPolicyId: locked.access_policy_id,
          typeSetId: locked.type_set_id,
          prioritySetId: locked.priority_set_id,
          workflowMapId: locked.workflow_map_id,
          fieldRuleSetId: locked.field_rule_set_id,
          layoutSetId: locked.layout_set_id,
          visibilityPolicyId: locked.visibility_policy_id,
          notificationPolicyId: locked.notification_policy_id,
          ...Object.fromEntries(
            TRACK_FEATURES.map((f) => [`features.${f}`, locked[featureColumn(f)]]),
          ),
        };
        const next: Record<string, unknown> = {
          key,
          name: body.name,
          description: body.description,
          type: body.type,
          ownerId: body.ownerId,
          categoryId: body.categoryId,
          icon: body.icon,
          color: body.color,
          accessPolicyId: body.accessPolicyId,
          typeSetId: body.typeSetId,
          prioritySetId: body.prioritySetId,
          workflowMapId: body.workflowMapId,
          fieldRuleSetId: body.fieldRuleSetId,
          layoutSetId: body.layoutSetId,
          visibilityPolicyId: body.visibilityPolicyId,
          notificationPolicyId: body.notificationPolicyId,
          ...Object.fromEntries(
            Object.entries(body.features ?? {}).map(([f, on]) => [`features.${f}`, on]),
          ),
        };
        const changes = diff(before, next);
        let mapped: { fromTypeId: number; toTypeId: number; ticketCount: number }[] = [];
        if (changes.typeSetId && body.typeSetId !== undefined && locked.type_set_id !== null) {
          // Types the new set lacks leave the track: their tickets there take the types the
          // mapping names, or the switch waits (CORE-005 (2)).
          const sets = await setMembers(trx, ws, [locked.type_set_id, body.typeSetId]);
          const kept = (sets.get(body.typeSetId) ?? []).map((t) => t.id);
          const removed = (sets.get(locked.type_set_id) ?? [])
            .map((t) => t.id)
            .filter((t) => !kept.includes(t));
          const result = await mapTicketTypes(
            trx,
            ws,
            [trackId],
            removed,
            kept,
            body.ticketTypeMapping,
            request.user?.id ?? null,
          );
          if (!result.ok) return { refused: result };
          mapped = result.mapped;
        } else if (body.ticketTypeMapping !== undefined) {
          return { badMapping: true as const };
        }
        let statusMapped = 0;
        let statusMigration: Awaited<ReturnType<typeof startMigration>> | null = null;
        if (changes.workflowMapId && body.workflowMapId !== undefined && catalog) {
          // Tickets in statuses their type's new workflow lacks go where the mapping says,
          // after a migration already moving this track's tickets has finished (M1-028).
          const running = await runningMigration(trx, ws, [trackId]);
          if (running !== null) return { migrationRunning: running };
          const fallback = await defaultMapId(trx, ws);
          const wasId = locked.workflow_map_id ?? fallback;
          const nextId = body.workflowMapId ?? fallback;
          // Both maps, then every workflow they name, in id order, so none changes under the
          // switch.
          const maps = new Map<number, Awaited<ReturnType<typeof loadMap>>>();
          for (const mapId of [...new Set([wasId, nextId])].sort((a, b) => a - b)) {
            maps.set(mapId, await loadMap(trx, ws, mapId, 'share'));
          }
          const was = maps.get(wasId);
          const next = maps.get(nextId);
          if (!was || !next) return { badMap: true as const };
          const named = new Set([...workflowsOf(was), ...workflowsOf(next)]);
          for (const workflowId of [...named].sort((a, b) => a - b)) {
            await holdWorkflow(trx, workflowId, 'share');
          }
          const impact = await impactOf(
            trx,
            ws,
            [trackId],
            (_, type) => workflowForType(was, type),
            (_, type) => workflowForType(next, type),
          );
          const plan = planMigration(
            impact,
            statusMappingOf(body.statusMapping, body.typeStatusMapping),
          );
          if (!plan.ok) {
            return 'required' in plan
              ? { statusMappingRequired: plan.required }
              : { badStatusMapping: true as const };
          }
          if (plan.steps.length > 0) {
            statusMigration = await startMigration(
              trx,
              catalog,
              {
                workspaceId: ws,
                userId: request.user?.id ?? null,
                reason: 'track_map',
                mapId: next.id,
                trackId,
              },
              plan.steps,
            );
            statusMapped = plan.ticketCount;
          }
        } else if (body.statusMapping !== undefined || body.typeStatusMapping !== undefined) {
          return { badStatusMapping: true as const };
        }
        let levelsMapped = 0;
        if (changes.visibilityPolicyId && body.visibilityPolicyId !== undefined) {
          // Tickets at a level the new policy lacks take its default, or none (IAM-011).
          const next =
            body.visibilityPolicyId === null
              ? null
              : await trx
                  .selectFrom('visibility_policy')
                  .select('default_level_id')
                  .where('id', '=', body.visibilityPolicyId)
                  .executeTakeFirst();
          const kept = trx
            .selectFrom('visibility_level')
            .select('id')
            .where('policy_id', '=', body.visibilityPolicyId ?? 0);
          const moving = await trx
            .selectFrom('ticket')
            .select('id')
            .where('track_id', '=', trackId)
            .where('visibility_level_id', 'is not', null)
            .where('visibility_level_id', 'not in', kept)
            .execute();
          levelsMapped = await setLevels(
            trx,
            ws,
            request.user?.id ?? null,
            moving.map((t) => t.id),
            next?.default_level_id ?? null,
          );
        }
        if (Object.keys(changes).length > 0) {
          // Only what changed is written; `changes` has an entry only for a given value.
          const set: Updateable<Database['track']> = { updated_at: new Date() };
          if (changes.key && key !== undefined) set.key = key;
          if (changes.name && body.name !== undefined) set.name = body.name;
          if (changes.description && body.description !== undefined) {
            set.description = body.description;
          }
          if (changes.type && body.type !== undefined) set.type = body.type;
          if (changes.ownerId && body.ownerId !== undefined) set.owner_id = body.ownerId;
          if (changes.categoryId && body.categoryId !== undefined) {
            set.category_id = body.categoryId;
          }
          if (changes.icon && body.icon !== undefined) set.icon = body.icon;
          if (changes.color && body.color !== undefined) set.color = body.color;
          if (changes.accessPolicyId && body.accessPolicyId !== undefined) {
            set.access_policy_id = body.accessPolicyId;
          }
          if (changes.typeSetId && body.typeSetId !== undefined) {
            set.type_set_id = body.typeSetId;
          }
          if (changes.prioritySetId && body.prioritySetId !== undefined) {
            set.priority_set_id = body.prioritySetId;
          }
          if (changes.workflowMapId && body.workflowMapId !== undefined) {
            set.workflow_map_id = body.workflowMapId;
          }
          if (changes.fieldRuleSetId && body.fieldRuleSetId !== undefined) {
            set.field_rule_set_id = body.fieldRuleSetId;
          }
          if (changes.layoutSetId && body.layoutSetId !== undefined) {
            set.layout_set_id = body.layoutSetId;
          }
          if (changes.visibilityPolicyId && body.visibilityPolicyId !== undefined) {
            set.visibility_policy_id = body.visibilityPolicyId;
          }
          if (changes.notificationPolicyId && body.notificationPolicyId !== undefined) {
            set.notification_policy_id = body.notificationPolicyId;
          }
          for (const feature of TRACK_FEATURES) {
            const on = body.features?.[feature];
            if (changes[`features.${feature}`] && on !== undefined)
              set[featureColumn(feature)] = on;
          }
          await trx.updateTable('track').set(set).where('id', '=', trackId).execute();
          await emit(trx, by(request), {
            type: 'track.updated',
            subjectId: trackId,
            payload: {
              changes,
              ...(mapped.length > 0 ? { mapped } : {}),
              ...(statusMapped > 0 ? { statusMapped } : {}),
              ...(statusMigration ? { statusMigrationId: statusMigration.id } : {}),
              ...(levelsMapped > 0 ? { levelsMapped } : {}),
            },
          });
        }
        return { track: await loadTrack(trx, ws, trackId), statusMigration };
      });
      if ('missing' in updated) return notFound(reply);
      if ('archived' in updated) return reply.code(409).send({ error: 'track_archived' });
      if ('refused' in updated) {
        return reply.code(updated.refused.status).send(updated.refused.body);
      }
      if ('badMapping' in updated) return invalid(reply, 'ticketTypeMapping');
      if ('statusMappingRequired' in updated) {
        return reply
          .code(409)
          .send({ error: 'status_mapping_required', statuses: updated.statusMappingRequired });
      }
      if ('badStatusMapping' in updated) return invalid(reply, 'statusMapping');
      if ('badMap' in updated) return invalid(reply, 'workflowMapId');
      if ('migrationRunning' in updated) {
        return reply
          .code(409)
          .send({ error: 'status_migration_running', migrationId: updated.migrationRunning });
      }
      if (!updated.track) return notFound(reply);
      return {
        track: trackView(updated.track),
        ...(updated.statusMigration ? { statusMigration: updated.statusMigration } : {}),
      };
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint !== null && KEY_CONSTRAINTS.includes(constraint)) {
        return reply.code(409).send({ error: 'key_taken' });
      }
      // The priority set was deleted after the check.
      if ((error as { constraint?: string }).constraint === 'track_priority_set_id_fkey') {
        return invalid(reply, 'prioritySetId');
      }
      throw error;
    }
  });

  for (const action of ['archive', 'restore'] as const) {
    app.post(`/api/v1/tracks/:id/${action}`, async (request, reply) => {
      const user = await configAdmin(request, reply);
      if (!user) return reply;
      const params = z.object({ id }).safeParse(request.params);
      if (!params.success) return invalid(reply);
      const ws = request.workspaceId;
      const trackId = params.data.id;
      const result = await db.transaction().execute(async (trx) => {
        const archiving = action === 'archive';
        const changed = await trx
          .updateTable('track')
          .set({
            archived_at: archiving ? new Date() : null,
            archived_by: archiving ? user.id : null,
            updated_at: new Date(),
          })
          .where('id', '=', trackId)
          .where('workspace_id', '=', ws)
          .where('archived_at', archiving ? 'is' : 'is not', null)
          .where('deleted_at', 'is', null)
          .returning('key')
          .executeTakeFirst();
        if (!changed) {
          const exists = await loadTrack(trx, ws, trackId);
          return { error: exists ? (archiving ? 'already_archived' : 'not_archived') : null };
        }
        await emit(trx, by(request), {
          type: archiving ? 'track.archived' : 'track.restored',
          subjectId: trackId,
          payload: { key: changed.key },
        });
        return { track: await loadTrack(trx, ws, trackId) };
      });
      if ('error' in result) {
        return result.error ? reply.code(409).send({ error: result.error }) : notFound(reply);
      }
      if (!result.track) return notFound(reply);
      return { track: trackView(result.track) };
    });
  }

  // The trash for tracks (M1-101, CORE-025): administrators delete, list and undelete; the
  // track and everything in it are invisible to everyone else until it comes back.
  app.delete('/api/v1/tracks/:id', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = params.data.id;
    const result = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('track')
        .select(['key', 'deleted_at'])
        .where('id', '=', trackId)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { error: null };
      if (locked.deleted_at) return { error: 'in_trash' as const };
      const now = new Date();
      await trx
        .updateTable('track')
        .set({ deleted_at: now, deleted_by: user.id, updated_at: now })
        .where('id', '=', trackId)
        .execute();
      await emit(trx, by(request), {
        type: 'track.deleted',
        subjectId: trackId,
        payload: { key: locked.key },
      });
      return { ok: true as const };
    });
    if ('error' in result) {
      return result.error ? reply.code(409).send({ error: result.error }) : notFound(reply);
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/tracks/:id/undelete', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = params.data.id;
    const result = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('track')
        .select(['key', 'deleted_at', 'purge_started_at'])
        .where('id', '=', trackId)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { error: null };
      if (!locked.deleted_at) return { error: 'not_in_trash' as const };
      // Its permanent deletion has begun: part of it is gone already.
      if (locked.purge_started_at) return { error: 'purging' as const };
      await trx
        .updateTable('track')
        .set({ deleted_at: null, deleted_by: null, updated_at: new Date() })
        .where('id', '=', trackId)
        .execute();
      await emit(trx, by(request), {
        type: 'track.undeleted',
        subjectId: trackId,
        payload: { key: locked.key },
      });
      return { track: await loadTrack(trx, ws, trackId) };
    });
    if ('error' in result) {
      return result.error ? reply.code(409).send({ error: result.error }) : notFound(reply);
    }
    if (!result.track) return notFound(reply);
    return { track: trackView(result.track) };
  });

  // Deleting for good before the retention ends: site administrators only. Large tracks go in
  // batches; an interrupted purge is finished by the next purge run.
  app.post('/api/v1/tracks/:id/purge', async (request, reply) => {
    const user = await requireGlobal(request, reply, 'site_admin');
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const row = await loadTrack(db, ws, params.data.id, 'include');
    if (!row) return notFound(reply);
    if (!row.deleted_at) return reply.code(409).send({ error: 'not_in_trash' });
    const done = await purgeTrack(db, ws, row.id, { actorId: user.id, reason: 'admin' });
    if (!done || done === 'unfinished') return notFound(reply);
    return { purged: { id: row.id, key: done.key, tickets: done.tickets } };
  });

  app.get('/api/v1/trash/tracks', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const rows = await trackQuery(db, request.workspaceId)
      .where('t.deleted_at', 'is not', null)
      .orderBy('t.deleted_at', 'desc')
      .orderBy('t.id', 'desc')
      .execute();
    const counts = await db
      .selectFrom('ticket')
      .select(['track_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('track_id', 'in', rows.length > 0 ? rows.map((r) => r.id) : [0])
      .groupBy('track_id')
      .execute();
    const ticketCount = new Map(counts.map((c) => [c.track_id, Number(c.n)]));
    return {
      tracks: rows.map((r) => ({ ...trackView(r), ticketCount: ticketCount.get(r.id) ?? 0 })),
    };
  });

  // Categories: everyone signed in reads them; configuration administrators change them.
  app.get('/api/v1/track-categories', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const admin = await isAdmin(request);
    const rows = await db
      .selectFrom('track_category as c')
      .select((eb) => [
        'c.id',
        'c.name',
        'c.description',
        eb
          .selectFrom('track as t')
          .select((t) => t.fn.countAll<string>().as('n'))
          .whereRef('t.category_id', '=', 'c.id')
          .as('tracks'),
      ])
      .where('c.workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(c.name)`)
      .execute();
    return {
      categories: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        // How many tracks use it would reveal tracks a person cannot see.
        ...(admin ? { trackCount: Number(r.tracks ?? 0) } : {}),
      })),
    };
  });

  app.post('/api/v1/track-categories', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = categoryBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const category = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('track_category')
          .values({
            workspace_id: request.workspaceId,
            name: parsed.data.name,
            description: parsed.data.description ?? '',
          })
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'track_category.created',
          subjectId: row.id,
          payload: { name: row.name },
        });
        return row;
      });
      return reply.code(201).send({ category });
    } catch (error) {
      if (uniqueViolation(error) !== null) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/track-categories/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = categoryBody.partial().strict().safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    try {
      const category = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('track_category')
          .select(['name', 'description'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return undefined;
        const next = {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        };
        const changes = diff(before, next);
        if (Object.keys(changes).length > 0) {
          await trx
            .updateTable('track_category')
            .set({ ...next, updated_at: new Date() })
            .where('id', '=', params.data.id)
            .execute();
          await emit(trx, by(request), {
            type: 'track_category.updated',
            subjectId: params.data.id,
            payload: { changes },
          });
        }
        return trx
          .selectFrom('track_category')
          .select(['id', 'name', 'description'])
          .where('id', '=', params.data.id)
          .executeTakeFirstOrThrow();
      });
      if (!category) return notFound(reply);
      return { category };
    } catch (error) {
      if (uniqueViolation(error) !== null) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  // Deleting a category leaves its tracks without one; the event says how many.
  app.delete('/api/v1/track-categories/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const deleted = await db.transaction().execute(async (trx) => {
      const used = await trx
        .selectFrom('track')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('category_id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirstOrThrow();
      const row = await trx
        .deleteFrom('track_category')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(trx, by(request), {
          type: 'track_category.deleted',
          subjectId: row.id,
          payload: { name: row.name, trackCount: Number(used.n) },
        });
      }
      return row;
    });
    if (!deleted) return notFound(reply);
    return reply.code(204).send();
  });
}

/**
 * A local-mode track's own access policy: a copy of `sourceId`'s grants, owned by the track
 * (section 1.1: nothing leaks to other tracks). Policy names are unique per workspace, so the
 * track id is added when the plain name is already used.
 */
async function copyPolicy(
  trx: Transaction<Database>,
  workspaceId: number,
  sourceId: number,
  trackId: number,
  key: string,
): Promise<number> {
  for (const name of [`${key} local access policy`, `${key} local access policy ${trackId}`]) {
    const row = await trx
      .insertInto('access_policy')
      .values({
        workspace_id: workspaceId,
        name,
        description: `Owned by track ${key}; copied from the default access policy`,
        owner_track_id: trackId,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) continue;
    await sql`
      INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id, group_id,
                                user_id, field_key)
      SELECT workspace_id, ${row.id}, permission, grantee, role_id, group_id, user_id, field_key
        FROM access_grant WHERE policy_id = ${sourceId}`.execute(trx);
    return row.id;
  }
  throw new Error(`no free name for the local access policy of track ${key}`);
}
