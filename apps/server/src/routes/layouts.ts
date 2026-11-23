import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { TrackPermission } from '../authz/permissions';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  applicableKeys,
  customFieldId,
  type FormPlacement,
  fieldLocks,
  holderList,
  holdersJson,
  holdersOf,
  isFieldKey,
  type LayoutDefinition,
  layoutDefinition,
  layoutFor,
  leftOutBecause,
  OPERATIONS,
  resolveDefinition,
  resolveLayout,
} from '../fields/layouts';
import { checkLayouts, writeLayouts, writeRules } from '../fields/sets';
import { describeFields } from '../fields/values';
import { trackPrioritySet } from '../tickets/fields';
import { loadTicket, resolveTicket, resolveTrack, type TicketRow } from '../tickets/store';
import {
  fieldLockList,
  LOCK_ACTIONS,
  type Lock,
  type LockAction,
  statusGate,
  statusLock,
} from '../workflows/locks';

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
 *   operation shows, with required marks, help text and the custom fields it needs. The track's
 *   create form also says, in `withheld`, which of its fields the caller lacks the track
 *   permission to set on a new ticket (Assign tickets, Schedule tickets and so on; IAM-010), so
 *   the form leaves them out rather than offer what the create route would refuse.
 * - `POST /api/v1/layout-sets/:id/preview` gives the form a set's layouts, or a draft of them,
 *   would show for a ticket type and operation in a track (the layout editor's live preview,
 *   UI-T15; ADR-114). It checks a draft as a save would and stores nothing: a read. Anyone who
 *   reads the set may preview its saved layouts; a draft comes only from those who may change it.
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
    editableBy: holderList.nullable().default(null),
  })
  .strict()
  .refine((r) => !(r.required && r.hidden), 'a field is not required and hidden at once')
  // A field everyone must fill in but only some may set would stop the others from creating.
  .refine((r) => !(r.required && r.editableBy), 'a field is not required and restricted at once')
  .refine((r) => !(r.hidden && r.editableBy), 'a hidden field takes no editors');
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
/**
 * A preview: the form for a type and operation, in a track (null: none, so the fields every
 * track has and the default rules; left out: a local set's own track, else none), from the
 * draft layouts given or, without them, the set's saved ones.
 */
export const previewBody = z
  .object({
    ticketTypeId: idValue,
    operation: z.enum(OPERATIONS),
    trackId: idValue.nullable().optional(),
    layouts: z.array(layoutBody).max(1000).optional(),
  })
  .strict();
const listQuery = z.object({ trackId: id.optional() }).strict();
/**
 * The fields the create route refuses unless the caller holds a track permission beyond Create
 * tickets (`POST /api/v1/tickets` in tickets.ts): who may be named, dates and the close reason.
 */
const CREATE_PERMISSIONS: readonly (readonly [string, TrackPermission])[] = [
  ['assignee', 'assign_tickets'],
  ['requester', 'modify_requester'],
  ['startDate', 'schedule_tickets'],
  ['dueDate', 'schedule_tickets'],
  ['closeReason', 'set_close_reason'],
];

const trackLayoutQuery = z
  .object({ ticketTypeId: id, operation: z.enum(OPERATIONS).default('create') })
  .strict();
const ticketLayoutQuery = z
  .object({ operation: z.enum(['edit', 'view']).default('view') })
  .strict();

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
    if (await mayChange(request, ownerTrackId)) return true;
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /** Who could save a set, its track's state aside: `mayConfigure` without an answer. */
  async function mayChange(request: FastifyRequest, ownerTrackId: number | null) {
    if (ownerTrackId !== null && (await request.authz.can('administer_track', ownerTrackId))) {
      return true;
    }
    return isAdmin(request);
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
        .select(['ticket_type_id', 'field', 'required', 'hidden', 'description', 'editable_by'])
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
          editableBy: (() => {
            const holders = holdersOf(r.editable_by);
            return holders ? holdersJson(holders) : null;
          })(),
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

  // The layout editor's live preview (UI-T15; ADR-114 section 8; CORE-008, CORE-013): what a
  // set's layouts, or a draft of them, would show. Whoever may read the set may ask about its
  // saved layouts; the track must be one they see, and so must the ticket type. A draft is
  // checked as a save checks it, so the editor hears the server's verdict before saving; only
  // those who could save the set send one, since that verdict tells a field or type of a track
  // they do not see from one that does not exist. Nothing is stored and no event is emitted.
  app.post('/api/v1/layout-sets/:id/preview', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id }).safeParse(request.params);
    const parsed = previewBody.safeParse(request.body);
    if (!p.success) return invalid(reply);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const ws = request.workspaceId;
    const body = parsed.data;
    const set = await db
      .selectFrom('layout_set')
      .select(['id', 'track_id'])
      .where('id', '=', p.data.id)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!set || (set.track_id !== null && !(await canSeeTrack(request, set.track_id)))) {
      return notFound(reply);
    }
    if (body.layouts && !(await mayChange(request, set.track_id))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const trackId = body.trackId === undefined ? set.track_id : body.trackId;
    let ruleSetId: number | null = null;
    if (trackId !== null) {
      const track = await db
        .selectFrom('track')
        .select(['field_rule_set_id', 'deleted_at'])
        .where('id', '=', trackId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!track || track.deleted_at || !(await canSeeTrack(request, trackId))) {
        return notFound(reply);
      }
      ruleSetId = track.field_rule_set_id;
    }
    // A local-mode track's own type is unknown to whoever does not see that track, as on
    // `GET /api/v1/ticket-types/:id`: one answer for both.
    const type = await db
      .selectFrom('ticket_type')
      .select('owner_track_id')
      .where('id', '=', body.ticketTypeId)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (
      !type ||
      (type.owner_track_id !== null && !(await canSeeTrack(request, type.owner_track_id)))
    ) {
      return reply.code(400).send({ error: 'unknown_ticket_type' });
    }
    const catalog = await catalogs.get(ws);
    let layouts: ReadonlyMap<string, LayoutDefinition>;
    if (body.layouts) {
      const problem = await checkLayouts(db, ws, catalog, set.track_id, body.layouts);
      if (problem) return reply.code(problem.status).send(problem.body);
      layouts = new Map(
        body.layouts.map((l) => [`${l.ticketTypeId ?? 0}|${l.operation}`, l.definition]),
      );
    } else {
      layouts = catalog.forms.layoutSets.get(set.id)?.layouts ?? new Map();
    }
    // Without a track, the fields every track has: track 0 matches no track's own context.
    const at: FormPlacement = {
      trackId: trackId ?? 0,
      ticketTypeId: body.ticketTypeId,
      ruleSetId,
      layoutSetId: set.id,
    };
    const chosen = layoutFor(layouts, body.ticketTypeId, body.operation);
    const layout = resolveDefinition(catalog, at, body.operation, chosen?.definition ?? null);
    // What the layout places that the form will not show, and why.
    const applies = new Set(applicableKeys(catalog, at));
    const leftOut = (chosen?.definition.tabs ?? []).flatMap((tab) =>
      tab.sections.flatMap((section) =>
        section.fields.flatMap((field) => {
          const reason = leftOutBecause(catalog, at, body.operation, field, applies);
          return reason ? [{ field, reason }] : [];
        }),
      ),
    );
    const keys = [
      ...layout.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.fields.map((f) => f.key))),
      ...leftOut.map((l) => l.field),
    ];
    const customFields = [...new Set(keys.map(customFieldId))]
      .filter((fieldId): fieldId is number => fieldId !== null)
      .flatMap((fieldId) => {
        const def = catalog.fields.get(fieldId);
        // Its type too, so the editor's preview knows a list of the track's releases or areas,
        // which the create form leaves out when the track has none (T-359).
        return def ? [{ id: def.id, name: def.name, type: def.type }] : [];
      });
    return { preview: { source: chosen?.source ?? 'none', layout, leftOut, customFields } };
  });

  // The form an operation shows (CORE-008, CORE-013)

  /**
   * The form and, for create and edit, what the person may not change on it and why (M1-029):
   * the status's edit lock on an existing ticket (every field), then each field only some roles
   * or groups may set. The client shows those fields read-only with the reason (WF-007 (2)).
   */
  async function formOf(
    request: FastifyRequest,
    at: FormPlacement,
    operation: (typeof OPERATIONS)[number],
    ticket?: TicketRow,
  ) {
    const ws = request.workspaceId;
    const catalog = await catalogs.get(ws);
    const layout = resolveLayout(catalog, at, operation);
    const keys = layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key)));
    const customs = keys
      .map(customFieldId)
      .filter((fieldId): fieldId is number => fieldId !== null)
      .map((fieldId) => catalog.fields.get(fieldId))
      .filter((f) => f !== undefined);
    const locks: Lock[] = [];
    if (operation !== 'view') {
      const gate = await statusGate(
        db,
        request,
        at.trackId,
        ticket?.ticket_type_id ?? at.ticketTypeId,
      );
      const edit = ticket ? gate.check(ticket.status_id, 'edit') : null;
      if (ticket && edit) locks.push(await statusLock(db, ws, ticket.status_id, edit));
      locks.push(...(await fieldLockList(db, fieldLocks(catalog, at, keys, gate.audience))));
    }
    return {
      layout,
      customFields: await describeFields(db, ws, catalog, at.trackId, at.ticketTypeId, customs),
      locks,
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
    const form = await formOf(
      request,
      {
        trackId,
        ticketTypeId: q.data.ticketTypeId,
        ruleSetId: track.field_rule_set_id,
        layoutSetId: track.layout_set_id,
      },
      q.data.operation,
    );
    // What the form preselects and offers, so it shows what a new ticket would get (CORE-014 (2)).
    const set = await trackPrioritySet(db, ws, trackId);
    const keys = new Set(
      form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key))),
    );
    const held = q.data.operation === 'create' ? await request.authz.track(trackId) : null;
    const withheld = held
      ? CREATE_PERMISSIONS.filter(([key, needs]) => keys.has(key) && !held.has(needs)).map(
          ([key]) => key,
        )
      : [];
    return {
      ...form,
      ...(held ? { withheld } : {}),
      priorities: {
        defaultId: set?.defaultPriorityId ?? null,
        offered: [...(set?.priorityIds ?? [])],
      },
    };
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
      request,
      {
        trackId: row.track_id,
        ticketTypeId: row.ticket_type_id,
        ruleSetId: row.rule_set_id,
        layoutSetId: row.layout_set_id,
      },
      q.data.operation,
      row,
    );
  });

  // What a status keeps the person from doing to a ticket, and who may (WF-007): the ticket
  // view greys those controls out and says why.
  app.get('/api/v1/tickets/:id/locks', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const row = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      return notFound(reply);
    }
    const gate = await statusGate(db, request, row.track_id, row.ticket_type_id);
    const locks: Partial<Record<LockAction, Lock>> = {};
    for (const action of LOCK_ACTIONS) {
      const allowed = gate.check(row.status_id, action);
      if (allowed) locks[action] = await statusLock(db, ws, row.status_id, allowed);
    }
    return { locks };
  });
}
