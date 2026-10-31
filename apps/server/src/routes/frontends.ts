import type { Database } from '@taskmoor/db';
import { frontendWindow } from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { diff, emit } from '../events/bus';
import { frontendOrigin, frontendRedirectUri } from '../network/frontends';
import type { OriginPolicy } from '../origins';

type Db = Kysely<Database> | Transaction<Database>;

const MAX_REDIRECT_URIS = 20;
const addBody = z
  .object({
    origin: z.string().max(300),
    label: z.string().trim().max(200).optional(),
    /** Where OAuth sign-in may return; the origin's root unless given, none for cookie only. */
    redirectUris: z.array(z.string().max(2000)).max(MAX_REDIRECT_URIS).optional(),
    websocket: z.boolean().optional(),
  })
  .strict();
const patchBody = addBody.omit({ origin: true }).strict();
const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) }).strict();

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/** A registered frontend as every answer shows it. */
export interface FrontendView {
  id: number;
  origin: string;
  label: string;
  redirectUris: string[];
  websocket: boolean;
  /** The frontend version it last reported, and when; null until it has. */
  lastVersion: string | null;
  lastSeenAt: string | null;
  addedBy: { id: number; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** TASKMOOR_ALLOWED_ORIGINS lists it too: removing it here does not refuse it. */
  inEnvironment: boolean;
}

function frontendQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('frontend_origin as f')
    .leftJoin('app_user as u', 'u.id', 'f.created_by')
    .select([
      'f.id',
      'f.origin',
      'f.label',
      'f.redirect_uris',
      'f.websocket',
      'f.last_version',
      'f.last_seen_at',
      'f.created_by',
      'f.created_at',
      'f.updated_at',
      'u.name as added_by_name',
    ])
    .where('f.workspace_id', '=', workspaceId);
}

type Row = Awaited<ReturnType<ReturnType<typeof frontendQuery>['executeTakeFirstOrThrow']>>;

/** Checks the redirect URIs given for an origin: the normal forms, or the bad entries' fields. */
function redirectUris(
  given: readonly string[],
  origin: string,
): { uris: string[] } | { fields: Record<string, string> } {
  const uris: string[] = [];
  const fields: Record<string, string> = {};
  for (const [i, text] of given.entries()) {
    const uri = frontendRedirectUri(text, origin);
    if (!uri) fields[`redirectUris.${i}`] = 'invalid_redirect_uri';
    else if (!uris.includes(uri)) uris.push(uri);
  }
  return Object.keys(fields).length > 0 ? { fields } : { uris };
}

/**
 * Registered frontend origins for site administrators (M1-108; IAM-025, API-017; ADR-087):
 * frontends on other origins besides those TASKMOOR_ALLOWED_ORIGINS lists, each with its OAuth
 * return addresses, whether it may open the WebSockets, and the frontend version it last
 * reported. A change applies at once in this process and within the policy's TTL in others.
 *
 * - `GET /api/v1/admin/frontends`: this server's own origin (and the frontend it serves, when
 *   it serves one), the environment's list, the registered frontends and the versions this
 *   backend wants;
 * - `POST`: add one (an exact origin: https, or http for localhost; no path, no wildcard);
 * - `PATCH /:id`: its label, return addresses or socket grant (the origin stays: remove it and
 *   add the other);
 * - `DELETE /:id`: remove it; its next request is refused.
 */
export function registerFrontendRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: {
    origins: OriginPolicy;
    version: string;
    /** Whether this process serves the frontend itself (the web role, single-server mode). */
    servesFrontend: boolean;
  },
): void {
  const { origins } = options;
  const view = (row: Row): FrontendView => ({
    id: row.id,
    origin: row.origin,
    label: row.label,
    redirectUris: row.redirect_uris,
    websocket: row.websocket,
    lastVersion: row.last_version,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    addedBy:
      row.created_by !== null && row.added_by_name !== null
        ? { id: row.created_by, name: row.added_by_name }
        : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    inEnvironment: origins.environment.includes(row.origin),
  });
  const find = (trx: Db, workspaceId: number, id: number) =>
    frontendQuery(trx, workspaceId).where('f.id', '=', id).executeTakeFirst();

  app.get('/api/v1/admin/frontends', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const rows = await frontendQuery(db, request.workspaceId).orderBy('f.origin').execute();
    const envRedirects = [...origins.environmentRedirectUris];
    return {
      self: {
        origin: origins.own,
        servedVersion: options.servesFrontend ? options.version : null,
      },
      backend: { version: options.version, frontend: frontendWindow(options.version) },
      environment: origins.environment.map((origin) => ({
        origin,
        redirectUris: envRedirects.filter((uri) => new URL(uri).origin === origin),
      })),
      frontends: rows.map(view),
    };
  });

  app.post('/api/v1/admin/frontends', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = addBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const origin = frontendOrigin(parsed.data.origin);
    if (!origin) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', fields: { origin: 'invalid_origin' } });
    }
    if (origin === origins.own) {
      return reply.code(400).send({ error: 'invalid_request', fields: { origin: 'own_origin' } });
    }
    const checked = redirectUris(parsed.data.redirectUris ?? [`${origin}/`], origin);
    if ('fields' in checked) {
      return reply.code(400).send({ error: 'invalid_request', fields: checked.fields });
    }
    const workspaceId = request.workspaceId;
    const label = parsed.data.label ?? '';
    const websocket = parsed.data.websocket ?? true;
    try {
      const row = await db.transaction().execute(async (trx) => {
        const { id } = await trx
          .insertInto('frontend_origin')
          .values({
            workspace_id: workspaceId,
            origin,
            label,
            redirect_uris: checked.uris,
            websocket,
            created_by: admin.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await emit(
          trx,
          { workspaceId, actorId: admin.id },
          {
            type: 'frontend_origin.created',
            subjectId: id,
            payload: { origin, label, redirectUris: checked.uris, websocket },
          },
        );
        return (await find(trx, workspaceId, id)) as Row;
      });
      origins.changed();
      return reply.code(201).send({ frontend: view(row) });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'origin_exists' });
      throw error;
    }
  });

  app.patch('/api/v1/admin/frontends/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const workspaceId = request.workspaceId;
    const outcome = await db.transaction().execute(async (trx) => {
      const before = await find(trx, workspaceId, params.data.id);
      if (!before) return { status: 404 as const };
      let uris: string[] | undefined;
      if (parsed.data.redirectUris !== undefined) {
        const checked = redirectUris(parsed.data.redirectUris, before.origin);
        if ('fields' in checked) return { status: 400 as const, fields: checked.fields };
        uris = checked.uris;
      }
      const changes = diff<Record<string, unknown>>(
        { label: before.label, redirectUris: before.redirect_uris, websocket: before.websocket },
        { label: parsed.data.label, redirectUris: uris, websocket: parsed.data.websocket },
      );
      if (Object.keys(changes).length === 0) return { status: 200 as const, row: before };
      await trx
        .updateTable('frontend_origin')
        .set({
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
          ...(uris !== undefined ? { redirect_uris: uris } : {}),
          ...(parsed.data.websocket !== undefined ? { websocket: parsed.data.websocket } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', before.id)
        .execute();
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        {
          type: 'frontend_origin.updated',
          subjectId: before.id,
          payload: { origin: before.origin, changes },
        },
      );
      return { status: 200 as const, row: (await find(trx, workspaceId, before.id)) as Row };
    });
    if (outcome.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (outcome.status === 400) {
      return reply.code(400).send({ error: 'invalid_request', fields: outcome.fields });
    }
    origins.changed();
    return { frontend: view(outcome.row) };
  });

  app.delete('/api/v1/admin/frontends/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const workspaceId = request.workspaceId;
    const gone = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('frontend_origin')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', params.data.id)
        .returning(['id', 'origin'])
        .executeTakeFirst();
      if (!row) return false;
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        { type: 'frontend_origin.deleted', subjectId: row.id, payload: { origin: row.origin } },
      );
      return true;
    });
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    origins.changed();
    return reply.code(204).send();
  });
}
