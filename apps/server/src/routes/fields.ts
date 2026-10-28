import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import {
  type Catalog,
  type ContextConfig,
  type ContextDef,
  type FieldCatalogs,
  type FieldDef,
  loadCatalog,
  type OptionDef,
} from '../fields/catalog';
import {
  FIELD_TYPES,
  type FieldConfig,
  MULTIPLE_TYPES,
  NUMBER_FORMATS,
  PARAGRAPH_LIMIT,
  parseValue,
  REFERENCE_OF,
  type Reference,
  restValue,
  SELECT_DISPLAYS,
  type Stored,
} from '../fields/types';
import { allowedPeople, describeFields, loadResolver } from '../fields/values';
import { resolveTrack } from '../tickets/store';

/**
 * Custom fields, their contexts and options (M1-010; CORE-003, CORE-009, CORE-010; spec 01a
 * sections 1.4 and 1.5). The types live in `fields/types.ts`, the catalogue in
 * `fields/catalog.ts`, values on tickets in `fields/values.ts`.
 *
 * - Shared fields belong to the workspace: everyone signed in reads them; site and configuration
 *   administrators change them, and their contexts may cover any track. A local-mode track's
 *   own fields are read by those who may browse it and changed by its administrators; their
 *   contexts cover that track only, so nothing leaks to other tracks (CORE-003 (1)).
 * - A field's type, and whether it holds several values, are fixed at creation (spec 01a
 *   section 1.4). A new field gets one context: every track and type for a shared field, its
 *   track for a local one, unless the request gives another.
 * - A context covers tracks and ticket types (null for all) and holds its options, its default
 *   and, for user pickers, the group or track role people are chosen from (CORE-009). Two
 *   contexts of a field never cover the same track and type pair (409 `context_overlap`).
 * - Options are renamed, reordered and disabled in place, so tickets keep their ids
 *   (CORE-009 (3)); one in use on a ticket, the trash included, is disabled rather than
 *   deleted. A field, or a context whose options are in use, is deleted once no ticket holds
 *   its values.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const idValue = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;
const ids = z.array(idValue).min(1).max(1000).refine(unique, 'each id once');
/** Options per field (spec 01a section 1.7). */
export const OPTIONS_MAX = 20_000;
const optionValue = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => ![...v].some((c) => (c.codePointAt(0) as number) < 0x20), 'one line');

const configBody = z
  .object({
    maxChars: z.number().int().min(1).max(PARAGRAPH_LIMIT),
    format: z.enum(NUMBER_FORMATS),
    decimals: z.number().int().min(0).max(3),
    currency: z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code'),
    display: z.enum(SELECT_DISPLAYS),
  })
  .partial()
  .strict();
const contextConfigBody = z
  .object({ userGroupId: idValue.nullable(), userRoleId: idValue.nullable() })
  .partial()
  .strict();

const optionBody = z
  .object({
    value: optionValue,
    disabled: z.boolean().optional(),
    /** The context's default: one option (or a parent and a child), several when multiple. */
    default: z.boolean().optional(),
    children: z
      .array(
        z
          .object({
            value: optionValue,
            disabled: z.boolean().optional(),
            default: z.boolean().optional(),
          })
          .strict(),
      )
      .max(OPTIONS_MAX)
      .optional(),
  })
  .strict();
const contextFields = {
  name,
  description,
  trackIds: ids.nullable(),
  ticketTypeIds: ids.nullable(),
  config: contextConfigBody,
};
const createContextBody = z
  .object({
    name: contextFields.name,
    description: contextFields.description.optional(),
    trackIds: contextFields.trackIds.optional(),
    ticketTypeIds: contextFields.ticketTypeIds.optional(),
    config: contextFields.config.optional(),
    defaultValue: z.unknown().optional(),
    options: z.array(optionBody).max(OPTIONS_MAX).optional(),
  })
  .strict();
const updateContextBody = z
  .object({ ...contextFields, defaultValue: z.unknown() })
  .partial()
  .strict();
const createFieldBody = z
  .object({
    name,
    description: description.optional(),
    type: z.enum(FIELD_TYPES),
    multiple: z.boolean().optional(),
    config: configBody.optional(),
    /** A local-mode track that owns the field; shared when left out. */
    trackId: idValue.optional(),
    /** The field's first context; every track and type (its track, for a local field) if left out. */
    context: createContextBody.partial({ name: true }).optional(),
  })
  .strict();
const updateFieldBody = z.object({ name, description, config: configBody }).partial().strict();
const createOptionBody = z
  .object({
    value: optionValue,
    parentId: idValue.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
const updateOptionBody = z.object({ value: optionValue, disabled: z.boolean() }).partial().strict();
const orderBody = z
  .object({ parentId: idValue.nullable().optional(), optionIds: ids.max(OPTIONS_MAX) })
  .strict();
const listQuery = z.object({ trackId: id.optional() }).strict();
const applicableQuery = z.object({ ticketTypeId: id }).strict();
const suggestQuery = z
  .object({
    q: z.string().max(255).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const peopleQuery = suggestQuery.extend({ track: z.string().min(1).max(300), ticketTypeId: id });

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const zodDetail = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

type Loose<T> = { [K in keyof T]?: T[K] | undefined };
/** Settings as given, without the keys left undefined. */
const defined = <T extends object>(value: Loose<T>): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Which settings each type takes; the rest are refused. */
function configProblem(type: string, multiple: boolean, config: FieldConfig): string | null {
  const allowed: Record<string, readonly (keyof FieldConfig)[]> = {
    paragraph: ['maxChars'],
    number: ['format', 'decimals', 'currency'],
    select: ['display'],
  };
  const extra = Object.keys(config).filter(
    (k) => !(allowed[type] ?? []).includes(k as keyof FieldConfig),
  );
  if (extra.length > 0) return `config: ${extra.join(', ')} not used by ${type}`;
  if (type === 'number' && (config.format === 'currency') !== (config.currency !== undefined)) {
    return 'config: currency goes with the currency format';
  }
  if (type === 'select' && config.display !== undefined) {
    const fits = multiple ? ['dropdown', 'checkboxes'] : ['dropdown', 'radio'];
    if (!fits.includes(config.display)) return `config: display ${config.display} does not fit`;
  }
  return null;
}

function optionTree(catalog: Catalog, contextId: number) {
  const one = (o: OptionDef) => ({ id: o.id, value: o.value, disabled: o.disabled });
  return catalog.optionsOf(contextId).map((o) => ({
    ...one(o),
    children: catalog.optionsOf(contextId, o.id).map(one),
  }));
}

/** A field as the API shows it; contexts with their options unless `brief`. */
async function fieldView(
  db: Db,
  workspaceId: number,
  catalog: Catalog,
  field: FieldDef,
  brief = false,
) {
  const contexts = [...catalog.contexts.values()]
    .filter((c) => c.fieldId === field.id)
    .sort((a, b) => a.id - b.id);
  const wanted = new Map<Reference, Set<number>>();
  const ref = REFERENCE_OF[field.type];
  if (ref) {
    for (const c of contexts) {
      if (c.defaultValue === undefined) continue;
      const set = wanted.get(ref) ?? new Set<number>();
      const values = Array.isArray(c.defaultValue) ? c.defaultValue : [c.defaultValue];
      for (const v of values as number[]) set.add(v);
      wanted.set(ref, set);
    }
  }
  const resolver = await loadResolver(db, workspaceId, catalog, wanted);
  return {
    id: field.id,
    name: field.name,
    description: field.description,
    type: field.type,
    multiple: field.multiple,
    config: field.config,
    trackId: field.trackId,
    contexts: contexts.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      trackIds: c.trackIds,
      ticketTypeIds: c.ticketTypeIds,
      config: c.config,
      defaultValue:
        c.defaultValue === undefined ? null : restValue(field, c.defaultValue, resolver),
      ...(brief ? {} : { options: optionTree(catalog, c.id) }),
    })),
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString(),
  };
}

/** Tickets, the trash included, whose value for a field names one of `optionIds`. */
async function ticketsWithOptions(
  db: Db,
  workspaceId: number,
  fieldId: number,
  optionIds: readonly number[],
): Promise<number> {
  if (optionIds.length === 0) return 0;
  const key = String(fieldId);
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ticket t
     WHERE t.workspace_id = ${workspaceId} AND t.fields ? ${key}
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE jsonb_typeof(t.fields -> ${key}) WHEN 'array' THEN t.fields -> ${key}
                ELSE jsonb_build_array(t.fields -> ${key}) END) e
          WHERE (e #>> '{}')::int = ANY(${optionIds as number[]}::int[]))`.execute(db);
  return rows[0]?.n ?? 0;
}

async function ticketsWithField(db: Db, workspaceId: number, fieldId: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ticket
     WHERE workspace_id = ${workspaceId} AND fields ? ${String(fieldId)}`.execute(db);
  return rows[0]?.n ?? 0;
}

type Problem = { status: number; body: Record<string, unknown> };
const problem = (status: number, error: string, extra: Record<string, unknown> = {}): Problem => ({
  status,
  body: { error, ...extra },
});
const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' && value !== null && 'status' in value && 'body' in value;

export function registerFieldRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  async function canSeeTrack(request: FastifyRequest, trackId: number): Promise<boolean> {
    const held = await request.authz.track(trackId);
    return held.has('browse_track') || held.has('administer_track') || isAdmin(request);
  }

  /** A field the caller may read, or null. */
  async function readable(request: FastifyRequest, fieldId: number): Promise<FieldDef | null> {
    const catalog = await catalogs.get(request.workspaceId);
    const field = catalog.fields.get(fieldId);
    if (!field) return null;
    if (field.trackId !== null && !(await canSeeTrack(request, field.trackId))) return null;
    return field;
  }

  /**
   * Whether the caller may change a field owned by `ownerTrackId` (null: shared); answers the
   * refusal itself. A local field of a track the caller cannot see is not found.
   */
  async function mayConfigure(
    request: FastifyRequest,
    reply: FastifyReply,
    ownerTrackId: number | null,
  ): Promise<boolean> {
    if (!requireUser(request, reply)) return false;
    if (ownerTrackId === null) {
      if (await isAdmin(request)) return true;
      await reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    const track = await db
      .selectFrom('track')
      .select(['archived_at', 'deleted_at'])
      .where('id', '=', ownerTrackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!track || track.deleted_at || !(await canSeeTrack(request, ownerTrackId))) {
      await notFound(reply);
      return false;
    }
    if (track.archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return false;
    }
    if ((await request.authz.can('administer_track', ownerTrackId)) || (await isAdmin(request))) {
      return true;
    }
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /** The field with the context or option named by the route, for a change by the caller. */
  async function target(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ field: FieldDef; context: ContextDef | null; optionId: number | null } | null> {
    const p = z
      .object({ id, contextId: id.optional(), optionId: id.optional() })
      .safeParse(request.params);
    if (!p.success) {
      await invalid(reply);
      return null;
    }
    if (!requireUser(request, reply)) return null;
    const field = await readable(request, p.data.id);
    if (!field) {
      await notFound(reply);
      return null;
    }
    if (!(await mayConfigure(request, reply, field.trackId))) return null;
    let context: ContextDef | null = null;
    if (p.data.contextId !== undefined) {
      const catalog = await catalogs.get(request.workspaceId);
      context = catalog.contexts.get(p.data.contextId) ?? null;
      if (!context || context.fieldId !== field.id) {
        await notFound(reply);
        return null;
      }
    }
    return { field, context, optionId: p.data.optionId ?? null };
  }

  /** Holds the field row for the length of a change, so changes to one field queue. */
  async function holdField(trx: Transaction<Database>, fieldId: number) {
    return trx
      .selectFrom('field')
      .select(['id', 'name'])
      .where('id', '=', fieldId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }

  /** Tracks and ticket types a context names must exist; a local field's only its track. */
  async function scopeProblem(
    trx: Transaction<Database>,
    workspaceId: number,
    field: FieldDef,
    trackIds: readonly number[] | null,
    typeIds: readonly number[] | null,
  ): Promise<Problem | null> {
    if (
      field.trackId !== null &&
      (trackIds === null || trackIds.some((t) => t !== field.trackId))
    ) {
      return problem(400, 'invalid_request', { detail: 'a local field covers its own track only' });
    }
    if (trackIds !== null) {
      const rows = await trx
        .selectFrom('track')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', [...trackIds])
        .where('deleted_at', 'is', null)
        .execute();
      if (rows.length !== trackIds.length) return problem(400, 'unknown_track');
    }
    if (typeIds !== null) {
      const rows = await trx
        .selectFrom('ticket_type')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', [...typeIds])
        .execute();
      if (rows.length !== typeIds.length) return problem(400, 'unknown_ticket_type');
    }
    return null;
  }

  /** Replaces a context's scope rows: every pair of its tracks and types. */
  async function writeScopes(
    trx: Transaction<Database>,
    workspaceId: number,
    field: FieldDef,
    contextId: number,
    trackIds: readonly number[] | null,
    typeIds: readonly number[] | null,
  ): Promise<Problem | null> {
    await trx.deleteFrom('field_context_scope').where('context_id', '=', contextId).execute();
    const rows = (trackIds ?? [null]).flatMap((trackId) =>
      (typeIds ?? [null]).map((typeId) => ({
        workspace_id: workspaceId,
        field_id: field.id,
        context_id: contextId,
        track_id: trackId,
        ticket_type_id: typeId,
      })),
    );
    // Find a clash first, to name the context it clashes with.
    const clash = await trx
      .selectFrom('field_context_scope')
      .select('context_id')
      .where('field_id', '=', field.id)
      .where('context_id', '<>', contextId)
      .where((eb) =>
        eb.or(
          rows.map((r) =>
            eb.and([
              sql<boolean>`coalesce(track_id, 0) = ${r.track_id ?? 0}`,
              sql<boolean>`coalesce(ticket_type_id, 0) = ${r.ticket_type_id ?? 0}`,
            ]),
          ),
        ),
      )
      .executeTakeFirst();
    if (clash) return problem(409, 'context_overlap', { contextId: clash.context_id });
    for (let i = 0; i < rows.length; i += 5000) {
      await trx
        .insertInto('field_context_scope')
        .values(rows.slice(i, i + 5000))
        .execute();
    }
    return null;
  }

  /**
   * A context's default in stored form, or a problem. Defaults of release and area fields
   * would name one track's objects, so those fields have none; options must be the context's.
   */
  async function defaultFor(
    trx: Transaction<Database>,
    workspaceId: number,
    field: FieldDef,
    contextId: number,
    input: unknown,
  ): Promise<Stored | null | Problem> {
    if (input === null) return null;
    if (field.type === 'release' || field.type === 'area' || field.type === 'read-only-text') {
      return problem(400, 'invalid_request', { detail: `a ${field.type} field has no default` });
    }
    const parsed = parseValue(field, input);
    if (!parsed.ok) return problem(400, 'invalid_default', { problem: parsed.problem });
    if (parsed.value === undefined) return null;
    const value = parsed.value;
    const ref = REFERENCE_OF[field.type];
    const named = ref ? (Array.isArray(value) ? (value as number[]) : [value as number]) : [];
    if (ref === 'option') {
      const options = await trx
        .selectFrom('field_option')
        .select(['id', 'parent_id', 'disabled'])
        .where('context_id', '=', contextId)
        .where('id', 'in', named)
        .execute();
      const byId = new Map(options.map((o) => [o.id, o]));
      const fits = named.every((optionId, i) => {
        const o = byId.get(optionId);
        const parent = field.type === 'cascading-select' && i === 1 ? named[0] : null;
        return o !== undefined && !o.disabled && o.parent_id === (parent ?? null);
      });
      if (!fits) return problem(400, 'invalid_default', { problem: 'not_found' });
    } else if (ref === 'user' || ref === 'group') {
      const table = ref === 'user' ? 'app_user' : 'user_group';
      const rows = await trx
        .selectFrom(table)
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', named)
        .execute();
      if (rows.length !== named.length) {
        return problem(400, 'invalid_default', { problem: 'not_found' });
      }
    }
    return value;
  }

  async function contextConfigProblem(
    trx: Transaction<Database>,
    workspaceId: number,
    field: FieldDef,
    config: ContextConfig,
  ): Promise<Problem | null> {
    const keys = Object.keys(config);
    if (keys.length === 0) return null;
    if (field.type !== 'user') {
      return problem(400, 'invalid_request', { detail: 'only user pickers take a context config' });
    }
    if (config.userGroupId !== undefined) {
      const group = await trx
        .selectFrom('user_group')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', config.userGroupId)
        .executeTakeFirst();
      if (!group) return problem(400, 'unknown_group');
    }
    if (config.userRoleId !== undefined) {
      const role = await trx
        .selectFrom('role')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', config.userRoleId)
        .executeTakeFirst();
      if (!role) return problem(400, 'unknown_role');
    }
    return null;
  }

  /** Context settings with nulls dropped: a null removes a restriction. */
  const cleanConfig = (config: Loose<{ userGroupId: number | null; userRoleId: number | null }>) =>
    Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== null && v !== undefined),
    ) as ContextConfig;

  /**
   * Creates a context with its options (and defaults marked on them) inside a transaction.
   * Returns the context id and how many options it got.
   */
  async function createContext(
    trx: Transaction<Database>,
    workspaceId: number,
    field: FieldDef,
    body: z.infer<typeof createContextBody>,
  ): Promise<{ contextId: number; optionCount: number } | Problem> {
    const trackIds =
      body.trackIds === undefined
        ? field.trackId === null
          ? null
          : [field.trackId]
        : body.trackIds;
    const typeIds = body.ticketTypeIds ?? null;
    const scope = await scopeProblem(trx, workspaceId, field, trackIds, typeIds);
    if (scope) return scope;
    const config = cleanConfig(body.config ?? {});
    const configProblemFound = await contextConfigProblem(trx, workspaceId, field, config);
    if (configProblemFound) return configProblemFound;
    const options = body.options ?? [];
    const takesOptions = field.type === 'select' || field.type === 'cascading-select';
    if (options.length > 0 && !takesOptions) {
      return problem(400, 'invalid_request', { detail: `a ${field.type} field has no options` });
    }
    if (field.type !== 'cascading-select' && options.some((o) => o.children !== undefined)) {
      return problem(400, 'invalid_request', { detail: 'only cascading selects have children' });
    }
    const total = options.reduce((n, o) => n + 1 + (o.children?.length ?? 0), 0);
    if (total > OPTIONS_MAX) return problem(400, 'too_many_options', { max: OPTIONS_MAX });
    const lower = (v: string) => v.toLowerCase();
    if (!unique(options.map((o) => lower(o.value)))) {
      return problem(400, 'invalid_request', { detail: 'option values repeat' });
    }
    if (options.some((o) => !unique((o.children ?? []).map((c) => lower(c.value))))) {
      return problem(400, 'invalid_request', { detail: 'option values repeat' });
    }
    const context = await trx
      .insertInto('field_context')
      .values({
        workspace_id: workspaceId,
        field_id: field.id,
        name: body.name ?? 'Default',
        description: body.description ?? '',
        config: JSON.stringify(config),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const scopes = await writeScopes(trx, workspaceId, field, context.id, trackIds, typeIds);
    if (scopes) return scopes;
    const defaults: number[] = [];
    if (options.length > 0) {
      const parents = await trx
        .insertInto('field_option')
        .values(
          options.map((o, i) => ({
            workspace_id: workspaceId,
            field_id: field.id,
            context_id: context.id,
            value: o.value,
            sort_order: i + 1,
            disabled: o.disabled ?? false,
          })),
        )
        .returning(['id', 'value'])
        .execute();
      const parentId = new Map(parents.map((p) => [lower(p.value), p.id]));
      const children = options.flatMap((o) =>
        (o.children ?? []).map((c, i) => ({ parent: o, child: c, order: i + 1 })),
      );
      for (const o of options) {
        if (o.default) defaults.push(parentId.get(lower(o.value)) as number);
      }
      for (let i = 0; i < children.length; i += 5000) {
        const slice = children.slice(i, i + 5000);
        const made = await trx
          .insertInto('field_option')
          .values(
            slice.map(({ parent, child, order }) => ({
              workspace_id: workspaceId,
              field_id: field.id,
              context_id: context.id,
              parent_id: parentId.get(lower(parent.value)) as number,
              value: child.value,
              sort_order: order,
              disabled: child.disabled ?? false,
            })),
          )
          .returning('id')
          .execute();
        slice.forEach(({ child }, j) => {
          if (child.default) defaults.push(made[j]?.id as number);
        });
      }
    }
    let defaultValue: unknown = body.defaultValue;
    if (defaults.length > 0) {
      if (body.defaultValue !== undefined) {
        return problem(400, 'invalid_request', { detail: 'a default given twice' });
      }
      defaultValue =
        field.type === 'cascading-select' ? defaults : field.multiple ? defaults : defaults[0];
      if (!field.multiple && field.type === 'select' && defaults.length > 1) {
        return problem(400, 'invalid_default', { problem: 'invalid' });
      }
    }
    if (defaultValue !== undefined) {
      const stored = await defaultFor(trx, workspaceId, field, context.id, defaultValue);
      if (isProblem(stored)) return stored;
      if (stored !== null) {
        await trx
          .updateTable('field_context')
          .set({ default_value: JSON.stringify(stored) })
          .where('id', '=', context.id)
          .execute();
      }
    }
    return { contextId: context.id, optionCount: total };
  }

  async function sendField(
    request: FastifyRequest,
    reply: FastifyReply,
    fieldId: number,
    code = 200,
  ) {
    const catalog = await loadCatalog(db, request.workspaceId, undefined, fieldId);
    const field = catalog.fields.get(fieldId);
    if (!field) return notFound(reply);
    return reply
      .code(code)
      .send({ field: await fieldView(db, request.workspaceId, catalog, field) });
  }

  /** Runs a change in a transaction; a returned problem rolls it back and answers. */
  async function change<T>(
    reply: FastifyReply,
    work: (trx: Transaction<Database>) => Promise<T | Problem>,
  ): Promise<T | null> {
    try {
      const result = await db.transaction().execute(async (trx) => {
        const r = await work(trx);
        // Thrown to roll back everything written before the problem was found.
        if (isProblem(r)) throw r;
        return r;
      });
      return result;
    } catch (error) {
      if (isProblem(error)) {
        await reply.code(error.status).send(error.body);
        return null;
      }
      const constraint = uniqueViolation(error);
      if (constraint === 'field_name_idx' || constraint === 'field_context_name_idx') {
        await reply.code(409).send({ error: 'name_taken' });
        return null;
      }
      if (constraint === 'field_option_value_idx') {
        await reply.code(409).send({ error: 'value_taken' });
        return null;
      }
      if (constraint === 'field_context_scope_idx') {
        await reply.code(409).send({ error: 'context_overlap' });
        return null;
      }
      throw error;
    }
  }

  // Fields

  app.get('/api/v1/fields', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const catalog = await catalogs.get(request.workspaceId);
    const trackId = parsed.data.trackId;
    if (trackId !== undefined && !(await canSeeTrack(request, trackId))) return notFound(reply);
    const visible: FieldDef[] = [];
    const seen = new Map<number, boolean>();
    for (const field of [...catalog.fields.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    )) {
      if (trackId !== undefined && field.trackId !== null && field.trackId !== trackId) continue;
      if (trackId !== undefined && field.trackId === null) {
        // Shared fields with a context covering the track.
        const covers = [...catalog.contexts.values()].some(
          (c) => c.fieldId === field.id && (c.trackIds === null || c.trackIds.includes(trackId)),
        );
        if (!covers) continue;
      }
      if (field.trackId !== null) {
        if (!seen.has(field.trackId))
          seen.set(field.trackId, await canSeeTrack(request, field.trackId));
        if (!seen.get(field.trackId)) continue;
      }
      visible.push(field);
    }
    return {
      fields: await Promise.all(
        visible.map((f) => fieldView(db, request.workspaceId, catalog, f, true)),
      ),
    };
  });

  app.get('/api/v1/fields/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id }).safeParse(request.params);
    if (!p.success) return invalid(reply);
    const field = await readable(request, p.data.id);
    if (!field) return notFound(reply);
    const catalog = await catalogs.get(request.workspaceId);
    return { field: await fieldView(db, request.workspaceId, catalog, field) };
  });

  app.post('/api/v1/fields', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = createFieldBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    if (!(await mayConfigure(request, reply, body.trackId ?? null))) return reply;
    const multiple = body.multiple ?? false;
    if (multiple && !MULTIPLE_TYPES.has(body.type)) {
      return invalid(reply, `a ${body.type} field holds one value`);
    }
    const config = defined<FieldConfig>(body.config ?? {});
    const configIssue = configProblem(body.type, multiple, config);
    if (configIssue) return invalid(reply, configIssue);
    if (body.trackId !== undefined) {
      const track = await db
        .selectFrom('track')
        .select('mode')
        .where('id', '=', body.trackId)
        .executeTakeFirst();
      if (track?.mode !== 'local') return reply.code(409).send({ error: 'track_not_local' });
    }
    const made = await change(reply, async (trx) => {
      const row = await trx
        .insertInto('field')
        .values({
          workspace_id: ws,
          track_id: body.trackId ?? null,
          name: body.name,
          description: body.description ?? '',
          type: body.type,
          multiple,
          config: JSON.stringify(config),
        })
        .returning(['id', 'created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      const field: FieldDef = {
        id: row.id,
        trackId: body.trackId ?? null,
        name: body.name,
        description: body.description ?? '',
        type: body.type,
        multiple,
        config,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      const context = await createContext(trx, ws, field, {
        ...body.context,
        name: body.context?.name ?? 'Default',
      });
      if (isProblem(context)) return context;
      await emit(trx, by(request), {
        type: 'field.created',
        subjectId: field.id,
        payload: {
          name: field.name,
          type: field.type,
          multiple,
          trackId: field.trackId,
          contextId: context.contextId,
          optionCount: context.optionCount,
        },
      });
      return field.id;
    });
    if (made === null) return reply;
    return sendField(request, reply, made, 201);
  });

  app.patch('/api/v1/fields/:id', async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return reply;
    const parsed = updateFieldBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const { field } = t;
    const config = body.config === undefined ? undefined : defined<FieldConfig>(body.config);
    if (config !== undefined) {
      const issue = configProblem(field.type, field.multiple, config);
      if (issue) return invalid(reply, issue);
    }
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const changes = diff<Record<string, unknown>>(
        { name: field.name, description: field.description, config: field.config },
        { name: body.name, description: body.description, config },
      );
      if (Object.keys(changes).length === 0) return true;
      await trx
        .updateTable('field')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(config !== undefined ? { config: JSON.stringify(config) } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', field.id)
        .execute();
      await emit(trx, by(request), {
        type: 'field.updated',
        subjectId: field.id,
        payload: { changes },
      });
      return true;
    });
    if (done === null) return reply;
    return sendField(request, reply, field.id);
  });

  app.delete('/api/v1/fields/:id', async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return reply;
    const { field } = t;
    const ws = request.workspaceId;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const ticketCount = await ticketsWithField(trx, ws, field.id);
      if (ticketCount > 0) return problem(409, 'in_use', { ticketCount });
      await trx.deleteFrom('field').where('id', '=', field.id).execute();
      // Rules naming it go with it; layouts that place it skip it from now on (M1-012).
      await trx.deleteFrom('field_rule').where('field', '=', `cf[${field.id}]`).execute();
      await emit(trx, by(request), {
        type: 'field.deleted',
        subjectId: field.id,
        payload: { name: field.name, type: field.type },
      });
      return true;
    });
    if (done === null) return reply;
    return reply.code(204).send();
  });

  // Contexts (CORE-009)

  app.post('/api/v1/fields/:id/contexts', async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return reply;
    const parsed = createContextBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, t.field.id))) return problem(404, 'not_found');
      const made = await createContext(trx, request.workspaceId, t.field, parsed.data);
      if (isProblem(made)) return made;
      await emit(trx, by(request), {
        type: 'field_context.created',
        subjectId: made.contextId,
        payload: { fieldId: t.field.id, name: parsed.data.name, optionCount: made.optionCount },
      });
      return made.contextId;
    });
    if (done === null) return reply;
    return sendField(request, reply, t.field.id, 201);
  });

  app.patch('/api/v1/fields/:id/contexts/:contextId', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context) return reply;
    const parsed = updateContextBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const { field, context } = t;
    const ws = request.workspaceId;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      let config: ContextConfig | undefined;
      if (body.config !== undefined) {
        config = { ...context.config, ...cleanConfig(body.config) };
        for (const [key, value] of Object.entries(body.config)) {
          if (value === null) delete config[key as keyof ContextConfig];
        }
      }
      const changes = diff<Record<string, unknown>>(
        {
          name: context.name,
          description: context.description,
          trackIds: context.trackIds,
          ticketTypeIds: context.ticketTypeIds,
          config: context.config,
        },
        {
          name: body.name,
          description: body.description,
          trackIds: body.trackIds,
          ticketTypeIds: body.ticketTypeIds,
          config,
        },
      );
      const set: Record<string, unknown> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.description !== undefined) set.description = body.description;
      if (changes.trackIds || changes.ticketTypeIds) {
        const trackIds = body.trackIds === undefined ? context.trackIds : body.trackIds;
        const typeIds =
          body.ticketTypeIds === undefined ? context.ticketTypeIds : body.ticketTypeIds;
        const scope = await scopeProblem(trx, ws, field, trackIds, typeIds);
        if (scope) return scope;
        const written = await writeScopes(trx, ws, field, context.id, trackIds, typeIds);
        if (written) return written;
      }
      if (config !== undefined && changes.config) {
        const issue = await contextConfigProblem(trx, ws, field, config);
        if (issue) return issue;
        set.config = JSON.stringify(config);
      }
      if (body.defaultValue !== undefined) {
        const stored = await defaultFor(trx, ws, field, context.id, body.defaultValue);
        if (isProblem(stored)) return stored;
        const before = JSON.stringify(context.defaultValue ?? null);
        if (JSON.stringify(stored) !== before) {
          set.default_value = stored === null ? null : JSON.stringify(stored);
          changes.defaultValue = { from: context.defaultValue ?? null, to: stored };
        }
      }
      if (Object.keys(changes).length === 0) return true;
      await trx
        .updateTable('field_context')
        .set({ ...set, updated_at: new Date() })
        .where('id', '=', context.id)
        .execute();
      await emit(trx, by(request), {
        type: 'field_context.updated',
        subjectId: context.id,
        payload: { fieldId: field.id, changes },
      });
      return true;
    });
    if (done === null) return reply;
    return sendField(request, reply, field.id);
  });

  app.delete('/api/v1/fields/:id/contexts/:contextId', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context) return reply;
    const { field, context } = t;
    const ws = request.workspaceId;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const optionIds = (
        await trx
          .selectFrom('field_option')
          .select('id')
          .where('context_id', '=', context.id)
          .execute()
      ).map((o) => o.id);
      const ticketCount = await ticketsWithOptions(trx, ws, field.id, optionIds);
      if (ticketCount > 0) return problem(409, 'options_in_use', { ticketCount });
      await trx.deleteFrom('field_context').where('id', '=', context.id).execute();
      await emit(trx, by(request), {
        type: 'field_context.deleted',
        subjectId: context.id,
        payload: { fieldId: field.id, name: context.name },
      });
      return true;
    });
    if (done === null) return reply;
    return reply.code(204).send();
  });

  // Options (CORE-009 (3))

  app.post('/api/v1/fields/:id/contexts/:contextId/options', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context) return reply;
    const parsed = createOptionBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const { field, context } = t;
    if (field.type !== 'select' && field.type !== 'cascading-select') {
      return invalid(reply, `a ${field.type} field has no options`);
    }
    if (body.parentId !== undefined && field.type !== 'cascading-select') {
      return invalid(reply, 'only cascading selects have children');
    }
    const ws = request.workspaceId;
    const made = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const parentId = body.parentId ?? null;
      if (parentId !== null) {
        const parent = await trx
          .selectFrom('field_option')
          .select('id')
          .where('id', '=', parentId)
          .where('context_id', '=', context.id)
          .where('parent_id', 'is', null)
          .executeTakeFirst();
        if (!parent) return problem(400, 'unknown_parent');
      }
      const counted = await trx
        .selectFrom('field_option')
        .select([
          sql<number>`count(*)::int`.as('n'),
          sql<number>`coalesce(max(sort_order) FILTER (WHERE context_id = ${context.id}
            AND parent_id IS NOT DISTINCT FROM ${parentId}::int), 0)::int`.as('last'),
        ])
        .where('field_id', '=', field.id)
        .executeTakeFirstOrThrow();
      if (counted.n >= OPTIONS_MAX) return problem(409, 'too_many_options', { max: OPTIONS_MAX });
      const row = await trx
        .insertInto('field_option')
        .values({
          workspace_id: ws,
          field_id: field.id,
          context_id: context.id,
          parent_id: parentId,
          value: body.value,
          sort_order: counted.last + 1,
          disabled: body.disabled ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'field_option.created',
        subjectId: row.id,
        payload: { fieldId: field.id, contextId: context.id, parentId, value: body.value },
      });
      return row.id;
    });
    if (made === null) return reply;
    return sendField(request, reply, field.id, 201);
  });

  app.patch('/api/v1/fields/:id/contexts/:contextId/options/:optionId', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context || t.optionId === null) return reply;
    const parsed = updateOptionBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const { field, context, optionId } = t;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const option = await trx
        .selectFrom('field_option')
        .select(['id', 'value', 'disabled'])
        .where('id', '=', optionId)
        .where('context_id', '=', context.id)
        .executeTakeFirst();
      if (!option) return problem(404, 'not_found');
      const changes = diff<Record<string, unknown>>(
        { value: option.value, disabled: option.disabled },
        body,
      );
      if (Object.keys(changes).length === 0) return true;
      await trx
        .updateTable('field_option')
        .set({ ...body, updated_at: new Date() })
        .where('id', '=', option.id)
        .execute();
      await emit(trx, by(request), {
        type: 'field_option.updated',
        subjectId: option.id,
        payload: { fieldId: field.id, contextId: context.id, changes },
      });
      return true;
    });
    if (done === null) return reply;
    return sendField(request, reply, field.id);
  });

  app.put('/api/v1/fields/:id/contexts/:contextId/options/order', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context) return reply;
    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const { field, context } = t;
    const parentId = parsed.data.parentId ?? null;
    const optionIds = parsed.data.optionIds;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const siblings = await trx
        .selectFrom('field_option')
        .select('id')
        .where('context_id', '=', context.id)
        .where(sql<boolean>`parent_id IS NOT DISTINCT FROM ${parentId}::int`)
        .execute();
      const have = new Set(siblings.map((s) => s.id));
      if (have.size !== optionIds.length || !optionIds.every((o) => have.has(o))) {
        return problem(400, 'invalid_request', {
          detail: 'optionIds must list every option under the parent once',
        });
      }
      await sql`
        UPDATE field_option o SET sort_order = n.ord, updated_at = now()
          FROM unnest(${optionIds}::int[]) WITH ORDINALITY AS n(id, ord)
         WHERE o.id = n.id`.execute(trx);
      await emit(trx, by(request), {
        type: 'field_option.reordered',
        subjectId: context.id,
        payload: { fieldId: field.id, parentId, optionIds },
      });
      return true;
    });
    if (done === null) return reply;
    return sendField(request, reply, field.id);
  });

  app.delete('/api/v1/fields/:id/contexts/:contextId/options/:optionId', async (request, reply) => {
    const t = await target(request, reply);
    if (!t?.context || t.optionId === null) return reply;
    const { field, context, optionId } = t;
    const ws = request.workspaceId;
    const done = await change(reply, async (trx) => {
      if (!(await holdField(trx, field.id))) return problem(404, 'not_found');
      const option = await trx
        .selectFrom('field_option')
        .select(['id', 'value'])
        .where('id', '=', optionId)
        .where('context_id', '=', context.id)
        .executeTakeFirst();
      if (!option) return problem(404, 'not_found');
      const children = await trx
        .selectFrom('field_option')
        .select('id')
        .where('parent_id', '=', option.id)
        .execute();
      const ticketCount = await ticketsWithOptions(trx, ws, field.id, [
        option.id,
        ...children.map((c) => c.id),
      ]);
      if (ticketCount > 0) return problem(409, 'in_use', { ticketCount });
      await trx.deleteFrom('field_option').where('id', '=', option.id).execute();
      // A default naming it names nothing now.
      const def = context.defaultValue;
      const named =
        def === undefined ? [] : Array.isArray(def) ? (def as number[]) : [def as number];
      if (named.includes(option.id) || children.some((c) => named.includes(c.id))) {
        await trx
          .updateTable('field_context')
          .set({ default_value: null, updated_at: new Date() })
          .where('id', '=', context.id)
          .execute();
      }
      await emit(trx, by(request), {
        type: 'field_option.deleted',
        subjectId: option.id,
        payload: { fieldId: field.id, contextId: context.id, value: option.value },
      });
      return true;
    });
    if (done === null) return reply;
    return reply.code(204).send();
  });

  // Reading for tickets: the fields a create offers, label suggestions, people to pick

  /** The fields tickets of a type in a track have, with what each context offers there. */
  app.get('/api/v1/tracks/:id/fields', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    const q = applicableQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = await resolveTrack(db, ws, p.data.id);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return notFound(reply);
    }
    const catalog = await catalogs.get(ws);
    return {
      fields: await describeFields(
        db,
        ws,
        catalog,
        trackId,
        q.data.ticketTypeId,
        catalog.applicable(trackId, q.data.ticketTypeId),
      ),
    };
  });

  app.get('/api/v1/fields/:id/labels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id }).safeParse(request.params);
    const q = suggestQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const field = await readable(request, p.data.id);
    if (!field || field.type !== 'labels') return notFound(reply);
    const prefix = q.data.q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await db
      .selectFrom('field_label')
      .select('name')
      .where('field_id', '=', field.id)
      .where(sql<boolean>`lower(name) LIKE ${`${prefix}%`}`)
      .orderBy('name')
      .limit(q.data.limit)
      .execute();
    return { labels: rows.map((r) => r.name) };
  });

  // The people a user picker offers for a ticket of a type in a track (CORE-009 (2)).
  app.get('/api/v1/fields/:id/people', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id }).safeParse(request.params);
    const q = peopleQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const field = await readable(request, p.data.id);
    if (!field || field.type !== 'user') return notFound(reply);
    const trackId = await resolveTrack(db, ws, q.data.track);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return notFound(reply);
    }
    const catalog = await catalogs.get(ws);
    const context = catalog.contextOf(field.id, trackId, q.data.ticketTypeId);
    if (!context) return reply.code(409).send({ error: 'not_applicable' });
    const allowed = await allowedPeople(
      db,
      { workspaceId: ws, trackId, ticketTypeId: q.data.ticketTypeId },
      context,
    );
    if (allowed !== 'all' && allowed.size === 0) return { people: [] };
    const text = q.data.q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`);
    let query = db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where('deactivated_at', 'is', null)
      .where('kind', '=', 'person');
    if (allowed !== 'all') query = query.where('id', 'in', [...allowed]);
    if (text !== '') {
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE ${`%${text}%`}`,
          sql<boolean>`lower(email) LIKE ${`${text}%`}`,
        ]),
      );
    }
    const rows = await query.orderBy('name').orderBy('id').limit(q.data.limit).execute();
    return { people: rows.map((r) => ({ id: r.id, name: r.name })) };
  });
}

export type FieldView = Awaited<ReturnType<typeof fieldView>>;
