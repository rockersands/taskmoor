import type { Database } from '@taskmoor/db';
import { SYSTEM_FIELDS } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import { emit } from '../events/bus';
import type { DomainEventInput, EventType } from '../events/catalogue';
import {
  INDEX_TYPES,
  keyProblem,
  MAX_VALUE_BYTES,
  OWNER_COLUMN,
  PROPERTY_TABLE,
  type PropertyKind,
  pathProblem,
  propertyIndexes,
  syncPropertyValues,
  valueBytes,
} from '../properties/model';
import { ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket } from '../tickets/store';

/**
 * Entity properties (M1-129; API-013; ADR-083).
 *
 * - `GET {entity}/:id/properties` lists the keys of an entity's properties,
 *   `GET .../properties/:key` reads one, `PUT .../properties/:key` with `{ "value": <JSON> }`
 *   sets it (201 when new, 200 when replaced) and `DELETE` removes it. The entities are tickets
 *   (`/api/v1/tickets/:id`, by id or key), tracks (`/api/v1/tracks/:id`, by id or key), people
 *   (`/api/v1/users/:id`, `me` for oneself), boards and sprints (registered by the board routes,
 *   which know who sees and changes a board).
 * - Reading needs what seeing the entity needs; writing needs what changing it needs: editing a
 *   ticket, administering a track, being the person or a site administrator, configuring a
 *   board, managing its sprints. A hidden entity answers 404 like a missing one.
 * - `GET`, `POST /api/v1/admin/property-indexes` and `DELETE .../:id` list, declare and drop the
 *   indexes that make a ticket property's value searchable (configuration administrators). A
 *   new index is filled from the properties already set, in its transaction.
 *
 * Every write emits one event in its transaction: `<entity>.property_set` or
 * `<entity>.property_deleted`, `property_index.created` or `property_index.deleted`.
 */
type Db = Kysely<Database>;

/** Who reaches an entity's properties: its id, or null after answering 404 or 400. */
export interface PropertyOwner {
  id: number;
  /** Whether the caller may set and delete its properties. */
  mayWrite: boolean;
  /** What the events name besides the id (a ticket's key). */
  payload?: Record<string, unknown>;
  /** Refuses a write for the entity's state (an archived track), or null. */
  frozen?: string | null;
}

export type FindOwner = (
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
) => Promise<PropertyOwner | null>;

const ownerParams = z.object({ id: z.string().min(1).max(300) }).strict();
const keyParams = z
  .object({ id: z.string().min(1).max(300), key: z.string().min(1).max(1000) })
  .strict();
export const putPropertyBody = z
  .object({ value: z.unknown() })
  .strict()
  .refine((b) => b.value !== undefined, { message: 'value is required', path: ['value'] });

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

const EVENTS = {
  ticket: { set: 'ticket.property_set', deleted: 'ticket.property_deleted' },
  track: { set: 'track.property_set', deleted: 'track.property_deleted' },
  user: { set: 'user.property_set', deleted: 'user.property_deleted' },
  board: { set: 'board.property_set', deleted: 'board.property_deleted' },
  sprint: { set: 'sprint.property_set', deleted: 'sprint.property_deleted' },
} as const satisfies Record<PropertyKind, { set: EventType; deleted: EventType }>;

const iso = (value: Date | string) => new Date(value).toISOString();

/** The four routes of one kind of entity under `base` (for example `/api/v1/boards`). */
export function registerPropertyRoutes(
  app: FastifyInstance,
  db: Db,
  kind: PropertyKind,
  base: string,
  find: FindOwner,
): void {
  const table = PROPERTY_TABLE[kind];
  const column = OWNER_COLUMN[kind];
  // Kysely cannot type a table and column chosen at run time; the names come from the maps.
  const rows = (d: Kysely<Database>) => d.selectFrom(table as 'ticket_property');
  const ownerColumn = column as 'ticket_id';

  async function owner(request: FastifyRequest, reply: FastifyReply, id: string) {
    if (!requireUser(request, reply)) return null;
    return find(request, reply, id);
  }

  app.get(`${base}/:id/properties`, async (request, reply) => {
    const p = ownerParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await owner(request, reply, p.data.id);
    if (!found) return reply;
    const list = await rows(db)
      .select(['key', 'updated_at'])
      .where(ownerColumn, '=', found.id)
      .orderBy('key')
      .execute();
    return { properties: list.map((r) => ({ key: r.key, updatedAt: iso(r.updated_at) })) };
  });

  app.get(`${base}/:id/properties/:key`, async (request, reply) => {
    const p = keyParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await owner(request, reply, p.data.id);
    if (!found) return reply;
    const row = await rows(db)
      .select(['key', 'value', 'created_at', 'updated_at'])
      .where(ownerColumn, '=', found.id)
      .where('key', '=', p.data.key)
      .executeTakeFirst();
    if (!row) return notFound(reply);
    return {
      property: {
        key: row.key,
        value: row.value,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      },
    };
  });

  app.put(`${base}/:id/properties/:key`, async (request, reply) => {
    const p = keyParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await owner(request, reply, p.data.id);
    if (!found) return reply;
    if (found.frozen) return reply.code(409).send({ error: found.frozen });
    if (!found.mayWrite) return reply.code(403).send({ error: 'forbidden' });
    const key = p.data.key;
    const problem = keyProblem(key);
    if (problem) return invalidFields(reply, { key: problem });
    const body = putPropertyBody.safeParse(request.body);
    if (!body.success) return invalidFields(reply, { value: 'required' });
    if (valueBytes(body.data.value) > MAX_VALUE_BYTES) {
      return invalidFields(reply, { value: 'too_large' });
    }
    const userId = request.user?.id ?? null;
    const json = JSON.stringify(body.data.value);
    // One statement, so two first writes of a key at once give one row and no error; `xmax`
    // is 0 on a row this statement inserted.
    const row = await db.transaction().execute(async (trx) => {
      const written = await trx
        .insertInto(table as 'ticket_property')
        .values({
          workspace_id: request.workspaceId,
          [ownerColumn]: found.id,
          key,
          value: json,
          updated_by: userId,
        } as never)
        .onConflict((oc) =>
          oc.columns([ownerColumn, 'key']).doUpdateSet({
            value: json,
            updated_at: new Date(),
            updated_by: userId,
          }),
        )
        .returning(['key', 'value', 'created_at', 'updated_at'])
        .returning(sql<boolean>`xmax = 0`.as('created'))
        .executeTakeFirstOrThrow();
      if (kind === 'ticket') await syncPropertyValues(trx, [found.id], { key });
      await emit(trx, { workspaceId: request.workspaceId, actorId: userId }, {
        type: EVENTS[kind].set,
        subjectId: found.id,
        payload: { ...found.payload, propertyKey: key, created: written.created },
      } as DomainEventInput);
      return written;
    });
    const created = row.created;
    return reply.code(created ? 201 : 200).send({
      property: {
        key: row.key,
        value: row.value,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      },
    });
  });

  app.delete(`${base}/:id/properties/:key`, async (request, reply) => {
    const p = keyParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await owner(request, reply, p.data.id);
    if (!found) return reply;
    if (found.frozen) return reply.code(409).send({ error: found.frozen });
    if (!found.mayWrite) return reply.code(403).send({ error: 'forbidden' });
    const key = p.data.key;
    const gone = await db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom(table as 'ticket_property')
        .where(ownerColumn, '=', found.id)
        .where('key', '=', key)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) return false;
      if (kind === 'ticket') await syncPropertyValues(trx, [found.id], { key });
      await emit(trx, { workspaceId: request.workspaceId, actorId: request.user?.id ?? null }, {
        type: EVENTS[kind].deleted,
        subjectId: found.id,
        payload: { ...found.payload, propertyKey: key },
      } as DomainEventInput);
      return true;
    });
    if (!gone) return notFound(reply);
    return reply.code(204).send();
  });
}

export const propertyIndexBody = z
  .object({
    key: z.string().min(1).max(255),
    path: z.string().max(255).default(''),
    type: z.enum(INDEX_TYPES),
    alias: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\p{L}_][\p{L}\p{N}_]*$/u, 'a word of letters, digits and underscores')
      .nullable()
      .default(null),
  })
  .strict();
const indexParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });

/** Ticket, track and people properties, and the declared indexes. */
export function registerCorePropertyRoutes(app: FastifyInstance, db: Db): void {
  registerPropertyRoutes(app, db, 'ticket', '/api/v1/tickets', async (request, reply, id) => {
    const found = await resolveTicket(db, request.workspaceId, id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      await notFound(reply);
      return null;
    }
    return {
      id: row.id,
      mayWrite: await request.authz.canTicket('edit_tickets', row),
      frozen: row.track_archived_at ? 'track_archived' : null,
      payload: { key: ticketKey(row.track_key, row.number) },
    };
  });

  registerPropertyRoutes(app, db, 'track', '/api/v1/tracks', async (request, reply, id) => {
    const numeric = /^\d{1,10}$/.test(id) ? Number(id) : null;
    const track = await db
      .selectFrom('track')
      .select(['id', 'key', 'archived_at'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        numeric === null ? eb(sql`upper(key)`, '=', id.toUpperCase()) : eb('id', '=', numeric),
      )
      .executeTakeFirst();
    const held = track ? await request.authz.track(track.id) : new Set<string>();
    if (!track || !held.has('browse_track')) {
      await notFound(reply);
      return null;
    }
    return {
      id: track.id,
      mayWrite: held.has('administer_track'),
      frozen: track.archived_at ? 'track_archived' : null,
      payload: { trackKey: track.key },
    };
  });

  registerPropertyRoutes(app, db, 'user', '/api/v1/users', async (request, reply, id) => {
    const me = request.user?.id;
    const userId = id === 'me' ? me : /^\d{1,10}$/.test(id) ? Number(id) : undefined;
    const admin = await request.authz.isSiteAdmin();
    const person =
      userId === undefined
        ? undefined
        : await db
            .selectFrom('app_user')
            .select('id')
            .where('workspace_id', '=', request.workspaceId)
            .where('id', '=', userId)
            .executeTakeFirst();
    // Only the person and site administrators reach a person's properties.
    if (!person || (person.id !== me && !admin)) {
      await notFound(reply);
      return null;
    }
    return { id: person.id, mayWrite: true };
  });

  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');

  app.get('/api/v1/admin/property-indexes', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const list = await propertyIndexes(db, request.workspaceId);
    return { propertyIndexes: list.map(indexView) };
  });

  app.post('/api/v1/admin/property-indexes', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const parsed = propertyIndexBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const keyIssue = keyProblem(body.key);
    if (keyIssue) return invalidFields(reply, { key: keyIssue });
    const pathIssue = pathProblem(body.path);
    if (pathIssue) return invalidFields(reply, { path: pathIssue });
    const ws = request.workspaceId;
    if (body.alias !== null && (await aliasTaken(db, ws, body.alias))) {
      return reply.code(409).send({ error: 'alias_taken' });
    }
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('property_index')
        .values({
          workspace_id: ws,
          key: body.key,
          path: body.path,
          type: body.type,
          alias: body.alias,
          created_by: user.id,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return null;
      // Fill it from the properties already set, a batch of tickets at a time.
      let after = 0;
      for (;;) {
        const batch = await trx
          .selectFrom('ticket_property')
          .select('ticket_id')
          .where('workspace_id', '=', ws)
          .where('key', '=', body.key)
          .where('ticket_id', '>', after)
          .orderBy('ticket_id')
          .limit(1000)
          .execute();
        if (batch.length === 0) break;
        const ids = batch.map((b) => b.ticket_id);
        await syncPropertyValues(trx, ids, { indexIds: [row.id] });
        after = ids[ids.length - 1] as number;
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'property_index.created',
          subjectId: row.id,
          payload: { key: body.key, path: body.path, type: body.type, alias: body.alias },
        },
      );
      return row.id;
    });
    if (result === null) return reply.code(409).send({ error: 'index_exists' });
    const list = await propertyIndexes(db, ws);
    const created = list.find((i) => i.id === result);
    return reply.code(201).send({ propertyIndex: created ? indexView(created) : null });
  });

  app.delete('/api/v1/admin/property-indexes/:id', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const p = indexParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const ws = request.workspaceId;
    const gone = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('property_index')
        .where('workspace_id', '=', ws)
        .where('id', '=', p.data.id)
        .returning(['key', 'path'])
        .executeTakeFirst();
      if (!row) return false;
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'property_index.deleted',
          subjectId: p.data.id,
          payload: { key: row.key, path: row.path },
        },
      );
      return true;
    });
    if (!gone) return notFound(reply);
    return reply.code(204).send();
  });
}

function indexView(i: {
  id: number;
  key: string;
  path: string;
  type: string;
  alias: string | null;
}) {
  return { id: i.id, key: i.key, path: i.path, type: i.type, alias: i.alias };
}

/** An alias may not hide a system field or a custom field, nor repeat another alias. */
async function aliasTaken(db: Db, workspaceId: number, alias: string): Promise<boolean> {
  const wanted = alias.toLowerCase();
  if (
    SYSTEM_FIELDS.some(
      (f) => f.name.toLowerCase() === wanted || f.aliases.some((a) => a.toLowerCase() === wanted),
    )
  ) {
    return true;
  }
  const field = await db
    .selectFrom('field')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where(sql`lower(name)`, '=', wanted)
    .executeTakeFirst();
  if (field) return true;
  const other = await db
    .selectFrom('property_index')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where(sql`lower(alias)`, '=', wanted)
    .executeTakeFirst();
  return other !== undefined;
}

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}
