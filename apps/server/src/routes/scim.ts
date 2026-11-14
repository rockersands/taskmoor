import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { dropLapsedCreateTracks, lapsedPayload } from '../authz/create-tracks';
import { activeAdminCount, effectiveMemberIds } from '../directory';
import { diff, emit } from '../events/bus';
import {
  invalidSyntax,
  invalidValue,
  mutability,
  notFound,
  SCIM_CONTENT_TYPE,
  ScimError,
  scimErrorBody,
  uniqueness,
} from '../scim/errors';
import { equalityTerms, type Filter, matches, mentions, parseFilter } from '../scim/filter';
import { applyPatch, type PatchOperation } from '../scim/patch';
import { checkSchemas, normalizeResource, project, type Resource } from '../scim/resource';
import {
  DEFAULT_COUNT,
  GROUP_TYPE,
  LIST_RESPONSE_SCHEMA,
  MAX_RESULTS,
  PATCH_OP_SCHEMA,
  RESOURCE_TYPES,
  type ResourceTypeDef,
  resourceTypeView,
  SCHEMAS,
  SCIM_PREFIX,
  schemaView,
  serviceProviderConfig,
  USER_TYPE,
} from '../scim/schemas';
import {
  type GroupRow,
  groupMembers,
  groupQuery,
  groupResource,
  json,
  NAME_MAX,
  type UserRow,
  type UserValues,
  uniqueViolation,
  userGroups,
  userNameHolder,
  userResource,
  userValues,
  visibleUsers,
} from '../scim/store';
import { canonicalJson } from '../tickets/model';

/**
 * The SCIM 2.0 service (M1-083; IAM-006; RFC 7643 and 7644; ADR-038) at `/api/v1/scim/v2`:
 * identity providers create, update, deactivate and group people here.
 *
 * - Only a service account's token with the `scim` scope gets in (the scope is held alone and
 *   reaches nothing else). Every answer, errors included, is `application/scim+json`.
 * - Discovery: `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`.
 * - `/Users` and `/Groups`: list with `filter`, `startIndex`, `count`, `attributes` and
 *   `excludedAttributes`; read; create; replace (PUT); PATCH; DELETE. Sorting, bulk and ETags
 *   are not offered (ServiceProviderConfig says so).
 * - Deprovisioning (`active` false, or DELETE) deactivates the account and ends its sessions;
 *   the account and everything it wrote stay (IAM-006 (2)). After a DELETE the account is gone
 *   for SCIM, and a later POST with its email brings it back. Break-glass accounts and the last
 *   active site administrator cannot be deactivated or removed through SCIM.
 * - Groups SCIM manages are the ones it created; members are people SCIM can see.
 *
 * Every successful change emits exactly one domain event (ADR-015), all of them audited.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Groups with all their members in one PATCH are large; so are some user bodies. */
const BODY_LIMIT = 10 * 1024 * 1024;
const MAX_INT = 2_147_483_647;

interface ListParams {
  filter: string | undefined;
  startIndex: number;
  count: number;
  attributes: string | undefined;
  excludedAttributes: string | undefined;
}

function queryParams(query: unknown): ListParams {
  const q = (query ?? {}) as Record<string, unknown>;
  const one = (name: string) => {
    const value = q[name];
    if (Array.isArray(value)) throw invalidValue(`${name} is given more than once`);
    return typeof value === 'string' ? value : undefined;
  };
  const integer = (name: string, fallback: number) => {
    const raw = one(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    if (!/^-?\d{1,10}$/.test(raw.trim())) throw invalidValue(`${name} must be an integer`);
    return Number(raw);
  };
  // Out-of-range values are read as the nearest allowed one (RFC 7644 3.4.2.4).
  return {
    filter: one('filter'),
    startIndex: Math.max(1, integer('startIndex', 1)),
    count: Math.min(MAX_RESULTS, Math.max(0, integer('count', DEFAULT_COUNT))),
    attributes: one('attributes'),
    excludedAttributes: one('excludedAttributes'),
  };
}

function bodyOf(request: FastifyRequest): Resource {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidSyntax('The body must be a JSON object');
  }
  return body as Resource;
}

/** A resource id from the path: Taskmoor's numeric id. Anything else names nothing. */
function idOf(request: FastifyRequest): number {
  const raw = (request.params as { id?: string }).id ?? '';
  const n = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > MAX_INT) throw notFound();
  return n;
}

/** The operations of a PATCH body (RFC 7644 3.5.2), with op names in any letter case. */
function patchOperations(body: Resource): PatchOperation[] {
  const schemas = body.schemas;
  if (
    schemas !== undefined &&
    !(
      Array.isArray(schemas) &&
      schemas.some((s) => String(s).toLowerCase() === PATCH_OP_SCHEMA.toLowerCase())
    )
  ) {
    throw invalidSyntax(`A PATCH body lists ${PATCH_OP_SCHEMA}`);
  }
  const key = Object.keys(body).find((k) => k.toLowerCase() === 'operations');
  const list = key ? body[key] : undefined;
  if (!Array.isArray(list) || list.length === 0)
    throw invalidSyntax('Operations must list at least one operation');
  if (list.length > 1000) throw invalidSyntax('At most 1,000 operations per request');
  return list.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null)
      throw invalidSyntax(`Operation ${i + 1} is not an object`);
    const entries = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const op = typeof entries.op === 'string' ? entries.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw invalidSyntax(`Operation ${i + 1} has no op add, replace or remove`);
    }
    if (entries.path !== undefined && typeof entries.path !== 'string') {
      throw invalidSyntax(`Operation ${i + 1} has a path that is not text`);
    }
    return { op, path: entries.path as string | undefined, value: entries.value };
  });
}

/** A ListResponse page of resources already filtered and in order. */
function listResponse(total: number, startIndex: number, resources: Resource[]) {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Conditions an equality filter allows in SQL, so a lookup by userName reads one row. */
function narrowUsers(query: ReturnType<typeof visibleUsers>, filter: Filter | null) {
  if (!filter) return query;
  let narrowed = query;
  for (const { attribute, value } of equalityTerms(filter)) {
    if (attribute === 'userName' && typeof value === 'string') {
      narrowed = narrowed.where(
        sql<string>`lower(coalesce(s.user_name, a.email))`,
        '=',
        value.toLowerCase(),
      );
    } else if (attribute === 'externalId' && typeof value === 'string') {
      narrowed = narrowed.where('s.external_id', '=', value);
    } else if (attribute === 'id') {
      const n = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : 0;
      narrowed = narrowed.where('a.id', '=', n);
    } else if (attribute === 'displayName' && typeof value === 'string') {
      narrowed = narrowed.where(sql<string>`lower(a.name)`, '=', value.toLowerCase());
    } else if (attribute === 'active' && typeof value === 'boolean') {
      narrowed = narrowed.where('a.deactivated_at', value ? 'is' : 'is not', null);
    }
  }
  return narrowed;
}

function narrowGroups(query: ReturnType<typeof groupQuery>, filter: Filter | null) {
  if (!filter) return query;
  let narrowed = query;
  for (const { attribute, value } of equalityTerms(filter)) {
    if (attribute === 'displayName' && typeof value === 'string') {
      narrowed = narrowed.where(sql<string>`lower(g.name)`, '=', value.toLowerCase());
    } else if (attribute === 'externalId' && typeof value === 'string') {
      narrowed = narrowed.where('sg.external_id', '=', value);
    } else if (attribute === 'id') {
      const n = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : 0;
      narrowed = narrowed.where('g.id', '=', n);
    }
  }
  return narrowed;
}

/** The attributes of a user that changed, by name, outside the account columns. */
function changedAttributes(before: unknown, after: Resource): string[] {
  const old = (typeof before === 'object' && before !== null ? before : {}) as Resource;
  const names = new Set([...Object.keys(old), ...Object.keys(after)]);
  return [...names].filter((n) => canonicalJson(old[n]) !== canonicalJson(after[n])).sort();
}

/** Ends a person's sessions and unused password links; returns how many sessions ended. */
async function signOut(trx: Transaction<Database>, userId: number): Promise<number> {
  const ended = await trx
    .deleteFrom('user_session')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  await trx
    .deleteFrom('password_link')
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
  return Number(ended.numDeletedRows);
}

/** Refuses to deactivate an account the identity provider must not be able to lock out. */
async function guardDeactivation(trx: Transaction<Database>, workspaceId: number, row: UserRow) {
  if (row.break_glass) {
    throw mutability('A break-glass account cannot be deactivated through SCIM');
  }
  if (
    row.is_site_admin &&
    row.deactivated_at === null &&
    (await activeAdminCount(trx, workspaceId)) <= 1
  ) {
    throw mutability('The last active site administrator cannot be deactivated');
  }
}

export async function registerScimRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { publicUrl: string },
): Promise<void> {
  const base = `${options.publicUrl.replace(/\/+$/, '')}${SCIM_PREFIX}`;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function loadUser(trx: Db, workspaceId: number, id: number, lock = false) {
    let query = visibleUsers(trx, workspaceId).where('a.id', '=', id);
    if (lock) query = query.forUpdate('a');
    const row = await query.executeTakeFirst();
    if (!row) throw notFound(`No user with id ${id}`);
    return row;
  }

  async function userView(trx: Db, workspaceId: number, row: UserRow) {
    const groups = (await userGroups(trx, workspaceId, [row.id])).get(row.id) ?? [];
    return userResource(row, groups, base);
  }

  async function loadGroup(trx: Db, workspaceId: number, id: number, lock = false) {
    let query = groupQuery(trx, workspaceId).where('g.id', '=', id);
    if (lock) query = query.forUpdate('g');
    const row = await query.executeTakeFirst();
    if (!row) throw notFound(`No group with id ${id}`);
    return row;
  }

  async function groupView(trx: Db, workspaceId: number, row: GroupRow) {
    const members = (await groupMembers(trx, workspaceId, [row.id])).get(row.id) ?? [];
    return groupResource(row, members, base);
  }

  /**
   * Writes a user's values over an existing account and its SCIM row; returns what changed.
   * The account row is locked by the caller.
   */
  async function writeUser(
    trx: Transaction<Database>,
    workspaceId: number,
    row: UserRow,
    values: UserValues,
  ) {
    const before = {
      userName: row.user_name ?? row.email,
      externalId: row.external_id,
      email: row.email,
      name: row.name,
      active: row.deactivated_at === null,
      locale: row.locale,
      timeZone: row.time_zone,
    };
    const changes = diff<Record<string, unknown>>(before, {
      userName: values.userName,
      externalId: values.externalId,
      email: values.email,
      name: values.name,
      active: values.active,
      locale: values.locale,
      timeZone: values.timeZone,
    });
    const attributes = changedAttributes(row.attributes, values.attributes);
    if (changes.active && !values.active) await guardDeactivation(trx, workspaceId, row);
    const now = new Date();
    if (changes.email || changes.name || changes.active || changes.locale || changes.timeZone) {
      await trx
        .updateTable('app_user')
        .set({
          email: values.email,
          name: values.name,
          locale: values.locale,
          time_zone: values.timeZone,
          ...(changes.active ? { deactivated_at: values.active ? null : now } : {}),
          updated_at: now,
        })
        .where('id', '=', row.id)
        .execute();
    }
    const endedSessions = changes.active && !values.active ? await signOut(trx, row.id) : 0;
    // A deactivated person runs no track (T-087b; IAM-033).
    const lapsed =
      changes.active && !values.active
        ? await dropLapsedCreateTracks(trx, workspaceId, [row.id])
        : [];
    const scimChanged =
      changes.userName || changes.externalId || attributes.length > 0 || row.user_name === null;
    if (scimChanged) {
      await trx
        .insertInto('scim_user')
        .values({
          user_id: row.id,
          workspace_id: workspaceId,
          user_name: values.userName,
          external_id: values.externalId,
          attributes: json(values.attributes),
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            user_name: values.userName,
            external_id: values.externalId,
            attributes: json(values.attributes),
            updated_at: now,
          }),
        )
        .execute();
    }
    return { changes, attributes, endedSessions, ...lapsedPayload(lapsed) };
  }

  /** Replaces a user's attributes with a canonical resource (PUT, and PATCH after applying). */
  async function replaceUser(
    request: FastifyRequest,
    id: number,
    next: (current: Resource) => Resource,
  ) {
    const ws = request.workspaceId;
    try {
      return await db.transaction().execute(async (trx) => {
        const row = await loadUser(trx, ws, id, true);
        const resource = normalizeResource(next(await userView(trx, ws, row)), USER_TYPE);
        const values = userValues(resource);
        if (await userNameHolder(trx, ws, values.userName, id)) {
          throw uniqueness(`userName ${values.userName} is taken`);
        }
        const result = await writeUser(trx, ws, row, values);
        if (Object.keys(result.changes).length > 0 || result.attributes.length > 0) {
          await emit(trx, by(request), {
            type: 'scim.user_updated',
            subjectId: id,
            payload: result,
          });
        }
        return userView(trx, ws, await loadUser(trx, ws, id));
      });
    } catch (error) {
      if (uniqueViolation(error) !== null) throw uniqueness('That email or userName is taken');
      throw error;
    }
  }

  /** The visible people among member values; a value naming no one is refused. */
  async function memberIds(trx: Db, workspaceId: number, members: unknown): Promise<number[]> {
    const list = Array.isArray(members) ? members : [];
    const ids = new Set<number>();
    for (const member of list) {
      const value = (member as { value?: unknown }).value;
      const n = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : 0;
      if (n < 1 || n > MAX_INT) throw invalidValue(`No user with id ${String(value)}`);
      ids.add(n);
    }
    if (ids.size === 0) return [];
    const found = await visibleUsers(trx, workspaceId)
      .where('a.id', 'in', [...ids])
      .execute();
    const known = new Set(found.map((r) => r.id));
    const missing = [...ids].find((n) => !known.has(n));
    if (missing !== undefined) throw invalidValue(`No user with id ${missing}`);
    return [...ids].sort((a, b) => a - b);
  }

  function groupName(resource: Resource): string {
    const name = typeof resource.displayName === 'string' ? resource.displayName.trim() : '';
    if (!name) throw invalidValue('displayName is required');
    if ([...name].length > NAME_MAX) throw invalidValue(`displayName is longer than ${NAME_MAX}`);
    return name;
  }

  const externalIdOf = (resource: Resource) =>
    typeof resource.externalId === 'string' && resource.externalId.trim() !== ''
      ? resource.externalId.trim()
      : null;

  /** Replaces a group's name, externalId and visible members (PUT, and PATCH after applying). */
  async function replaceGroup(
    request: FastifyRequest,
    id: number,
    next: (current: Resource) => Resource,
  ) {
    const ws = request.workspaceId;
    try {
      return await db.transaction().execute(async (trx) => {
        const row = await loadGroup(trx, ws, id, true);
        const resource = normalizeResource(next(await groupView(trx, ws, row)), GROUP_TYPE);
        const name = groupName(resource);
        const externalId = externalIdOf(resource);
        const wanted = await memberIds(trx, ws, resource.members);
        const current = ((await groupMembers(trx, ws, [id])).get(id) ?? []).map((m) => m.id);
        const added = wanted.filter((m) => !current.includes(m));
        const removed = current.filter((m) => !wanted.includes(m));
        const changes = diff<Record<string, unknown>>(
          { name: row.name, externalId: row.external_id },
          { name, externalId },
        );
        const now = new Date();
        if (changes.name) {
          await trx.updateTable('user_group').set({ name }).where('id', '=', id).execute();
        }
        if (Object.keys(changes).length > 0 || added.length > 0 || removed.length > 0) {
          await trx
            .updateTable('scim_group')
            .set({ external_id: externalId, updated_at: now })
            .where('group_id', '=', id)
            .execute();
        }
        if (added.length > 0) {
          await trx
            .insertInto('group_member')
            .values(added.map((userId) => ({ workspace_id: ws, group_id: id, user_id: userId })))
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        if (removed.length > 0) {
          await trx
            .deleteFrom('group_member')
            .where('group_id', '=', id)
            .where('user_id', 'in', removed)
            .execute();
        }
        if (Object.keys(changes).length > 0 || added.length > 0 || removed.length > 0) {
          // People who left may run no track without the group (T-087b; IAM-033).
          const lapsed = await dropLapsedCreateTracks(trx, ws, removed);
          await emit(trx, by(request), {
            type: 'scim.group_updated',
            subjectId: id,
            payload: { changes, added, removed, ...lapsedPayload(lapsed) },
          });
        }
        return groupView(trx, ws, await loadGroup(trx, ws, id));
      });
    } catch (error) {
      if (uniqueViolation(error) === 'user_group_workspace_name_idx') {
        throw uniqueness('A group with that displayName exists');
      }
      throw error;
    }
  }

  const answer = (
    reply: FastifyReply,
    request: FastifyRequest,
    type: ResourceTypeDef,
    resource: Resource,
    code = 200,
  ) => {
    const q = queryParams(request.query);
    const shown = project(resource, type, q.attributes, q.excludedAttributes);
    if (code === 201) reply.header('location', (resource.meta as { location: string }).location);
    return reply.code(code).send(shown);
  };

  await app.register(
    async (scim) => {
      scim.addContentTypeParser(
        'application/scim+json',
        { parseAs: 'string', bodyLimit: BODY_LIMIT },
        scim.getDefaultJsonParser('error', 'ignore'),
      );
      // Only a token with the scim scope; the bearer hook already refused other tokens.
      scim.addHook('preHandler', async (request, reply) => {
        if (!request.apiToken?.scopes.includes('scim')) {
          reply.header('www-authenticate', 'Bearer realm="taskmoor"');
          throw new ScimError(401, 'A service account token with the scim scope is required');
        }
      });
      scim.addHook('onSend', async (_request, reply, payload) => {
        reply.type(SCIM_CONTENT_TYPE);
        return payload;
      });
      scim.setErrorHandler((error, request, reply) => {
        if (error instanceof ScimError) {
          return reply
            .code(error.status)
            .send(scimErrorBody(error.status, error.detail, error.scimType));
        }
        const status = (error as { statusCode?: number }).statusCode ?? 500;
        if (status >= 400 && status < 500) {
          return reply
            .code(status)
            .send(
              scimErrorBody(
                status,
                (error as Error).message,
                status === 400 ? 'invalidSyntax' : undefined,
              ),
            );
        }
        request.log.error({ err: error }, 'SCIM request failed');
        return reply.code(500).send(scimErrorBody(500, 'The request could not be completed'));
      });
      scim.setNotFoundHandler((_request, reply) =>
        reply.code(404).send(scimErrorBody(404, 'No such endpoint')),
      );

      // Discovery (RFC 7644 4).
      scim.get('/ServiceProviderConfig', async () => serviceProviderConfig(base));
      scim.get('/ResourceTypes', async () =>
        listResponse(
          RESOURCE_TYPES.length,
          1,
          RESOURCE_TYPES.map((t) => resourceTypeView(t, base)),
        ),
      );
      scim.get('/ResourceTypes/:id', async (request) => {
        const name = (request.params as { id: string }).id;
        const type = RESOURCE_TYPES.find((t) => t.name === name);
        if (!type) throw notFound(`No resource type ${name}`);
        return resourceTypeView(type, base);
      });
      scim.get('/Schemas', async () =>
        listResponse(
          SCHEMAS.length,
          1,
          SCHEMAS.map((s) => schemaView(s, base)),
        ),
      );
      scim.get('/Schemas/:id', async (request) => {
        const id = (request.params as { id: string }).id.toLowerCase();
        const schema = SCHEMAS.find((s) => s.id.toLowerCase() === id);
        if (!schema) throw notFound('No such schema');
        return schemaView(schema, base);
      });

      // Users (RFC 7644 3.3 to 3.6).
      scim.get('/Users', async (request) => {
        const q = queryParams(request.query);
        const ws = request.workspaceId;
        const filter = q.filter ? parseFilter(q.filter, USER_TYPE) : null;
        let total: number;
        let page: Resource[];
        if (!filter) {
          const count = await visibleUsers(db, ws)
            .clearSelect()
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow();
          total = Number(count.n);
          const rows =
            q.count === 0
              ? []
              : await visibleUsers(db, ws)
                  .orderBy('a.id')
                  .offset(q.startIndex - 1)
                  .limit(q.count)
                  .execute();
          const groups = await userGroups(
            db,
            ws,
            rows.map((r) => r.id),
          );
          page = rows.map((r) => userResource(r, groups.get(r.id) ?? [], base));
        } else {
          // Equality terms narrow in SQL; the whole filter then decides on each resource.
          const rows = await narrowUsers(visibleUsers(db, ws), filter).orderBy('a.id').execute();
          const groups = mentions(filter, 'groups')
            ? await userGroups(
                db,
                ws,
                rows.map((r) => r.id),
              )
            : new Map<number, never[]>();
          const hits = rows.filter((r) =>
            matches(userResource(r, groups.get(r.id) ?? [], base), filter),
          );
          total = hits.length;
          const slice = hits.slice(q.startIndex - 1, q.startIndex - 1 + q.count);
          const pageGroups = await userGroups(
            db,
            ws,
            slice.map((r) => r.id),
          );
          page = slice.map((r) => userResource(r, pageGroups.get(r.id) ?? [], base));
        }
        return listResponse(
          total,
          q.startIndex,
          page.map((r) => project(r, USER_TYPE, q.attributes, q.excludedAttributes)),
        );
      });

      scim.get('/Users/:id', async (request, reply) => {
        const ws = request.workspaceId;
        const row = await loadUser(db, ws, idOf(request));
        return answer(reply, request, USER_TYPE, await userView(db, ws, row));
      });

      scim.post('/Users', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const body = bodyOf(request);
        checkSchemas(body, USER_TYPE);
        const values = userValues(normalizeResource(body, USER_TYPE));
        const ws = request.workspaceId;
        try {
          const resource = await db.transaction().execute(async (trx) => {
            if (await userNameHolder(trx, ws, values.userName, null)) {
              throw uniqueness(`userName ${values.userName} is taken`);
            }
            // An account SCIM removed before comes back when its email is provisioned again.
            const existing = await trx
              .selectFrom('app_user as a')
              .leftJoin('scim_user as s', 's.user_id', 'a.id')
              .select(['a.id', 'a.kind', 's.removed_at'])
              .where('a.workspace_id', '=', ws)
              .where(sql<string>`lower(a.email)`, '=', values.email)
              .forUpdate('a')
              .executeTakeFirst();
            let id: number;
            const revived = existing !== undefined;
            if (existing) {
              if (existing.kind !== 'person' || existing.removed_at === null) {
                throw uniqueness(`The email ${values.email} belongs to another account`);
              }
              id = existing.id;
              await trx
                .updateTable('scim_user')
                .set({ removed_at: null, updated_at: new Date() })
                .where('user_id', '=', id)
                .execute();
              const row = await loadUser(trx, ws, id, true);
              await writeUser(trx, ws, row, values);
            } else {
              const created = await trx
                .insertInto('app_user')
                .values({
                  workspace_id: ws,
                  email: values.email,
                  name: values.name,
                  password_hash: null,
                  locale: values.locale,
                  time_zone: values.timeZone,
                  deactivated_at: values.active ? null : new Date(),
                })
                .returning('id')
                .executeTakeFirstOrThrow();
              id = created.id;
              await trx
                .insertInto('scim_user')
                .values({
                  user_id: id,
                  workspace_id: ws,
                  user_name: values.userName,
                  external_id: values.externalId,
                  attributes: json(values.attributes),
                })
                .execute();
            }
            await emit(trx, by(request), {
              type: 'scim.user_created',
              subjectId: id,
              payload: {
                userName: values.userName,
                email: values.email,
                externalId: values.externalId,
                active: values.active,
                revived,
              },
            });
            return userView(trx, ws, await loadUser(trx, ws, id));
          });
          return answer(reply, request, USER_TYPE, resource, 201);
        } catch (error) {
          if (uniqueViolation(error) !== null) throw uniqueness('That email or userName is taken');
          throw error;
        }
      });

      scim.put('/Users/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const id = idOf(request);
        const body = bodyOf(request);
        checkSchemas(body, USER_TYPE);
        const resource = await replaceUser(request, id, () => body);
        return answer(reply, request, USER_TYPE, resource);
      });

      scim.patch('/Users/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const id = idOf(request);
        const operations = patchOperations(bodyOf(request));
        const resource = await replaceUser(request, id, (current) =>
          applyPatch(current, operations, USER_TYPE),
        );
        return answer(reply, request, USER_TYPE, resource);
      });

      scim.delete('/Users/:id', async (request, reply) => {
        const id = idOf(request);
        const ws = request.workspaceId;
        await db.transaction().execute(async (trx) => {
          const row = await loadUser(trx, ws, id, true);
          if (row.deactivated_at === null || row.break_glass) await guardDeactivation(trx, ws, row);
          const now = new Date();
          let endedSessions = 0;
          if (row.deactivated_at === null) {
            await trx
              .updateTable('app_user')
              .set({ deactivated_at: now, updated_at: now })
              .where('id', '=', id)
              .execute();
            endedSessions = await signOut(trx, id);
          }
          const userName = row.user_name ?? row.email;
          const lapsed = await dropLapsedCreateTracks(trx, ws, [id]);
          await trx
            .insertInto('scim_user')
            .values({
              user_id: id,
              workspace_id: ws,
              user_name: userName,
              attributes: json({}),
              removed_at: now,
            })
            .onConflict((oc) =>
              oc.column('user_id').doUpdateSet({ removed_at: now, updated_at: now }),
            )
            .execute();
          await emit(trx, by(request), {
            type: 'scim.user_removed',
            subjectId: id,
            payload: { userName, endedSessions, ...lapsedPayload(lapsed) },
          });
        });
        return reply.code(204).send();
      });

      // Groups (RFC 7644 3.3 to 3.6).
      scim.get('/Groups', async (request) => {
        const q = queryParams(request.query);
        const ws = request.workspaceId;
        const filter = q.filter ? parseFilter(q.filter, GROUP_TYPE) : null;
        const rows = await narrowGroups(groupQuery(db, ws), filter).orderBy('g.id').execute();
        let hits = rows;
        if (filter) {
          const members = mentions(filter, 'members')
            ? await groupMembers(
                db,
                ws,
                rows.map((r) => r.id),
              )
            : null;
          hits = rows.filter((r) =>
            matches(groupResource(r, members?.get(r.id) ?? [], base), filter),
          );
        }
        const slice = hits.slice(q.startIndex - 1, q.startIndex - 1 + q.count);
        // Members are read only for a page that shows them.
        const skipMembers =
          q.excludedAttributes?.split(',').some((a) => a.trim().toLowerCase() === 'members') ||
          (q.attributes !== undefined &&
            !q.attributes.split(',').some((a) => a.trim().toLowerCase().startsWith('members')));
        const members = skipMembers
          ? null
          : await groupMembers(
              db,
              ws,
              slice.map((r) => r.id),
            );
        return listResponse(
          hits.length,
          q.startIndex,
          slice.map((r) =>
            project(
              groupResource(r, members?.get(r.id) ?? null, base),
              GROUP_TYPE,
              q.attributes,
              q.excludedAttributes,
            ),
          ),
        );
      });

      scim.get('/Groups/:id', async (request, reply) => {
        const ws = request.workspaceId;
        const row = await loadGroup(db, ws, idOf(request));
        return answer(reply, request, GROUP_TYPE, await groupView(db, ws, row));
      });

      scim.post('/Groups', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const body = bodyOf(request);
        checkSchemas(body, GROUP_TYPE);
        const resource = normalizeResource(body, GROUP_TYPE);
        const name = groupName(resource);
        const externalId = externalIdOf(resource);
        const ws = request.workspaceId;
        try {
          const created = await db.transaction().execute(async (trx) => {
            const members = await memberIds(trx, ws, resource.members);
            const group = await trx
              .insertInto('user_group')
              .values({ workspace_id: ws, name })
              .returning('id')
              .executeTakeFirstOrThrow();
            await trx
              .insertInto('scim_group')
              .values({ group_id: group.id, workspace_id: ws, external_id: externalId })
              .execute();
            if (members.length > 0) {
              await trx
                .insertInto('group_member')
                .values(
                  members.map((userId) => ({
                    workspace_id: ws,
                    group_id: group.id,
                    user_id: userId,
                  })),
                )
                .execute();
            }
            await emit(trx, by(request), {
              type: 'scim.group_created',
              subjectId: group.id,
              payload: { name, externalId, members },
            });
            return groupView(trx, ws, await loadGroup(trx, ws, group.id));
          });
          return answer(reply, request, GROUP_TYPE, created, 201);
        } catch (error) {
          if (uniqueViolation(error) === 'user_group_workspace_name_idx') {
            throw uniqueness('A group with that displayName exists');
          }
          throw error;
        }
      });

      scim.put('/Groups/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const id = idOf(request);
        const body = bodyOf(request);
        checkSchemas(body, GROUP_TYPE);
        const resource = await replaceGroup(request, id, () => body);
        return answer(reply, request, GROUP_TYPE, resource);
      });

      scim.patch('/Groups/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        const id = idOf(request);
        const operations = patchOperations(bodyOf(request));
        const resource = await replaceGroup(request, id, (current) =>
          applyPatch(current, operations, GROUP_TYPE),
        );
        return answer(reply, request, GROUP_TYPE, resource);
      });

      scim.delete('/Groups/:id', async (request, reply) => {
        const id = idOf(request);
        const ws = request.workspaceId;
        await db.transaction().execute(async (trx) => {
          const row = await loadGroup(trx, ws, id, true);
          const members = await effectiveMemberIds(trx, ws, id);
          await trx.deleteFrom('user_group').where('id', '=', id).execute();
          const lapsed = await dropLapsedCreateTracks(trx, ws, members);
          await emit(trx, by(request), {
            type: 'scim.group_deleted',
            subjectId: id,
            payload: { name: row.name, ...lapsedPayload(lapsed) },
          });
        });
        return reply.code(204).send();
      });
    },
    { prefix: SCIM_PREFIX },
  );
}
