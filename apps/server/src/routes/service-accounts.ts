import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { diff, emit } from '../events/bus';
import {
  expiryFields,
  expiryFrom,
  findTokenView,
  isExpiryProblem,
  issueApiToken,
  scopesField,
  TOKEN_VIEW_COLUMNS,
  tokenNameField,
  tokenPolicy,
  toTokenView,
} from '../tokens/api-tokens';
import { rotateAndReply, rotateBody } from './tokens';

const id = z.coerce.number().int().positive();
const idParams = z.object({ id });
const tokenParams = z.object({ id, tokenId: id });
const listQuery = z.object({
  status: z.enum(['active', 'deactivated', 'all']).default('active'),
});
const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(''),
  })
  .strict();
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
const tokenBody = z.object({ name: tokenNameField, scopes: scopesField, ...expiryFields }).strict();

/**
 * Service accounts get an address in the reserved `.invalid` domain (RFC 2606): it identifies
 * them in member lists and can never receive mail or match a person's account.
 */
export const SERVICE_ACCOUNT_DOMAIN = 'service.invalid';

function slug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'service';
}

export interface ServiceAccountView {
  id: number;
  name: string;
  email: string;
  description: string;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  activeTokens: number;
}

const COLUMNS = ['id', 'name', 'email', 'description', 'created_at', 'deactivated_at'] as const;

function toView(row: {
  id: number;
  name: string;
  email: string;
  description: string;
  created_at: Date;
  deactivated_at: Date | null;
  active_tokens?: string | number | null;
}): ServiceAccountView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    description: row.description,
    active: row.deactivated_at === null,
    createdAt: row.created_at.toISOString(),
    deactivatedAt: row.deactivated_at?.toISOString() ?? null,
    activeTokens: Number(row.active_tokens ?? 0),
  };
}

/**
 * Service accounts (M1-004; IAM-007): accounts for programs, owned by the workspace and managed
 * by site administrators. They have no password and never sign in, are not counted as users,
 * and act only through their own named, expiring tokens; groups and grants apply to them as to
 * anyone, so authorization treats them like people. Deactivating one stops its tokens at once.
 */
export function registerServiceAccountRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const accounts = (workspaceId: number) =>
    db
      .selectFrom('app_user as a')
      .where('a.workspace_id', '=', workspaceId)
      .where('a.kind', '=', 'service');

  const withTokenCount = (workspaceId: number) =>
    accounts(workspaceId).select((eb) => [
      ...COLUMNS.map((c) => `a.${c}` as const),
      eb
        .selectFrom('api_token as t')
        .select((t) => t.fn.countAll<string>().as('n'))
        .whereRef('t.user_id', '=', 'a.id')
        .where('t.revoked_at', 'is', null)
        .where('t.expires_at', '>', new Date())
        .as('active_tokens'),
    ]);

  async function findAccount(workspaceId: number, accountId: number) {
    return withTokenCount(workspaceId).where('a.id', '=', accountId).executeTakeFirst();
  }

  /** The account for a path id, or a 404 already sent. */
  async function accountOr404(request: FastifyRequest, reply: FastifyReply) {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      await reply.code(400).send({ error: 'invalid_request' });
      return null;
    }
    const row = await findAccount(request.workspaceId, params.data.id);
    if (!row) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return row;
  }

  app.get('/api/v1/service-accounts', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    let query = withTokenCount(request.workspaceId);
    if (parsed.data.status === 'active') query = query.where('a.deactivated_at', 'is', null);
    if (parsed.data.status === 'deactivated') {
      query = query.where('a.deactivated_at', 'is not', null);
    }
    const rows = await query.orderBy(sql`lower(a.name)`).orderBy('a.id').execute();
    return { serviceAccounts: rows.map(toView) };
  });

  app.post('/api/v1/service-accounts', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { name, description } = parsed.data;
    const base = slug(name);
    const row = await db.transaction().execute(async (trx) => {
      // The first free address of base@, base-2@, base-3@ ...; the unique index settles races.
      const taken = new Set(
        (
          await trx
            .selectFrom('app_user')
            .select(sql<string>`lower(email)`.as('email'))
            .where('workspace_id', '=', request.workspaceId)
            .where(sql<string>`lower(email)`, 'like', `${base}%@${SERVICE_ACCOUNT_DOMAIN}`)
            .execute()
        ).map((r) => r.email),
      );
      let email = `${base}@${SERVICE_ACCOUNT_DOMAIN}`;
      for (let n = 2; taken.has(email); n++) email = `${base}-${n}@${SERVICE_ACCOUNT_DOMAIN}`;
      const created = await trx
        .insertInto('app_user')
        .values({
          workspace_id: request.workspaceId,
          email,
          name,
          description,
          kind: 'service',
          password_hash: null,
        })
        .returning([...COLUMNS])
        .executeTakeFirstOrThrow();
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'service_account.created',
          subjectId: created.id,
          payload: { name, email, description },
        },
      );
      return created;
    });
    return reply.code(201).send({ serviceAccount: toView(row) });
  });

  app.get('/api/v1/service-accounts/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const row = await accountOr404(request, reply);
    if (!row) return reply;
    const now = new Date();
    const [tokens, groups] = await Promise.all([
      db
        .selectFrom('api_token as t')
        .innerJoin('app_user as u', 'u.id', 't.user_id')
        .select([...TOKEN_VIEW_COLUMNS])
        .where('t.user_id', '=', row.id)
        .where('t.workspace_id', '=', request.workspaceId)
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id', 'desc')
        .execute(),
      db
        .selectFrom('group_member as m')
        .innerJoin('user_group as g', 'g.id', 'm.group_id')
        .select(['g.id', 'g.name'])
        .where('m.user_id', '=', row.id)
        .where('m.workspace_id', '=', request.workspaceId)
        .orderBy(sql`lower(g.name)`)
        .execute(),
    ]);
    return {
      serviceAccount: toView(row),
      tokens: tokens.map((t) => toTokenView(t, now)),
      groups,
    };
  });

  app.patch('/api/v1/service-accounts/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await accountOr404(request, reply);
    if (!row) return reply;
    const asked = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    };
    const changes = diff({ name: row.name, description: row.description }, asked);
    await db.transaction().execute(async (trx) => {
      if (Object.keys(changes).length === 0) return;
      await trx
        .updateTable('app_user')
        .set({ ...asked, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        { type: 'service_account.updated', subjectId: row.id, payload: { changes } },
      );
    });
    const updated = await findAccount(request.workspaceId, row.id);
    return { serviceAccount: updated ? toView(updated) : null };
  });

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post(`/api/v1/service-accounts/:id/${action}`, async (request, reply) => {
      const admin = await requireSiteAdmin(request, reply);
      if (!admin) return reply;
      const row = await accountOr404(request, reply);
      if (!row) return reply;
      const deactivating = action === 'deactivate';
      await db.transaction().execute(async (trx) => {
        // Only a change of state is an event; asking twice changes nothing.
        if ((row.deactivated_at === null) !== deactivating) return;
        await trx
          .updateTable('app_user')
          .set({ deactivated_at: deactivating ? new Date() : null, updated_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          deactivating
            ? { type: 'service_account.deactivated', subjectId: row.id, payload: {} }
            : { type: 'service_account.reactivated', subjectId: row.id, payload: {} },
        );
      });
      const updated = await findAccount(request.workspaceId, row.id);
      return { serviceAccount: updated ? toView(updated) : null };
    });
  }

  // A named, expiring token for the service account, shown once.
  app.post('/api/v1/service-accounts/:id/tokens', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await accountOr404(request, reply);
    if (!row) return reply;
    if (row.deactivated_at) return reply.code(409).send({ error: 'deactivated' });
    const now = new Date();
    const expiresAt = expiryFrom(parsed.data, await tokenPolicy(db, request.workspaceId), now);
    if (isExpiryProblem(expiresAt)) return reply.code(400).send(expiresAt);
    const { name, scopes } = parsed.data;
    const issued = await db.transaction().execute(async (trx) => {
      const created = await issueApiToken(trx, {
        workspaceId: request.workspaceId,
        userId: row.id,
        name,
        scopes,
        expiresAt,
        createdBy: admin.id,
        now,
      });
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'token.created',
          subjectId: created.id,
          payload: {
            ownerId: row.id,
            ownerKind: 'service',
            name,
            scopes,
            expiresAt: expiresAt.toISOString(),
          },
        },
      );
      return created;
    });
    const view = await findTokenView(db, request.workspaceId, issued.id);
    return reply.code(201).send({ token: issued.token, apiToken: view });
  });

  // Rotation with an overlap window (IAM-007 criterion 3): the old token keeps working for
  // `overlapHours` (24 by default, 0 ends it now) while the program switches to the new one.
  app.post('/api/v1/service-accounts/:id/tokens/:tokenId/rotate', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = tokenParams.safeParse(request.params);
    const parsed = rotateBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const row = await findAccount(request.workspaceId, params.data.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.deactivated_at) return reply.code(409).send({ error: 'deactivated' });
    return rotateAndReply(db, request, reply, {
      tokenId: params.data.tokenId,
      ownerId: row.id,
      actorId: admin.id,
      by: 'admin',
      body: parsed.data,
    });
  });
}
