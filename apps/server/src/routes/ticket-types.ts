import type { Database, TrackType } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import {
  hierarchyTickets,
  loadHierarchy,
  lockHierarchy,
  mapTicketTypes,
  setMembers,
  type TicketTypeRow,
  ticketsOfTypes,
  ticketTypeMapping,
  ticketTypeQuery,
  ticketTypeView,
} from '../tickets/configuration';
import {
  applyChange,
  breaksTickets,
  customRankRange,
  type Hierarchy,
  type HierarchyChange,
  type HierarchyImpact,
  hierarchyImpact,
  type Level,
  typeRanks,
} from '../tickets/hierarchy';
import { TRACK_TYPES } from '../tracks/model';

/**
 * Hierarchy levels, ticket types and type sets (M1-007; CORE-005 to CORE-007, spec 01a
 * sections 1.1, 1.2 and 1.5). The rules live in `tickets/hierarchy.ts`.
 *
 * - Levels belong to the workspace: a parent may sit in another track (rule 5), so every
 *   track sees the same ladder. Everyone signed in reads it; site and configuration
 *   administrators add, rename, move and remove levels. The built-in levels are renamed but
 *   never moved or removed.
 * - A shared ticket type or type set is changed by site and configuration administrators. A
 *   local-mode track owns its type set (a copy made with the track) and may own ticket types;
 *   its track administrators change those (section 1.1: nothing leaks to other tracks).
 * - Every change to the ladder, or to the level of a ticket type, takes the workspace's
 *   hierarchy lock, computes the new ladder and its impact on tickets, and is refused with
 *   that impact when it would break a parent link (CORE-007 (1);
 *   `GET /api/v1/hierarchy-levels/impact` previews it). Ticket writes that check levels hold
 *   the same lock shared (M1-008).
 * - A type set that drops a type, or a track that switches to a set without it, maps the
 *   type's tickets to another type at its level (`ticketTypeMapping`, CORE-005 (2)).
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const rank = z.coerce.number().int().min(-MAX_INT).max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const icon = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'an icon name: lower-case letters, digits and hyphens');
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour as #rrggbb')
  .transform((c) => c.toLowerCase());
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

const levelBody = z.object({ name, description: description.optional(), rank: rank.optional() });
const createLevelBody = levelBody.strict();
const updateLevelBody = levelBody.partial().strict();
const impactQuery = z.discriminatedUnion('change', [
  z.object({ change: z.literal('insert'), rank: rank.optional() }).strict(),
  z.object({ change: z.literal('move'), levelId: id, rank }).strict(),
  z.object({ change: z.literal('remove'), levelId: id }).strict(),
  z.object({ change: z.literal('retype'), typeId: id, levelId: id }).strict(),
]);

const typeFields = {
  name,
  description,
  icon: icon.nullable(),
  color: color.nullable(),
  levelId: id,
};
const createTypeBody = z
  .object({
    name: typeFields.name,
    description: typeFields.description.optional(),
    icon: typeFields.icon.optional(),
    color: typeFields.color.optional(),
    levelId: typeFields.levelId,
    /** A local-mode track that owns the type; shared when left out. */
    trackId: id.optional(),
  })
  .strict();
const updateTypeBody = z.object(typeFields).partial().strict();
const typeListQuery = z.object({ trackId: id.optional() }).strict();

const typeSetFields = {
  name,
  description,
  ticketTypeIds: z.array(id).min(1).max(1000).refine(unique, 'each type once'),
  defaultTypeId: id.nullable(),
  defaultFor: z.array(z.enum(TRACK_TYPES)).refine(unique, 'each track type once'),
};
const createTypeSetBody = z
  .object({
    name: typeSetFields.name,
    description: typeSetFields.description.optional(),
    ticketTypeIds: typeSetFields.ticketTypeIds,
    defaultTypeId: typeSetFields.defaultTypeId.optional(),
    defaultFor: typeSetFields.defaultFor.optional(),
  })
  .strict();
const updateTypeSetBody = z
  .object({ ...typeSetFields, ticketTypeMapping })
  .partial()
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}
const foreignKeyViolation = (error: unknown) => (error as { code?: string }).code === '23503';

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** Track types in their canonical order, so lists compare by content. */
const inTrackTypeOrder = (types: readonly TrackType[]) =>
  TRACK_TYPES.filter((t) => types.includes(t));

function levelView(row: {
  id: number;
  kind: string;
  rank: number;
  name: string;
  description: string;
}) {
  return {
    id: row.id,
    kind: row.kind,
    rank: row.rank,
    name: row.name,
    description: row.description,
  };
}

async function levelRows(db: Db, workspaceId: number) {
  return db
    .selectFrom('hierarchy_level')
    .select(['id', 'kind', 'rank', 'name', 'description'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('rank', 'desc')
    .execute();
}

/** Levels whose rank differs between two ladders, lowest first; `except` is left out. */
function shiftedLevels(before: readonly Level[], after: readonly Level[], except?: number) {
  const now = new Map(after.map((l) => [l.id, l.rank]));
  return before
    .filter((l) => l.id !== except && now.has(l.id) && now.get(l.id) !== l.rank)
    .map((l) => ({ levelId: l.id, from: l.rank, to: now.get(l.id) as number }))
    .sort((a, b) => a.from - b.from);
}

/** Writes the new ranks of levels that moved (the unique rank constraint is deferred). */
async function writeRanks(
  trx: Transaction<Database>,
  shifted: readonly { levelId: number; to: number }[],
) {
  for (const { levelId, to } of shifted) {
    await trx
      .updateTable('hierarchy_level')
      .set({ rank: to, updated_at: new Date() })
      .where('id', '=', levelId)
      .execute();
  }
}

function impactView(impact: HierarchyImpact) {
  return {
    ...impact,
    brokenLinkCount: impact.brokenLinks.length,
    breaksTickets: breaksTickets(impact),
  };
}

type Planned =
  | { ok: false; status: number; error: string; detail?: unknown }
  | { ok: true; before: Hierarchy; after: Hierarchy; impact: HierarchyImpact };

/** Applies a change to the workspace's ladder in memory and measures its impact. */
async function plan(db: Db, workspaceId: number, change: HierarchyChange): Promise<Planned> {
  const { hierarchy } = await loadHierarchy(db, workspaceId);
  const result = applyChange(hierarchy, change);
  if (!result.ok) {
    switch (result.problem) {
      case 'unknown_level':
      case 'unknown_type':
        return { ok: false, status: 400, error: 'invalid_request', detail: result.problem };
      case 'builtin_level':
        return { ok: false, status: 409, error: 'builtin_level' };
      case 'rank_out_of_range':
        return {
          ok: false,
          status: 400,
          error: 'rank_out_of_range',
          detail: customRankRange(hierarchy.levels, change.kind === 'insert'),
        };
      case 'level_exists':
        return { ok: false, status: 409, error: 'level_exists' };
    }
  }
  // Only tickets of types whose level changes, with their parents and children, can break.
  const was = typeRanks(hierarchy);
  const now = typeRanks(result.hierarchy);
  const moved = [...was].filter(([typeId, rank]) => now.get(typeId) !== rank).map(([id]) => id);
  const tickets = await hierarchyTickets(db, workspaceId, moved);
  return {
    ok: true,
    before: hierarchy,
    after: result.hierarchy,
    impact: hierarchyImpact(hierarchy, result.hierarchy, tickets),
  };
}

/** Answers a refused plan, or a plan that would break tickets; null when it may go ahead. */
function refusal(planned: Planned) {
  if (!planned.ok) {
    const { status, error, detail } = planned;
    return { status, body: { error, ...(detail !== undefined ? { detail } : {}) } };
  }
  if (breaksTickets(planned.impact)) {
    return { status: 409, body: { error: 'breaks_tickets', impact: impactView(planned.impact) } };
  }
  return null;
}

/** A level id no row has, for a level that is about to be inserted. */
const NEW_LEVEL = 0;

export function registerTicketTypeRoutes(app: FastifyInstance, db: Kysely<Database>): void {
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
    if (held.has('browse_track') || held.has('administer_track')) return true;
    return isAdmin(request);
  }

  /** 401, then 403 for everyone but site and configuration administrators. */
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (!requireUser(request, reply)) return false;
    if (await isAdmin(request)) return true;
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /**
   * Whether the caller may change a configuration object: administrators change shared ones;
   * a local-mode track's administrators also change the ones it owns, while it is not
   * archived. Answers the refusal itself; an object of a track the caller cannot see is not
   * found.
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
      .select(['archived_at'])
      .where('id', '=', ownerTrackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!track || !(await canSeeTrack(request, ownerTrackId))) {
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

  // Hierarchy levels (CORE-006, CORE-007)

  app.get('/api/v1/hierarchy-levels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { levels: (await levelRows(db, request.workspaceId)).map(levelView) };
  });

  // What a change would do before anyone makes it (CORE-007 (1)). The impact names tickets
  // across tracks, so it is for administrators.
  app.get('/api/v1/hierarchy-levels/impact', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const parsed = impactQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const change: HierarchyChange =
      q.change === 'insert'
        ? { kind: 'insert', levelId: NEW_LEVEL, ...(q.rank !== undefined ? { rank: q.rank } : {}) }
        : q.change === 'move'
          ? { kind: 'move', levelId: q.levelId, rank: q.rank }
          : q.change === 'remove'
            ? { kind: 'remove', levelId: q.levelId }
            : { kind: 'retype', typeId: q.typeId, levelId: q.levelId };
    const planned = await plan(db, request.workspaceId, change);
    if (!planned.ok) {
      const refused = refusal(planned);
      return reply.code(refused?.status ?? 400).send(refused?.body);
    }
    return { impact: impactView(planned.impact) };
  });

  app.post('/api/v1/hierarchy-levels', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const parsed = createLevelBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const result = await db.transaction().execute(async (trx) => {
        await lockHierarchy(trx, ws);
        const planned = await plan(trx, ws, {
          kind: 'insert',
          levelId: NEW_LEVEL,
          ...(body.rank !== undefined ? { rank: body.rank } : {}),
        });
        const refused = refusal(planned);
        if (refused || !planned.ok) return { refused };
        const added = planned.after.levels.find((l) => l.id === NEW_LEVEL) as Level;
        const shifted = shiftedLevels(planned.before.levels, planned.after.levels);
        await writeRanks(trx, shifted);
        const row = await trx
          .insertInto('hierarchy_level')
          .values({
            workspace_id: ws,
            kind: 'custom',
            rank: added.rank,
            name: body.name,
            description: body.description ?? '',
          })
          .returning(['id', 'kind', 'rank', 'name', 'description'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'hierarchy_level.created',
          subjectId: row.id,
          payload: { name: row.name, rank: row.rank, shifted },
        });
        return { level: row, levels: await levelRows(trx, ws) };
      });
      if ('refused' in result) {
        return reply.code(result.refused?.status ?? 400).send(result.refused?.body);
      }
      return reply
        .code(201)
        .send({ level: levelView(result.level), levels: result.levels.map(levelView) });
    } catch (error) {
      if (uniqueViolation(error) === 'hierarchy_level_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Built-in levels are renamed; custom ones are also moved to another custom rank.
  app.patch('/api/v1/hierarchy-levels/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateLevelBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const levelId = params.data.id;
    try {
      const result = await db.transaction().execute(async (trx) => {
        await lockHierarchy(trx, ws);
        const current = await trx
          .selectFrom('hierarchy_level')
          .select(['id', 'kind', 'rank', 'name', 'description'])
          .where('id', '=', levelId)
          .where('workspace_id', '=', ws)
          .executeTakeFirst();
        if (!current) return { missing: true as const };
        let shifted: ReturnType<typeof shiftedLevels> = [];
        if (body.rank !== undefined && body.rank !== current.rank) {
          const planned = await plan(trx, ws, { kind: 'move', levelId, rank: body.rank });
          const refused = refusal(planned);
          if (refused || !planned.ok) return { refused };
          shifted = shiftedLevels(planned.before.levels, planned.after.levels, levelId);
        }
        const changes = diff<Record<string, unknown>>(
          { name: current.name, description: current.description, rank: current.rank },
          { name: body.name, description: body.description, rank: body.rank },
        );
        if (Object.keys(changes).length > 0) {
          await writeRanks(trx, shifted);
          await trx
            .updateTable('hierarchy_level')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.rank !== undefined ? { rank: body.rank } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', levelId)
            .execute();
          await emit(trx, by(request), {
            type: 'hierarchy_level.updated',
            subjectId: levelId,
            payload: { changes, shifted },
          });
        }
        const levels = await levelRows(trx, ws);
        return { level: levels.find((l) => l.id === levelId), levels };
      });
      if ('missing' in result) return notFound(reply);
      if ('refused' in result) {
        return reply.code(result.refused?.status ?? 400).send(result.refused?.body);
      }
      if (!result.level) return notFound(reply);
      return { level: levelView(result.level), levels: result.levels.map(levelView) };
    } catch (error) {
      if (uniqueViolation(error) === 'hierarchy_level_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Removing a custom level: its ticket types fall to the standard level (rule 7).
  app.delete('/api/v1/hierarchy-levels/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const levelId = params.data.id;
    const result = await db.transaction().execute(async (trx) => {
      await lockHierarchy(trx, ws);
      const current = await trx
        .selectFrom('hierarchy_level')
        .select(['name', 'rank'])
        .where('id', '=', levelId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      const planned = await plan(trx, ws, { kind: 'remove', levelId });
      const refused = refusal(planned);
      if (refused || !planned.ok) return { refused };
      const standard = planned.after.levels.find((l) => l.kind === 'standard') as Level;
      const typesToStandard = planned.impact.typesToStandard;
      if (typesToStandard.length > 0) {
        await trx
          .updateTable('ticket_type')
          .set({ level_id: standard.id, updated_at: new Date() })
          .where('level_id', '=', levelId)
          .execute();
      }
      await trx.deleteFrom('hierarchy_level').where('id', '=', levelId).execute();
      const shifted = shiftedLevels(planned.before.levels, planned.after.levels, levelId);
      await writeRanks(trx, shifted);
      await emit(trx, by(request), {
        type: 'hierarchy_level.deleted',
        subjectId: levelId,
        payload: { name: current.name, rank: current.rank, shifted, typesToStandard },
      });
      return { deleted: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('refused' in result) {
      return reply.code(result.refused?.status ?? 400).send(result.refused?.body);
    }
    return reply.code(204).send();
  });

  // Ticket types (CORE-005)

  /** A ticket type the caller may see: shared ones, or one a track they can see owns. */
  async function visibleType(
    request: FastifyRequest,
    typeId: number,
  ): Promise<TicketTypeRow | null> {
    const row = await ticketTypeQuery(db, request.workspaceId)
      .where('t.id', '=', typeId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.owner_track_id !== null && !(await canSeeTrack(request, row.owner_track_id))) {
      return null;
    }
    return row;
  }

  app.get('/api/v1/ticket-types', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = typeListQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const trackId = parsed.data.trackId;
    // A track's own types join the shared ones for people who can see the track.
    const withTrack = trackId !== undefined && (await canSeeTrack(request, trackId));
    if (trackId !== undefined && !withTrack) return notFound(reply);
    const rows = await ticketTypeQuery(db, request.workspaceId)
      .where((eb) =>
        withTrack
          ? eb.or([eb('t.owner_track_id', 'is', null), eb('t.owner_track_id', '=', trackId)])
          : eb('t.owner_track_id', 'is', null),
      )
      .orderBy('l.rank', 'desc')
      .orderBy(sql`lower(t.name)`)
      .orderBy('t.id')
      .execute();
    return { ticketTypes: rows.map(ticketTypeView) };
  });

  app.get('/api/v1/ticket-types/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const row = await visibleType(request, params.data.id);
    if (!row) return notFound(reply);
    return { ticketType: ticketTypeView(row) };
  });

  app.post('/api/v1/ticket-types', async (request, reply) => {
    const parsed = createTypeBody.safeParse(request.body);
    if (!requireUser(request, reply)) return reply;
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = body.trackId ?? null;
    if (!(await mayConfigure(request, reply, trackId))) return reply;
    if (trackId !== null) {
      const track = await db
        .selectFrom('track')
        .select('mode')
        .where('id', '=', trackId)
        .executeTakeFirstOrThrow();
      if (track.mode !== 'local') {
        return invalid(reply, 'a shared-mode track uses shared ticket types');
      }
    }
    try {
      const created = await db.transaction().execute(async (trx) => {
        // Putting a type at a level is a hierarchy change: it waits for one in progress.
        await lockHierarchy(trx, ws);
        const level = await trx
          .selectFrom('hierarchy_level')
          .select(['id', 'rank'])
          .where('id', '=', body.levelId)
          .where('workspace_id', '=', ws)
          .executeTakeFirst();
        if (!level) return null;
        const row = await trx
          .insertInto('ticket_type')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            icon: body.icon ?? null,
            color: body.color ?? null,
            level_id: level.id,
            owner_track_id: trackId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'ticket_type.created',
          subjectId: row.id,
          payload: { name: body.name, levelId: level.id, rank: level.rank, trackId },
        });
        return ticketTypeQuery(trx, ws).where('t.id', '=', row.id).executeTakeFirstOrThrow();
      });
      if (!created) return invalid(reply, 'levelId');
      return reply.code(201).send({ ticketType: ticketTypeView(created) });
    } catch (error) {
      if (uniqueViolation(error) === 'ticket_type_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/ticket-types/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateTypeBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const typeId = params.data.id;
    const existing = await visibleType(request, typeId);
    if (!existing) return notFound(reply);
    if (!(await mayConfigure(request, reply, existing.owner_track_id))) return reply;
    try {
      const result = await db.transaction().execute(async (trx) => {
        await lockHierarchy(trx, ws);
        const current = await trx
          .selectFrom('ticket_type')
          .select(['name', 'description', 'icon', 'color', 'level_id'])
          .where('id', '=', typeId)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        if (!current) return { missing: true as const };
        const changes = diff<Record<string, unknown>>(
          {
            name: current.name,
            description: current.description,
            icon: current.icon,
            color: current.color,
            levelId: current.level_id,
          },
          body,
        );
        if (changes.levelId && body.levelId !== undefined) {
          // A new level is a hierarchy change: refused when it would break a parent link.
          const planned = await plan(trx, ws, {
            kind: 'retype',
            typeId,
            levelId: body.levelId,
          });
          const refused = refusal(planned);
          if (refused) return { refused };
        }
        if (Object.keys(changes).length > 0) {
          await trx
            .updateTable('ticket_type')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.icon !== undefined ? { icon: body.icon } : {}),
              ...(body.color !== undefined ? { color: body.color } : {}),
              ...(body.levelId !== undefined ? { level_id: body.levelId } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', typeId)
            .execute();
          await emit(trx, by(request), {
            type: 'ticket_type.updated',
            subjectId: typeId,
            payload: { changes },
          });
        }
        return {
          row: await ticketTypeQuery(trx, ws).where('t.id', '=', typeId).executeTakeFirstOrThrow(),
        };
      });
      if ('missing' in result) return notFound(reply);
      if ('refused' in result) {
        return reply.code(result.refused?.status ?? 400).send(result.refused?.body);
      }
      return { ticketType: ticketTypeView(result.row) };
    } catch (error) {
      if (uniqueViolation(error) === 'ticket_type_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // A type leaves every set before it is deleted; a set drops a type only when no ticket of
  // that type remains in its tracks (CORE-005 (2)).
  app.delete('/api/v1/ticket-types/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const typeId = params.data.id;
    const existing = await visibleType(request, typeId);
    if (!existing) return notFound(reply);
    if (!(await mayConfigure(request, reply, existing.owner_track_id))) return reply;
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('ticket_type')
        .select(['name', 'owner_track_id'])
        .where('id', '=', typeId)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { missing: true as const };
      const sets = await trx
        .selectFrom('type_set_member as m')
        .innerJoin('type_set as s', 's.id', 'm.type_set_id')
        .select(['s.id', 's.name'])
        .where('m.ticket_type_id', '=', typeId)
        .orderBy('s.id')
        .execute();
      if (sets.length > 0) return { conflict: { error: 'in_type_sets', typeSets: sets } };
      const tickets = await ticketsOfTypes(trx, ws, [typeId], null);
      if (tickets > 0) return { conflict: { error: 'has_tickets', ticketCount: tickets } };
      await trx.deleteFrom('ticket_type').where('id', '=', typeId).execute();
      await emit(trx, by(request), {
        type: 'ticket_type.deleted',
        subjectId: typeId,
        payload: { name: row.name, trackId: row.owner_track_id },
      });
      return { deleted: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return reply.code(409).send(result.conflict);
    return reply.code(204).send();
  });

  // Type sets (CORE-005; section 1.5)

  async function typeSetViews(
    trx: Db,
    workspaceId: number,
    rows: readonly {
      id: number;
      name: string;
      description: string;
      default_type_id: number | null;
      owner_track_id: number | null;
    }[],
  ) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const [members, defaults, tracks] = await Promise.all([
      setMembers(trx, workspaceId, ids),
      trx
        .selectFrom('type_set_default')
        .select(['type_set_id', 'track_type'])
        .where('type_set_id', 'in', ids)
        .execute(),
      trx
        .selectFrom('track')
        .select(['id', 'key', 'name', 'type_set_id'])
        .where('type_set_id', 'in', ids)
        .orderBy(sql`upper(key)`)
        .execute(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      trackId: r.owner_track_id,
      defaultTypeId: r.default_type_id,
      ticketTypes: (members.get(r.id) ?? []).map(ticketTypeView),
      defaultFor: inTrackTypeOrder(
        defaults.filter((d) => d.type_set_id === r.id).map((d) => d.track_type),
      ),
      // Every shared object shows the tracks that use it (section 1.5).
      tracks: tracks
        .filter((t) => t.type_set_id === r.id)
        .map((t) => ({ id: t.id, key: t.key, name: t.name })),
    }));
  }

  function typeSetQuery(trx: Db, workspaceId: number) {
    return trx
      .selectFrom('type_set')
      .select(['id', 'name', 'description', 'default_type_id', 'owner_track_id'])
      .where('workspace_id', '=', workspaceId);
  }

  async function typeSetView(trx: Db, workspaceId: number, setId: number) {
    const row = await typeSetQuery(trx, workspaceId).where('id', '=', setId).executeTakeFirst();
    if (!row) return null;
    return (await typeSetViews(trx, workspaceId, [row]))[0] ?? null;
  }

  /** Every id names a type the set may hold: shared ones, plus its own track's types. */
  async function usableTypes(
    trx: Db,
    workspaceId: number,
    typeIds: readonly number[],
    ownerTrackId: number | null,
  ): Promise<boolean> {
    const rows = await trx
      .selectFrom('ticket_type')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', [...typeIds])
      .where((eb) =>
        ownerTrackId === null
          ? eb('owner_track_id', 'is', null)
          : eb.or([eb('owner_track_id', 'is', null), eb('owner_track_id', '=', ownerTrackId)]),
      )
      .execute();
    return rows.length === new Set(typeIds).size;
  }

  async function writeMembers(
    trx: Transaction<Database>,
    workspaceId: number,
    setId: number,
    typeIds: readonly number[],
  ) {
    // The order constraint and the default's membership are both checked at commit.
    await trx.deleteFrom('type_set_member').where('type_set_id', '=', setId).execute();
    await trx
      .insertInto('type_set_member')
      .values(
        typeIds.map((typeId, i) => ({
          workspace_id: workspaceId,
          type_set_id: setId,
          ticket_type_id: typeId,
          sort_order: i + 1,
        })),
      )
      .execute();
  }

  /** Makes the set the default for these track types, taking over from the previous one. */
  async function takeDefaults(
    trx: Transaction<Database>,
    workspaceId: number,
    setId: number,
    trackTypes: readonly TrackType[],
  ) {
    if (trackTypes.length === 0) return;
    await trx
      .insertInto('type_set_default')
      .values(
        trackTypes.map((t) => ({ workspace_id: workspaceId, track_type: t, type_set_id: setId })),
      )
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'track_type'])
          .doUpdateSet((eb) => ({ type_set_id: eb.ref('excluded.type_set_id') })),
      )
      .execute();
  }

  app.get('/api/v1/type-sets', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const rows = await typeSetQuery(db, request.workspaceId)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
    return { typeSets: await typeSetViews(db, request.workspaceId, rows) };
  });

  app.get('/api/v1/type-sets/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const view = await typeSetView(db, ws, params.data.id);
    if (!view) return notFound(reply);
    // A local-mode track's administrators read its own set; administrators read every set.
    const allowed =
      (await isAdmin(request)) ||
      (view.trackId !== null && (await request.authz.can('administer_track', view.trackId)));
    if (!allowed) {
      if (view.trackId !== null && !(await canSeeTrack(request, view.trackId))) {
        return notFound(reply);
      }
      return reply.code(403).send({ error: 'forbidden' });
    }
    return { typeSet: view };
  });

  app.post('/api/v1/type-sets', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const parsed = createTypeSetBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const defaultTypeId = body.defaultTypeId ?? null;
    if (defaultTypeId !== null && !body.ticketTypeIds.includes(defaultTypeId)) {
      return invalid(reply, 'defaultTypeId');
    }
    const defaultFor = inTrackTypeOrder(body.defaultFor ?? []);
    try {
      const created = await db.transaction().execute(async (trx) => {
        if (!(await usableTypes(trx, ws, body.ticketTypeIds, null))) return null;
        const row = await trx
          .insertInto('type_set')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeMembers(trx, ws, row.id, body.ticketTypeIds);
        if (defaultTypeId !== null) {
          await trx
            .updateTable('type_set')
            .set({ default_type_id: defaultTypeId })
            .where('id', '=', row.id)
            .execute();
        }
        await takeDefaults(trx, ws, row.id, defaultFor);
        await emit(trx, by(request), {
          type: 'type_set.created',
          subjectId: row.id,
          payload: {
            name: body.name,
            ticketTypeIds: body.ticketTypeIds,
            defaultTypeId,
            defaultFor,
          },
        });
        return typeSetView(trx, ws, row.id);
      });
      if (!created) return invalid(reply, 'ticketTypeIds');
      return reply.code(201).send({ typeSet: created });
    } catch (error) {
      if (uniqueViolation(error) === 'type_set_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      if (foreignKeyViolation(error)) return invalid(reply, 'ticketTypeIds');
      throw error;
    }
  });

  app.patch('/api/v1/type-sets/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateTypeSetBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const setId = params.data.id;
    const existing = await typeSetQuery(db, ws).where('id', '=', setId).executeTakeFirst();
    if (!existing) return notFound(reply);
    if (!(await mayConfigure(request, reply, existing.owner_track_id))) return reply;
    if (existing.owner_track_id !== null && body.defaultFor !== undefined) {
      return invalid(reply, "a local-mode track's type set is never a default");
    }
    try {
      const result = await db.transaction().execute(async (trx) => {
        let mapped: { fromTypeId: number; toTypeId: number; ticketCount: number }[] = [];
        const locked = await trx
          .selectFrom('type_set')
          .select(['name', 'description', 'default_type_id', 'owner_track_id'])
          .where('id', '=', setId)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return { missing: true as const };
        const members = (await setMembers(trx, ws, [setId])).get(setId) ?? [];
        const currentDefaults = await trx
          .selectFrom('type_set_default')
          .select('track_type')
          .where('type_set_id', '=', setId)
          .execute();
        const before = {
          name: locked.name,
          description: locked.description,
          ticketTypeIds: members.map((m) => m.id),
          defaultTypeId: locked.default_type_id,
          defaultFor: inTrackTypeOrder(currentDefaults.map((d) => d.track_type)),
        };
        const typeIds = body.ticketTypeIds ?? before.ticketTypeIds;
        const defaultTypeId =
          body.defaultTypeId !== undefined ? body.defaultTypeId : before.defaultTypeId;
        if (defaultTypeId !== null && !typeIds.includes(defaultTypeId)) {
          return { invalid: 'defaultTypeId' };
        }
        const defaultFor =
          body.defaultFor !== undefined ? inTrackTypeOrder(body.defaultFor) : before.defaultFor;
        // A track type always has a default set: another set takes it over instead.
        if (before.defaultFor.some((t) => !defaultFor.includes(t))) {
          return { conflict: { error: 'default_required' } };
        }
        if (body.ticketTypeIds !== undefined) {
          if (!(await usableTypes(trx, ws, typeIds, locked.owner_track_id))) {
            return { invalid: 'ticketTypeIds' };
          }
          const removed = before.ticketTypeIds.filter((t) => !typeIds.includes(t));
          const tracks = await trx
            .selectFrom('track')
            .select('id')
            .where('type_set_id', '=', setId)
            .execute();
          // Tickets of a dropped type take the type the mapping names, or the change waits.
          const result = await mapTicketTypes(
            trx,
            ws,
            tracks.map((t) => t.id),
            removed,
            typeIds,
            body.ticketTypeMapping,
          );
          if (!result.ok) return { refused: result };
          mapped = result.mapped;
        } else if (body.ticketTypeMapping !== undefined) {
          return { invalid: 'ticketTypeMapping' };
        }
        const changes = diff<Record<string, unknown>>(before, {
          name: body.name,
          description: body.description,
          ticketTypeIds: body.ticketTypeIds,
          defaultTypeId: body.defaultTypeId,
          defaultFor: body.defaultFor !== undefined ? defaultFor : undefined,
        });
        if (Object.keys(changes).length > 0) {
          if (changes.ticketTypeIds) await writeMembers(trx, ws, setId, typeIds);
          await trx
            .updateTable('type_set')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              default_type_id: defaultTypeId,
              updated_at: new Date(),
            })
            .where('id', '=', setId)
            .execute();
          if (changes.defaultFor) {
            await takeDefaults(
              trx,
              ws,
              setId,
              defaultFor.filter((t) => !before.defaultFor.includes(t)),
            );
          }
          await emit(trx, by(request), {
            type: 'type_set.updated',
            subjectId: setId,
            payload: { changes, ...(mapped.length > 0 ? { mapped } : {}) },
          });
        }
        return { view: await typeSetView(trx, ws, setId) };
      });
      if ('missing' in result) return notFound(reply);
      if ('invalid' in result) return invalid(reply, result.invalid);
      if ('conflict' in result) return reply.code(409).send(result.conflict);
      if ('refused' in result) {
        return reply.code(result.refused.status).send(result.refused.body);
      }
      if (!result.view) return notFound(reply);
      return { typeSet: result.view };
    } catch (error) {
      if (uniqueViolation(error) === 'type_set_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      if (foreignKeyViolation(error)) return invalid(reply, 'ticketTypeIds');
      throw error;
    }
  });

  // A set in use, the default of a track type or owned by a local-mode track stays.
  app.delete('/api/v1/type-sets/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const setId = params.data.id;
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('type_set')
        .select(['name', 'owner_track_id'])
        .where('id', '=', setId)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { missing: true as const };
      if (row.owner_track_id !== null) return { conflict: { error: 'owned_by_track' } };
      const used = await trx
        .selectFrom('track')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('type_set_id', '=', setId)
        .executeTakeFirstOrThrow();
      if (Number(used.n) > 0) {
        return { conflict: { error: 'in_use', trackCount: Number(used.n) } };
      }
      const defaults = await trx
        .selectFrom('type_set_default')
        .select('track_type')
        .where('type_set_id', '=', setId)
        .execute();
      if (defaults.length > 0) {
        return {
          conflict: {
            error: 'default_type_set',
            defaultFor: inTrackTypeOrder(defaults.map((d) => d.track_type)),
          },
        };
      }
      await trx.deleteFrom('type_set').where('id', '=', setId).execute();
      await emit(trx, by(request), {
        type: 'type_set.deleted',
        subjectId: setId,
        payload: { name: row.name },
      });
      return { deleted: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return reply.code(409).send(result.conflict);
    return reply.code(204).send();
  });
}
