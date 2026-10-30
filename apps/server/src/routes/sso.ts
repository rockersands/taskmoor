import type { Database } from '@taskmoor/db';
import { newToken, openSecret, type PepperRing, sealSecret, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { recordSsoRefusal } from '../audit/record';
import { requireSiteAdmin } from '../auth';
import { diff, emit } from '../events/bus';
import {
  emailDomain,
  finishAuthorization,
  insecureIssuerAllowed,
  PROVIDER_COLUMNS,
  type Provider,
  providerConfiguration,
  providerForDomain,
  returnAddress,
  safeReturnTo,
  startAuthorization,
} from '../sso/oidc';
import { MetadataError, parseIdpMetadata, readCertificates } from '../sso/saml';
import { certificateView, samlEndpoints } from '../sso/saml-provider';
import { completeSsoSignIn } from '../sso/sign-in';

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
/** What both protocols share: the name, the domains and policy, and the group mapping. */
const commonFields = {
  name: z.string().trim().min(1).max(100),
  groupClaim: z.string().trim().min(1).max(100).nullable(),
  domains: domainList,
  enforceSso: z.boolean(),
  jit: z.boolean(),
  enabled: z.boolean(),
  groupMap,
};
const commonDefaults = {
  domains: domainList.default([]),
  enforceSso: z.boolean().default(false),
  jit: z.boolean().default(true),
  enabled: z.boolean().default(true),
  groupMap: groupMap.default([]),
};
// Edits name only what changes, so the edit schemas have no defaults (zod applies a default
// even under .partial(), which would reset untouched fields).
const oidcEdit = z
  .object({
    ...commonFields,
    issuer: z.string().trim().url().max(500),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(1).max(2000).nullable(),
    scopes: z.string().trim().min(6).max(500),
  })
  .partial()
  .strict();
const oidcBody = oidcEdit
  .required({ name: true, issuer: true, clientId: true })
  .extend({ protocol: z.literal('oidc').optional(), ...commonDefaults })
  .strict();
/** An entity ID: a URI, usually a URL, never with white space or control characters. */
const entityId = z
  .string()
  .trim()
  .min(1)
  .max(500)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  .regex(/^[^\s\u0000-\u001f\u007f]+$/);
const samlEdit = z
  .object({
    ...commonFields,
    entityId,
    ssoUrl: z.string().trim().url().max(2000),
    certificates: z.array(z.string().min(1).max(20_000)).min(1).max(10),
    // Fills entityId, ssoUrl and certificates where those are not given.
    metadataXml: z.string().min(1).max(1_000_000),
    spEntityId: entityId.nullable(),
    emailAttribute: z.string().trim().min(1).max(500).nullable(),
    idpInitiated: z.boolean(),
  })
  .partial()
  .strict();
const samlBody = samlEdit
  .required({ name: true })
  .extend({
    protocol: z.literal('saml'),
    ...commonDefaults,
    idpInitiated: z.boolean().default(false),
  })
  .strict();

type GroupMap = { claimValue: string; groupId: number }[];

/** A refusal of an administrator's provider settings, with its code for the form. */
class ProviderProblem extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * A SAML provider's identity provider settings from what an administrator sent: explicit
 * fields win over the metadata, which fills the rest.
 */
function samlSettings(body: z.infer<typeof samlEdit>): {
  entityId?: string;
  ssoUrl?: string;
  certificates?: string[];
} {
  let metadata: ReturnType<typeof parseIdpMetadata> | undefined;
  if (body.metadataXml !== undefined) {
    try {
      metadata = parseIdpMetadata(body.metadataXml);
    } catch (error) {
      if (error instanceof MetadataError) {
        throw new ProviderProblem('invalid_metadata', error.message);
      }
      throw error;
    }
  }
  let certificates = metadata?.certificates;
  if (body.certificates !== undefined) {
    try {
      certificates = readCertificates(body.certificates);
    } catch {
      throw new ProviderProblem('invalid_certificate', 'A certificate cannot be read');
    }
  }
  const ssoUrl = body.ssoUrl ?? metadata?.ssoUrl;
  if (ssoUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(ssoUrl);
    } catch {
      throw new ProviderProblem('invalid_metadata', 'The sign-in address is not a URL');
    }
    if (!insecureIssuerAllowed(url)) {
      throw new ProviderProblem('insecure_sso_url', 'The sign-in address must use HTTPS');
    }
  }
  const entity = body.entityId ?? metadata?.entityId;
  return {
    ...(entity !== undefined ? { entityId: entity } : {}),
    ...(ssoUrl !== undefined ? { ssoUrl } : {}),
    ...(certificates !== undefined ? { certificates } : {}),
  };
}

/** SHA-256 fingerprints, which the audit log records for certificate changes. */
function fingerprints(pems: readonly string[]): (string | null)[] {
  return pems.map((pem) => certificateView(pem).fingerprint);
}

/**
 * Single sign-on through OpenID Connect (M1-080; IAM-003, IAM-004) and the identity provider
 * administration for both protocols (SAML: M1-081, IAM-002; its sign-in routes are in
 * `saml.ts`). The sign-in page offers the providers; an OpenID Connect sign-in starts at
 * /auth/oidc/:id/start and returns to /auth/oidc/callback, bound to the browser that started
 * it (a cookie), so nobody can complete someone else's sign-in. Accounts are linked by the
 * provider's subject; a first sign-in links a verified email of a domain the provider serves,
 * or creates the account when the provider allows it (`completeSsoSignIn`).
 */
export function registerSsoRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: {
    secureCookies: boolean;
    peppers: PepperRing | undefined;
    publicUrl: string;
    /** Frontends a sign-in may return to (M1-107). */
    allowedOrigins?: readonly string[];
  },
): void {
  const base = options.publicUrl.replace(/\/+$/, '');
  const frontends = new Set(options.allowedOrigins ?? []);
  const redirectUri = `${base}/api/v1/auth/oidc/callback`;

  function view(p: Provider, map: GroupMap) {
    const common = {
      id: p.id,
      name: p.name,
      protocol: p.kind,
      groupClaim: p.group_claim,
      domains: p.domains,
      enforceSso: p.enforce_sso,
      jit: p.jit,
      enabled: p.enabled,
      groupMap: map,
    };
    if (p.kind === 'saml') {
      return {
        ...common,
        entityId: p.issuer,
        ssoUrl: p.saml_sso_url,
        certificates: p.saml_certificates.map(certificateView),
        spEntityId: p.saml_sp_entity_id,
        emailAttribute: p.saml_email_attribute,
        idpInitiated: p.saml_idp_initiated,
        // What to register at this provider.
        serviceProvider: samlEndpoints(base, p),
      };
    }
    return {
      ...common,
      issuer: p.issuer,
      clientId: p.client_id,
      hasClientSecret: p.client_secret_sealed !== null,
      scopes: p.scopes,
    };
  }

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
      .select(['id', 'name', 'kind'])
      .where('workspace_id', '=', request.workspaceId)
      .where('enabled', '=', true)
      .orderBy(sql`lower(name)`)
      .execute();
    return { providers: rows.map((r) => ({ id: r.id, name: r.name, protocol: r.kind })) };
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
      provider: provider ? { id: provider.id, name: provider.name, protocol: provider.kind } : null,
      password: !provider?.enforce_sso,
    };
  });

  app.get('/api/v1/auth/oidc/:id/start', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ returnTo: z.string().max(500).optional() }).safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const provider = await loadProvider(request.workspaceId, params.data.id);
    if (!provider?.enabled || provider.kind !== 'oidc') return fail(reply, 'provider_unavailable');
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
        return_to: safeReturnTo(query.data.returnTo, frontends),
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
    if (!provider?.enabled || provider.kind !== 'oidc' || !verifier) {
      return fail(reply, 'provider_unavailable');
    }

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

    const outcome = await completeSsoSignIn(
      db,
      request,
      reply,
      { id: provider.id, protocol: 'oidc', domains: provider.domains, jit: provider.jit },
      identity,
      { secureCookies: options.secureCookies },
    );
    if (outcome.error) {
      await recordSsoRefusal(db, {
        workspaceId: request.workspaceId,
        ip: request.ip,
        providerId: provider.id,
        userId: outcome.userId ?? null,
        email: identity.email,
        reason: outcome.error,
      });
      return fail(reply, outcome.error);
    }
    return reply.redirect(returnAddress(base, login.return_to), 302);
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

  async function writeGroupMap(
    trx: Transaction<Database>,
    workspaceId: number,
    providerId: number,
    map: GroupMap,
  ) {
    if (map.length === 0) return;
    await trx
      .insertInto('identity_provider_group')
      .values(
        map.map((m) => ({
          workspace_id: workspaceId,
          provider_id: providerId,
          claim_value: m.claimValue,
          group_id: m.groupId,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  app.get('/api/v1/identity-providers', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const rows = (await db
      .selectFrom('identity_provider')
      .select([...PROVIDER_COLUMNS])
      .where('workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(name)`)
      .execute()) as Provider[];
    return {
      providers: await Promise.all(rows.map(async (p) => view(p, await groupMapOf(p.id)))),
      // The address to register at every OpenID Connect provider, from the public URL: the
      // browser's own origin can differ (a proxy, an internal host name) and would register
      // the wrong one. SAML providers carry their own addresses (`serviceProvider`).
      redirectUri,
    };
  });

  app.post('/api/v1/identity-providers', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const ws = request.workspaceId;
    const isSaml = (request.body as { protocol?: unknown } | null)?.protocol === 'saml';
    let common: z.infer<typeof oidcBody> | z.infer<typeof samlBody>;
    let columns: {
      kind: 'oidc' | 'saml';
      issuer: string;
      client_id: string | null;
      client_secret_sealed?: string | null;
      scopes?: string;
      saml_sso_url?: string;
      saml_certificates?: string[];
      saml_sp_entity_id?: string | null;
      saml_email_attribute?: string | null;
      saml_idp_initiated?: boolean;
    };
    if (isSaml) {
      const parsed = samlBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const body = parsed.data;
      let settings: ReturnType<typeof samlSettings>;
      try {
        settings = samlSettings(body);
      } catch (error) {
        if (!(error instanceof ProviderProblem)) throw error;
        return reply.code(400).send({ error: error.code, detail: error.detail });
      }
      if (!settings.entityId || !settings.ssoUrl || !settings.certificates?.length) {
        return reply.code(400).send({
          error: 'invalid_request',
          detail:
            'A SAML provider needs metadata, or an entity ID, sign-in address and certificate',
        });
      }
      common = body;
      columns = {
        kind: 'saml',
        issuer: settings.entityId,
        client_id: null,
        saml_sso_url: settings.ssoUrl,
        saml_certificates: settings.certificates,
        saml_sp_entity_id: body.spEntityId ?? null,
        saml_email_attribute: body.emailAttribute ?? null,
        saml_idp_initiated: body.idpInitiated,
      };
    } else {
      const parsed = oidcBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const body = parsed.data;
      const problem = issuerProblem(body.issuer);
      if (problem) return reply.code(400).send({ error: 'insecure_issuer', detail: problem });
      common = body;
      columns = {
        kind: 'oidc',
        issuer: body.issuer,
        client_id: body.clientId,
        client_secret_sealed: body.clientSecret
          ? sealSecret(body.clientSecret, options.peppers?.active)
          : null,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      };
    }
    if (!(await checkGroups(ws, common.groupMap)))
      return reply.code(404).send({ error: 'not_found' });
    const taken = common.enabled ? await domainsTaken(ws, common.domains) : [];
    if (taken.length > 0) return reply.code(409).send({ error: 'domain_taken', domains: taken });
    try {
      const provider = await db.transaction().execute(async (trx) => {
        const row = (await trx
          .insertInto('identity_provider')
          .values({
            workspace_id: ws,
            name: common.name,
            group_claim: common.groupClaim ?? null,
            domains: common.domains,
            enforce_sso: common.enforceSso,
            jit: common.jit,
            enabled: common.enabled,
            ...columns,
          })
          .returning([...PROVIDER_COLUMNS])
          .executeTakeFirstOrThrow()) as Provider;
        await writeGroupMap(trx, ws, row.id, common.groupMap);
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'identity_provider.created',
            subjectId: row.id,
            payload: {
              name: row.name,
              protocol: row.kind,
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
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const current = await loadProvider(ws, params.data.id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    // The protocol stays the provider's: the other protocol's fields are refused.
    const parsed =
      current.kind === 'saml' ? samlEdit.safeParse(request.body) : oidcEdit.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    const next: Record<string, unknown> = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.groupClaim !== undefined ? { group_claim: body.groupClaim } : {}),
      ...(body.domains !== undefined ? { domains: body.domains } : {}),
      ...(body.enforceSso !== undefined ? { enforce_sso: body.enforceSso } : {}),
      ...(body.jit !== undefined ? { jit: body.jit } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };
    let secret: { client_secret_sealed: string | null } | undefined;
    let certificates: string[] | undefined;
    if (current.kind === 'saml') {
      const saml = body as z.infer<typeof samlEdit>;
      let settings: ReturnType<typeof samlSettings>;
      try {
        settings = samlSettings(saml);
      } catch (error) {
        if (!(error instanceof ProviderProblem)) throw error;
        return reply.code(400).send({ error: error.code, detail: error.detail });
      }
      if (settings.entityId !== undefined) next.issuer = settings.entityId;
      if (settings.ssoUrl !== undefined) next.saml_sso_url = settings.ssoUrl;
      if (saml.spEntityId !== undefined) next.saml_sp_entity_id = saml.spEntityId;
      if (saml.emailAttribute !== undefined) next.saml_email_attribute = saml.emailAttribute;
      if (saml.idpInitiated !== undefined) next.saml_idp_initiated = saml.idpInitiated;
      if (
        settings.certificates !== undefined &&
        settings.certificates.join('\n') !== current.saml_certificates.join('\n')
      ) {
        certificates = settings.certificates;
      }
    } else {
      const oidc = body as z.infer<typeof oidcEdit>;
      if (oidc.issuer !== undefined) {
        const problem = issuerProblem(oidc.issuer);
        if (problem) return reply.code(400).send({ error: 'insecure_issuer', detail: problem });
        next.issuer = oidc.issuer;
      }
      if (oidc.clientId !== undefined) next.client_id = oidc.clientId;
      if (oidc.scopes !== undefined) next.scopes = oidc.scopes;
      if (oidc.clientSecret !== undefined) {
        secret = {
          client_secret_sealed: oidc.clientSecret
            ? sealSecret(oidc.clientSecret, options.peppers?.active)
            : null,
        };
      }
    }
    if (body.groupMap && !(await checkGroups(ws, body.groupMap)))
      return reply.code(404).send({ error: 'not_found' });
    const enabled = body.enabled ?? current.enabled;
    const domains = body.domains ?? current.domains;
    const taken = enabled ? await domainsTaken(ws, domains, current.id) : [];
    if (taken.length > 0) return reply.code(409).send({ error: 'domain_taken', domains: taken });
    try {
      const provider = await db.transaction().execute(async (trx) => {
        const row = (await trx
          .updateTable('identity_provider')
          .set({
            ...next,
            ...(secret ?? {}),
            ...(certificates ? { saml_certificates: certificates } : {}),
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
          await writeGroupMap(trx, ws, current.id, body.groupMap);
        }
        const changes = diff(current as unknown as Record<string, unknown>, next);
        // Certificates are recorded by fingerprint, which is what administrators compare.
        if (certificates) {
          changes.certificates = {
            from: fingerprints(current.saml_certificates),
            to: fingerprints(certificates),
          };
        }
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'identity_provider.updated',
            subjectId: current.id,
            payload: {
              changes,
              clientSecretChanged: secret !== undefined,
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
