import type { Database } from '@taskmoor/db';
import { newToken, openSecret, type PepperRing, sealSecret, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { recordSsoRefusal } from '../audit/record';
import { requireSiteAdmin, startSession } from '../auth';
import { diff, emit } from '../events/bus';
import {
  emailDomain,
  finishAuthorization,
  insecureIssuerAllowed,
  PROVIDER_COLUMNS,
  type Provider,
  providerConfiguration,
  providerForDomain,
  safeReturnTo,
  startAuthorization,
  syncGroups,
} from '../sso/oidc';

const LOGIN_COOKIE = 'taskmoor_oidc';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const id = z.coerce.number().int().positive();
const domainList = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
      // Service accounts live under the reserved .invalid name; no provider may claim it.
      .refine((d) => !d.endsWith('.invalid')),
  )
  .max(100);
const groupMap = z
  .array(z.object({ claimValue: z.string().trim().min(1).max(500), groupId: id }))
  .max(1000);
// Edits name only what changes, so the edit schema has no defaults (zod applies a default
// even under .partial(), which would reset untouched fields).
const providerEdit = z
  .object({
    name: z.string().trim().min(1).max(100),
    issuer: z.string().trim().url().max(500),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(1).max(2000).nullable(),
    scopes: z.string().trim().min(6).max(500),
    groupClaim: z.string().trim().min(1).max(100).nullable(),
    domains: domainList,
    enforceSso: z.boolean(),
    jit: z.boolean(),
    enabled: z.boolean(),
    groupMap,
  })
  .partial()
  .strict();
const providerBody = providerEdit
  .required({ name: true, issuer: true, clientId: true })
  .extend({
    domains: domainList.default([]),
    enforceSso: z.boolean().default(false),
    jit: z.boolean().default(true),
    enabled: z.boolean().default(true),
    groupMap: groupMap.default([]),
  })
  .strict();

function view(p: Provider, groupMap: { claimValue: string; groupId: number }[]) {
  return {
    id: p.id,
    name: p.name,
    issuer: p.issuer,
    clientId: p.client_id,
    hasClientSecret: p.client_secret_sealed !== null,
    scopes: p.scopes,
    groupClaim: p.group_claim,
    domains: p.domains,
    enforceSso: p.enforce_sso,
    jit: p.jit,
    enabled: p.enabled,
    groupMap,
  };
}

/**
 * Single sign-on through OpenID Connect (M1-080; IAM-003, IAM-004). The sign-in page offers
 * the providers; a sign-in starts at /auth/oidc/:id/start and returns to /auth/oidc/callback,
 * bound to the browser that started it (a cookie), so nobody can complete someone else's
 * sign-in. Accounts are linked by the provider's subject; a first sign-in links a verified
 * email of a domain the provider serves, or creates the account when the provider allows it.
 */
export function registerSsoRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { secureCookies: boolean; peppers: PepperRing | undefined; publicUrl: string },
): void {
  const base = options.publicUrl.replace(/\/+$/, '');
  const redirectUri = `${base}/api/v1/auth/oidc/callback`;

  async function loadProvider(workspaceId: number, providerId: number) {
    return (await db
      .selectFrom('identity_provider')
      .select([...PROVIDER_COLUMNS])
      .where('id', '=', providerId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst()) as Provider | undefined;
  }

  async function groupMapOf(providerId: number) {
    const rows = await db
      .selectFrom('identity_provider_group')
      .select(['claim_value', 'group_id'])
      .where('provider_id', '=', providerId)
      .orderBy('claim_value')
      .orderBy('group_id')
      .execute();
    return rows.map((r) => ({ claimValue: r.claim_value, groupId: r.group_id }));
  }

  const fail = (reply: FastifyReply, code: string) =>
    reply.redirect(`${base}/#/sign-in?sso_error=${encodeURIComponent(code)}`, 302);

  // ---- Public: what the sign-in page offers ----

  app.get('/api/v1/auth/providers', async (request) => {
    const rows = await db
      .selectFrom('identity_provider')
      .select(['id', 'name'])
      .where('workspace_id', '=', request.workspaceId)
      .where('enabled', '=', true)
      .orderBy(sql`lower(name)`)
      .execute();
    return { providers: rows };
  });

  // Which sign-in methods an email's domain uses; decided by the domain alone, never by
  // whether an account exists.
  app.post('/api/v1/auth/discover', async (request, reply) => {
    const parsed = z.object({ email: z.string().trim().max(320) }).safeParse(request.body);
    if (!parsed.success || !parsed.data.email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const provider = await providerForDomain(
      db,
      request.workspaceId,
      emailDomain(parsed.data.email),
    );
    return {
      provider: provider ? { id: provider.id, name: provider.name } : null,
      password: !provider?.enforce_sso,
    };
  });

  app.get('/api/v1/auth/oidc/:id/start', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ returnTo: z.string().max(500).optional() }).safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const provider = await loadProvider(request.workspaceId, params.data.id);
    if (!provider?.enabled) return fail(reply, 'provider_unavailable');
    let start: Awaited<ReturnType<typeof startAuthorization>>;
    try {
      start = await startAuthorization(
        await providerConfiguration(provider, options.peppers),
        provider,
        redirectUri,
      );
    } catch (error) {
      request.log.warn({ error, provider: provider.id }, 'OIDC discovery failed');
      return fail(reply, 'provider_unavailable');
    }
    const browser = newToken();
    await db
      .insertInto('oidc_login')
      .values({
        workspace_id: request.workspaceId,
        provider_id: provider.id,
        state_hash: tokenHash(start.state),
        browser_hash: tokenHash(browser),
        nonce: start.nonce,
        code_verifier_sealed: sealSecret(start.verifier, options.peppers?.active),
        return_to: safeReturnTo(query.data.returnTo),
        expires_at: new Date(Date.now() + LOGIN_TTL_MS),
      })
      .execute();
    reply.setCookie(LOGIN_COOKIE, browser, {
      path: '/api/v1/auth/oidc',
      httpOnly: true,
      // The provider sends the browser back with a top-level GET: Lax cookies travel with it.
      sameSite: 'lax',
      secure: options.secureCookies,
      maxAge: LOGIN_TTL_MS / 1000,
    });
    return reply.redirect(start.url.toString(), 302);
  });

  app.get('/api/v1/auth/oidc/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const browser = request.cookies[LOGIN_COOKIE];
    reply.clearCookie(LOGIN_COOKIE, { path: '/api/v1/auth/oidc' });
    if (!query.state || !browser) return fail(reply, 'invalid_state');
    const login = await db
      .deleteFrom('oidc_login')
      .where('state_hash', '=', tokenHash(query.state))
      .where('workspace_id', '=', request.workspaceId)
      .returning([
        'provider_id',
        'browser_hash',
        'nonce',
        'code_verifier_sealed',
        'return_to',
        'expires_at',
      ])
      .executeTakeFirst();
    if (!login || login.browser_hash !== tokenHash(browser) || login.expires_at < new Date()) {
      return fail(reply, 'invalid_state');
    }
    if (query.error) return fail(reply, 'provider_error');
    const provider = await loadProvider(request.workspaceId, login.provider_id);
    const verifier = openSecret(login.code_verifier_sealed, options.peppers);
    if (!provider?.enabled || !verifier) return fail(reply, 'provider_unavailable');

    let identity: Awaited<ReturnType<typeof finishAuthorization>>;
    try {
      identity = await finishAuthorization(
        await providerConfiguration(provider, options.peppers),
        provider,
        new URL(request.url, base),
        { state: query.state, nonce: login.nonce, verifier },
      );
    } catch (error) {
      request.log.warn({ error, provider: provider.id }, 'OIDC sign-in failed');
      return fail(reply, 'provider_error');
    }
    if (!identity.subject) return fail(reply, 'provider_error');

    const ws = request.workspaceId;
    const outcome = await db.transaction().execute(async (trx) => {
      const linked = await trx
        .selectFrom('user_identity as i')
        .innerJoin('app_user as u', 'u.id', 'i.user_id')
        .select(['u.id', 'u.deactivated_at', 'u.kind'])
        .where('i.provider_id', '=', provider.id)
        .where('i.subject', '=', identity.subject)
        .executeTakeFirst();
      let userId = linked?.id;
      let created = false;
      // Service accounts never sign in, through a provider or otherwise (IAM-007).
      if (linked?.kind === 'service') return { error: 'no_account' as const };
      if (linked?.deactivated_at)
        return { error: 'account_deactivated' as const, userId: linked.id };
      if (!userId) {
        // A first sign-in: only a verified email of a domain this provider serves may be linked
        // to an account or create one, so a provider cannot claim someone else's address.
        if (!identity.email || !identity.emailVerified)
          return { error: 'email_unverified' as const };
        if (!provider.domains.includes(emailDomain(identity.email))) {
          return { error: 'domain_not_allowed' as const };
        }
        const existing = await trx
          .selectFrom('app_user')
          .select(['id', 'deactivated_at', 'kind'])
          .where('workspace_id', '=', ws)
          .where(sql<string>`lower(email)`, '=', identity.email)
          .executeTakeFirst();
        if (existing?.kind === 'service') return { error: 'no_account' as const };
        if (existing?.deactivated_at) {
          return { error: 'account_deactivated' as const, userId: existing.id };
        }
        if (existing) {
          userId = existing.id;
        } else {
          if (!provider.jit) return { error: 'no_account' as const };
          const row = await trx
            .insertInto('app_user')
            .values({
              workspace_id: ws,
              email: identity.email,
              name: identity.name ?? identity.email,
              password_hash: null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          userId = row.id;
          created = true;
        }
        await trx
          .insertInto('user_identity')
          .values({
            workspace_id: ws,
            provider_id: provider.id,
            subject: identity.subject,
            user_id: userId,
            email: identity.email,
          })
          .execute();
      }
      const groups = await syncGroups(trx, ws, provider.id, userId, identity.groups);
      const now = new Date();
      await trx
        .updateTable('user_identity')
        .set({ last_sign_in_at: now, ...(identity.email ? { email: identity.email } : {}) })
        .where('provider_id', '=', provider.id)
        .where('subject', '=', identity.subject)
        .execute();
      await trx
        .updateTable('app_user')
        .set({ last_sign_in_at: now })
        .where('id', '=', userId)
        .execute();
      const sessionId = await startSession(trx, request, reply, {
        userId,
        secure: options.secureCookies,
      });
      await emit(
        trx,
        { workspaceId: ws, actorId: userId },
        {
          type: 'sso.signed_in',
          subjectId: userId,
          payload: {
            providerId: provider.id,
            sessionId,
            userCreated: created,
            groupsAdded: groups.added,
            groupsRemoved: groups.removed,
          },
        },
      );
      return { error: null };
    });
    if (outcome.error) {
      await recordSsoRefusal(db, {
        workspaceId: ws,
        ip: request.ip,
        providerId: provider.id,
        userId: 'userId' in outcome ? (outcome.userId ?? null) : null,
        email: identity.email,
        reason: outcome.error,
      });
      return fail(reply, outcome.error);
    }
    return reply.redirect(`${base}${login.return_to === '/' ? '/' : login.return_to}`, 302);
  });

  // ---- Administration ----

  async function domainsTaken(workspaceId: number, domains: string[], except?: number) {
    if (domains.length === 0) return [];
    let query = db
      .selectFrom('identity_provider')
      .select('domains')
      .where('workspace_id', '=', workspaceId)
      .where('enabled', '=', true)
      .where(sql<boolean>`domains && ${sql.val(domains)}::text[]`);
    if (except !== undefined) query = query.where('id', '!=', except);
    const rows = await query.execute();
    return domains.filter((d) => rows.some((r) => r.domains.includes(d)));
  }

  async function checkGroups(workspaceId: number, map: { groupId: number }[]) {
    const ids = [...new Set(map.map((m) => m.groupId))];
    if (ids.length === 0) return true;
    const found = await db
      .selectFrom('user_group')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids)
      .execute();
    return found.length === ids.length;
  }

  function issuerProblem(issuer: string): string | null {
    return insecureIssuerAllowed(new URL(issuer)) ? null : 'The issuer must use HTTPS';
  }

  app.get('/api/v1/identity-providers', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const rows = (await db
      .selectFrom('identity_provider')
      .select([...PROVIDER_COLUMNS])
      .where('workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(name)`)
      .execute()) as Provider[];
    return { providers: await Promise.all(rows.map(async (p) => view(p, await groupMapOf(p.id)))) };
  });

  app.post('/api/v1/identity-providers', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = providerBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    const ws = request.workspaceId;
    const problem = issuerProblem(body.issuer);
    if (problem) return reply.code(400).send({ error: 'insecure_issuer', detail: problem });
    if (!(await checkGroups(ws, body.groupMap)))
      return reply.code(404).send({ error: 'not_found' });
    const taken = body.enabled ? await domainsTaken(ws, body.domains) : [];
    if (taken.length > 0) return reply.code(409).send({ error: 'domain_taken', domains: taken });
    try {
      const provider = await db.transaction().execute(async (trx) => {
        const row = (await trx
          .insertInto('identity_provider')
          .values({
            workspace_id: ws,
            name: body.name,
            issuer: body.issuer,
            client_id: body.clientId,
            client_secret_sealed: body.clientSecret
              ? sealSecret(body.clientSecret, options.peppers?.active)
              : null,
            ...(body.scopes ? { scopes: body.scopes } : {}),
            group_claim: body.groupClaim ?? null,
            domains: body.domains,
            enforce_sso: body.enforceSso,
            jit: body.jit,
            enabled: body.enabled,
          })
          .returning([...PROVIDER_COLUMNS])
          .executeTakeFirstOrThrow()) as Provider;
        if (body.groupMap.length > 0) {
          await trx
            .insertInto('identity_provider_group')
            .values(
              body.groupMap.map((m) => ({
                workspace_id: ws,
                provider_id: row.id,
                claim_value: m.claimValue,
                group_id: m.groupId,
              })),
            )
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'identity_provider.created',
            subjectId: row.id,
            payload: {
              name: row.name,
              issuer: row.issuer,
              domains: row.domains,
              enforceSso: row.enforce_sso,
              jit: row.jit,
              enabled: row.enabled,
            },
          },
        );
        return row;
      });
      return reply.code(201).send({ provider: view(provider, await groupMapOf(provider.id)) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/identity-providers/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = providerEdit.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const current = await loadProvider(ws, params.data.id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    const body = parsed.data;
    if (body.issuer) {
      const problem = issuerProblem(body.issuer);
      if (problem) return reply.code(400).send({ error: 'insecure_issuer', detail: problem });
    }
    if (body.groupMap && !(await checkGroups(ws, body.groupMap)))
      return reply.code(404).send({ error: 'not_found' });
    const enabled = body.enabled ?? current.enabled;
    const domains = body.domains ?? current.domains;
    const taken = enabled ? await domainsTaken(ws, domains, current.id) : [];
    if (taken.length > 0) return reply.code(409).send({ error: 'domain_taken', domains: taken });
    const next = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.issuer !== undefined ? { issuer: body.issuer } : {}),
      ...(body.clientId !== undefined ? { client_id: body.clientId } : {}),
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      ...(body.groupClaim !== undefined ? { group_claim: body.groupClaim } : {}),
      ...(body.domains !== undefined ? { domains: body.domains } : {}),
      ...(body.enforceSso !== undefined ? { enforce_sso: body.enforceSso } : {}),
      ...(body.jit !== undefined ? { jit: body.jit } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };
    try {
      const provider = await db.transaction().execute(async (trx) => {
        const row = (await trx
          .updateTable('identity_provider')
          .set({
            ...next,
            ...(body.clientSecret !== undefined
              ? {
                  client_secret_sealed: body.clientSecret
                    ? sealSecret(body.clientSecret, options.peppers?.active)
                    : null,
                }
              : {}),
            updated_at: new Date(),
          })
          .where('id', '=', current.id)
          .returning([...PROVIDER_COLUMNS])
          .executeTakeFirstOrThrow()) as Provider;
        if (body.groupMap) {
          await trx
            .deleteFrom('identity_provider_group')
            .where('provider_id', '=', current.id)
            .execute();
          if (body.groupMap.length > 0) {
            await trx
              .insertInto('identity_provider_group')
              .values(
                body.groupMap.map((m) => ({
                  workspace_id: ws,
                  provider_id: current.id,
                  claim_value: m.claimValue,
                  group_id: m.groupId,
                })),
              )
              .onConflict((oc) => oc.doNothing())
              .execute();
          }
        }
        const changes = diff(current as unknown as Record<string, unknown>, next);
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'identity_provider.updated',
            subjectId: current.id,
            payload: {
              changes,
              clientSecretChanged: body.clientSecret !== undefined,
              groupMapChanged: body.groupMap !== undefined,
            },
          },
        );
        return row;
      });
      return { provider: view(provider, await groupMapOf(provider.id)) };
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/identity-providers/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('identity_provider')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'identity_provider.deleted', subjectId: row.id, payload: { name: row.name } },
        );
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
