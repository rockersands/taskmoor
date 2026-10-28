import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { Catalog, FieldCatalogs } from '../fields/catalog';
import {
  customFieldId,
  FIXED_FIELDS,
  type FormPlacement,
  isFieldKey,
  layoutDefinition,
  OPERATIONS,
  resolveLayout,
} from '../fields/layouts';
import { describeFields } from '../fields/values';
import { loadTicket, resolveTicket, resolveTrack } from '../tickets/store';

/**
 * Field rule sets and layout sets (M1-012; CORE-003, CORE-008, CORE-013; spec 01a section 1.5).
 * The rules live in `fields/layouts.ts`; the ticket routes enforce them.
 *
 * - Shared sets belong to the workspace: everyone signed in reads them, site and configuration
 *   administrators change them, and a save names every track that uses the set (CORE-003 (2):
 *   `usedBy`, also read before saving). A local-mode track's own sets are changed by its
 *   administrators and name only its fields.
 * - A save replaces the set's rules or layouts as a whole; each is checked: known fields (a
 *   system field or a custom field that exists), never the summary made optional or hidden,
 *   never required and hidden together, a layout naming each field once.
 * - The default sets cannot be deleted; a set in use by a track is not deleted either.
 * - `GET /api/v1/tracks/:id/layout` and `GET /api/v1/tickets/:id/layout` give the form an
 *   operation shows, with required marks, help text and the custom fields it needs.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const idValue = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const fieldKey = z.string().refine(isFieldKey, 'a system field name or cf[id]');

const ruleBody = z
  .object({
    ticketTypeId: idValue.nullable().default(null),
    field: fieldKey,
    required: z.boolean().default(false),
    hidden: z.boolean().default(false),
    description: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .refine((r) => !(r.required && r.hidden), 'a field is not required and hidden at once');
const layoutBody = z
  .object({
    ticketTypeId: idValue.nullable().default(null),
    operation: z.enum(OPERATIONS),
    definition: layoutDefinition,
  })
  .strict();
const createRuleSetBody = z
  .object({
    name,
    description: description.optional(),
    trackId: idValue.optional(),
    rules: z.array(ruleBody).max(20_000).optional(),
  })
  .strict();
const updateRuleSetBody = z
  .object({ name, description, rules: z.array(ruleBody).max(20_000) })
  .partial()
  .strict();
const createLayoutSetBody = z
  .object({
    name,
    description: description.optional(),
    trackId: idValue.optional(),
    layouts: z.array(layoutBody).max(1000).optional(),
  })
  .strict();
const updateLayoutSetBody = z
  .object({ name, description, layouts: z.array(layoutBody).max(1000) })
  .partial()
  .strict();
const listQuery = z.object({ trackId: id.optional() }).strict();
const trackLayoutQuery = z
  .object({ ticketTypeId: id, operation: z.enum(OPERATIONS).default('create') })
  .strict();
const ticketLayoutQuery = z
  .object({ operation: z.enum(['edit', 'view']).default('view') })
  .strict();

type Rule = z.infer<typeof ruleBody>;
type Layout = z.infer<typeof layoutBody>;
type Kind = 'field_rule_set' | 'layout_set';
type Problem = { status: number; body: Record<string, unknown> };
const problem = (status: number, error: string, extra: Record<string, unknown> = {}): Problem => ({
  status,
  body: { error, ...extra },
});
const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const zodDetail = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

export function registerLayoutRoutes(
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

  /** Administrators change shared sets; a local-mode track's administrators its own. */
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
      .select(['mode', 'archived_at', 'deleted_at'])
      .where('id', '=', ownerTrackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!track || track.deleted_at || !(await canSeeTrack(request, ownerTrackId))) {
      await notFound(reply);
      return false;
    }
    if (track.mode !== 'local') {
      await reply.code(409).send({ error: 'track_not_local' });
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

  /** The tracks using a set: those naming it, and for a default set those naming none. */
  async function usedBy(
    trx: Kysely<Database> | Transaction<Database>,
    kind: Kind,
    setId: number,
    isDefault: boolean,
  ) {
    const column = kind === 'field_rule_set' ? 'field_rule_set_id' : 'layout_set_id';
    return trx
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where((eb) =>
        isDefault
          ? eb.or([eb(column, '=', setId), eb(column, 'is', null)])
          : eb(column, '=', setId),
      )
      .where('deleted_at', 'is', null)
      .orderBy('key')
      .execute();
  }

  /** Fields a set names must exist; a local set's custom fields are shared or its track's. */
  function fieldProblem(catalog: Catalog, ownerTrackId: number | null, key: string): string | null {
    const fieldId = customFieldId(key);
    if (fieldId === null) return null;
    const field = catalog.fields.get(fieldId);
    if (!field) return `unknown field ${key}`;
    if (field.trackId !== null && field.trackId !== ownerTrackId)
      return `${key} belongs to another track`;
    return null;
  }

  async function typeProblem(trx: Transaction<Database>, ws: number, typeIds: (number | null)[]) {
    const ids = [...new Set(typeIds.filter((t): t is number => t !== null))];
    if (ids.length === 0) return null;
    const rows = await trx
      .selectFrom('ticket_type')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('id', 'in', ids)
      .execute();
    return rows.length === ids.length ? null : problem(400, 'unknown_ticket_type');
  }

  async function writeRules(
    trx: Transaction<Database>,
    ws: number,
    catalog: Catalog,
    setId: number,
    ownerTrackId: number | null,
    rules: readonly Rule[],
  ): Promise<Problem | null> {
    const seen = new Set<string>();
    for (const r of rules) {
      if (FIXED_FIELDS.has(r.field)) {
        return problem(400, 'invalid_request', {
          detail: `${r.field} is always required and shown`,
        });
      }
      const issue = fieldProblem(catalog, ownerTrackId, r.field);
      if (issue) return problem(400, 'invalid_request', { detail: issue });
      const key = `${r.ticketTypeId ?? 0}|${r.field}`;
      if (seen.has(key)) return problem(400, 'invalid_request', { detail: `${r.field} twice` });
      seen.add(key);
    }
    const types = await typeProblem(
      trx,
      ws,
      rules.map((r) => r.ticketTypeId),
    );
    if (types) return types;
    await trx.deleteFrom('field_rule').where('rule_set_id', '=', setId).execute();
    for (let i = 0; i < rules.length; i += 2000) {
      await trx
        .insertInto('field_rule')
        .values(
          rules.slice(i, i + 2000).map((r) => ({
            workspace_id: ws,
            rule_set_id: setId,
            ticket_type_id: r.ticketTypeId,
            field: r.field,
            required: r.required,
            hidden: r.hidden,
            description: r.description,
          })),
        )
        .execute();
    }
    return null;
  }

  async function writeLayouts(
    trx: Transaction<Database>,
    ws: number,
    catalog: Catalog,
    setId: number,
    ownerTrackId: number | null,
    layouts: readonly Layout[],
  ): Promise<Problem | null> {
    const seen = new Set<string>();
    for (const l of layouts) {
      const key = `${l.ticketTypeId ?? 0}|${l.operation}`;
      if (seen.has(key)) {
        return problem(400, 'invalid_request', {
          detail: `two ${l.operation} layouts for one type`,
        });
      }
      seen.add(key);
      for (const f of l.definition.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields))) {
        const issue = fieldProblem(catalog, ownerTrackId, f);
        if (issue) return problem(400, 'invalid_request', { detail: issue });
      }
    }
    const types = await typeProblem(
      trx,
      ws,
      layouts.map((l) => l.ticketTypeId),
    );
    if (types) return types;
    await trx.deleteFrom('layout').where('layout_set_id', '=', setId).execute();
    if (layouts.length > 0) {
      await trx
        .insertInto('layout')
        .values(
          layouts.map((l) => ({
            workspace_id: ws,
            layout_set_id: setId,
            ticket_type_id: l.ticketTypeId,
            operation: l.operation,
            definition: JSON.stringify(l.definition),
          })),
        )
        .execute();
    }
    return null;
  }

  async function view(kind: Kind, setId: number, ws: number) {
    const row = await db
      .selectFrom(kind)
      .selectAll()
      .where('id', '=', setId)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!row) return null;
    const base = {
      id: row.id,
      name: row.name,
      description: row.description,
      trackId: row.track_id,
      isDefault: row.is_default,
      usedBy: await usedBy(db, kind, row.id, row.is_default),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
    if (kind === 'field_rule_set') {
      const rules = await db
        .selectFrom('field_rule')
        .select(['ticket_type_id', 'field', 'required', 'hidden', 'description'])
        .where('rule_set_id', '=', row.id)
        .orderBy('field')
        .orderBy(sql`coalesce(ticket_type_id, 0)`)
        .execute();
      return {
        ...base,
        rules: rules.map((r) => ({
          ticketTypeId: r.ticket_type_id,
          field: r.field,
          required: r.required,
          hidden: r.hidden,
          description: r.description,
        })),
      };
    }
    const layouts = await db
      .selectFrom('layout')
      .select(['ticket_type_id', 'operation', 'definition'])
      .where('layout_set_id', '=', row.id)
      .orderBy(sql`coalesce(ticket_type_id, 0)`)
      .orderBy('operation')
      .execute();
    return {
      ...base,
      layouts: layouts.map((l) => ({
        ticketTypeId: l.ticket_type_id,
        operation: l.operation,
        definition: l.definition,
      })),
    };
  }

  /** Runs a change; a returned problem rolls it back and answers. */
  async function change<T>(
    reply: FastifyReply,
    work: (trx: Transaction<Database>) => Promise<T | Problem>,
  ): Promise<T | null> {
    try {
      return await db.transaction().execute(async (trx) => {
        const r = await work(trx);
        if (isProblem(r)) throw r;
        return r;
      });
    } catch (error) {
      if (isProblem(error)) {
        await reply.code(error.status).send(error.body);
        return null;
      }
      const constraint = uniqueViolation(error);
      if (constraint === 'field_rule_set_name_idx' || constraint === 'layout_set_name_idx') {
        await reply.code(409).send({ error: 'name_taken' });
        return null;
      }
      throw error;
    }
  }

  for (const kind of ['field_rule_set', 'layout_set'] as const) {
    const path = kind === 'field_rule_set' ? '/api/v1/field-rule-sets' : '/api/v1/layout-sets';
    const reply1 = kind === 'field_rule_set' ? 'fieldRuleSet' : 'layoutSet';
    const plural = kind === 'field_rule_set' ? 'fieldRuleSets' : 'layoutSets';

    app.get(path, async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success) return invalid(reply);
      const ws = request.workspaceId;
      let query = db
        .selectFrom(kind)
        .select(['id', 'name', 'description', 'track_id', 'is_default'])
        .where('workspace_id', '=', ws);
      const trackId = parsed.data.trackId;
      if (trackId !== undefined) {
        if (!(await canSeeTrack(request, trackId))) return notFound(reply);
        query = query.where((eb) =>
          eb.or([eb('track_id', 'is', null), eb('track_id', '=', trackId)]),
        );
      }
      const rows = await query.orderBy('is_default', 'desc').orderBy('name').execute();
      const seen = new Map<number, boolean>();
      const out = [];
      for (const r of rows) {
        if (r.track_id !== null) {
          if (!seen.has(r.track_id)) seen.set(r.track_id, await canSeeTrack(request, r.track_id));
          if (!seen.get(r.track_id)) continue;
        }
        out.push({
          id: r.id,
          name: r.name,
          description: r.description,
          trackId: r.track_id,
          isDefault: r.is_default,
        });
      }
      return { [plural]: out };
    });

    app.get(`${path}/:id`, async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const p = z.object({ id }).safeParse(request.params);
      if (!p.success) return invalid(reply);
      const set = await view(kind, p.data.id, request.workspaceId);
      if (!set || (set.trackId !== null && !(await canSeeTrack(request, set.trackId)))) {
        return notFound(reply);
      }
      return { [reply1]: set };
    });

    app.post(path, async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const parsed = (
        kind === 'field_rule_set' ? createRuleSetBody : createLayoutSetBody
      ).safeParse(request.body);
      if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
      const body = parsed.data as z.infer<typeof createRuleSetBody> &
        z.infer<typeof createLayoutSetBody>;
      const ws = request.workspaceId;
      const owner = body.trackId ?? null;
      if (!(await mayConfigure(request, reply, owner))) return reply;
      const catalog = await catalogs.get(ws);
      const made = await change(reply, async (trx) => {
        const row = await trx
          .insertInto(kind)
          .values({
            workspace_id: ws,
            track_id: owner,
            name: body.name,
            description: body.description ?? '',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const written =
          kind === 'field_rule_set'
            ? await writeRules(trx, ws, catalog, row.id, owner, body.rules ?? [])
            : await writeLayouts(trx, ws, catalog, row.id, owner, body.layouts ?? []);
        if (written) return written;
        await emit(trx, by(request), {
          type: `${kind}.created`,
          subjectId: row.id,
          payload: {
            name: body.name,
            trackId: owner,
            count: (kind === 'field_rule_set' ? body.rules : body.layouts)?.length ?? 0,
          },
        });
        return row.id;
      });
      if (made === null) return reply;
      return reply.code(201).send({ [reply1]: await view(kind, made, ws) });
    });

    app.patch(`${path}/:id`, async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const p = z.object({ id }).safeParse(request.params);
      const parsed = (
        kind === 'field_rule_set' ? updateRuleSetBody : updateLayoutSetBody
      ).safeParse(request.body);
      if (!p.success) return invalid(reply);
      if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
      const body = parsed.data as z.infer<typeof updateRuleSetBody> &
        z.infer<typeof updateLayoutSetBody>;
      const ws = request.workspaceId;
      const current = await view(kind, p.data.id, ws);
      if (
        !current ||
        (current.trackId !== null && !(await canSeeTrack(request, current.trackId)))
      ) {
        return notFound(reply);
      }
      if (!(await mayConfigure(request, reply, current.trackId))) return reply;
      const catalog = await catalogs.get(ws);
      const done = await change(reply, async (trx) => {
        const locked = await trx
          .selectFrom(kind)
          .select('id')
          .where('id', '=', current.id)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return problem(404, 'not_found');
        const entries = kind === 'field_rule_set' ? body.rules : body.layouts;
        const before =
          kind === 'field_rule_set'
            ? (current as { rules: unknown }).rules
            : (current as { layouts: unknown }).layouts;
        const changes = diff<Record<string, unknown>>(
          { name: current.name, description: current.description, entries: before },
          { name: body.name, description: body.description, entries },
        );
        if (Object.keys(changes).length === 0) return true;
        if (body.name !== undefined || body.description !== undefined) {
          await trx
            .updateTable(kind)
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', current.id)
            .execute();
        }
        if (changes.entries) {
          const written =
            kind === 'field_rule_set'
              ? await writeRules(trx, ws, catalog, current.id, current.trackId, body.rules ?? [])
              : await writeLayouts(
                  trx,
                  ws,
                  catalog,
                  current.id,
                  current.trackId,
                  body.layouts ?? [],
                );
          if (written) return written;
          await trx
            .updateTable(kind)
            .set({ updated_at: new Date() })
            .where('id', '=', current.id)
            .execute();
        }
        // A shared set reaches every track that uses it; the event names them (CORE-003 (2)).
        const tracks = (await usedBy(trx, kind, current.id, current.isDefault)).map((t) => t.id);
        await emit(trx, by(request), {
          type: `${kind}.updated`,
          subjectId: current.id,
          payload: {
            changes: Object.fromEntries(
              Object.entries(changes).map(([k, v]) =>
                k === 'entries' ? [kind === 'field_rule_set' ? 'rules' : 'layouts', v] : [k, v],
              ),
            ),
            trackIds: tracks,
          },
        });
        return true;
      });
      if (done === null) return reply;
      return { [reply1]: await view(kind, current.id, ws) };
    });

    app.delete(`${path}/:id`, async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const p = z.object({ id }).safeParse(request.params);
      if (!p.success) return invalid(reply);
      const ws = request.workspaceId;
      const current = await view(kind, p.data.id, ws);
      if (
        !current ||
        (current.trackId !== null && !(await canSeeTrack(request, current.trackId)))
      ) {
        return notFound(reply);
      }
      if (!(await mayConfigure(request, reply, current.trackId))) return reply;
      if (current.isDefault) return reply.code(409).send({ error: 'default' });
      const done = await change(reply, async (trx) => {
        await trx.selectFrom(kind).select('id').where('id', '=', current.id).forUpdate().execute();
        const tracks = await usedBy(trx, kind, current.id, false);
        if (tracks.length > 0) return problem(409, 'in_use', { trackCount: tracks.length });
        await trx.deleteFrom(kind).where('id', '=', current.id).execute();
        await emit(trx, by(request), {
          type: `${kind}.deleted`,
          subjectId: current.id,
          payload: { name: current.name },
        });
        return true;
      });
      if (done === null) return reply;
      return reply.code(204).send();
    });
  }

  // The form an operation shows (CORE-008, CORE-013)

  async function formOf(ws: number, at: FormPlacement, operation: (typeof OPERATIONS)[number]) {
    const catalog = await catalogs.get(ws);
    const layout = resolveLayout(catalog, at, operation);
    const keys = layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key)));
    const customs = keys
      .map(customFieldId)
      .filter((fieldId): fieldId is number => fieldId !== null)
      .map((fieldId) => catalog.fields.get(fieldId))
      .filter((f) => f !== undefined);
    return {
      layout,
      customFields: await describeFields(db, ws, catalog, at.trackId, at.ticketTypeId, customs),
    };
  }

  app.get('/api/v1/tracks/:id/layout', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    const q = trackLayoutQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = await resolveTrack(db, ws, p.data.id);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return notFound(reply);
    }
    const track = await db
      .selectFrom('track')
      .select(['field_rule_set_id', 'layout_set_id'])
      .where('id', '=', trackId)
      .executeTakeFirstOrThrow();
    return formOf(
      ws,
      {
        trackId,
        ticketTypeId: q.data.ticketTypeId,
        ruleSetId: track.field_rule_set_id,
        layoutSetId: track.layout_set_id,
      },
      q.data.operation,
    );
  });

  app.get('/api/v1/tickets/:id/layout', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    const q = ticketLayoutQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const row = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      return notFound(reply);
    }
    return formOf(
      ws,
      {
        trackId: row.track_id,
        ticketTypeId: row.ticket_type_id,
        ruleSetId: row.rule_set_id,
        layoutSetId: row.layout_set_id,
      },
      q.data.operation,
    );
  });
}
