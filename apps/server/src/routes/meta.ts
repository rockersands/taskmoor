import type { Database } from '@taskmoor/db';
import type { PepperRing } from '@taskmoor/iam';
import { frontendWindow, NONCE } from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { API_VERSION } from '../api/operation';
import { type InstanceIdentity, loadIdentity } from '../meta/identity';
import { INSTANCE_KEY, readSetting } from '../setup';

/**
 * The public meta endpoint (M1-106; API-017, API-018, OPS-017; ADR-070): `GET /api/meta`,
 * without signing in, says what a frontend needs before it shows anything: the API version, the
 * frontend versions this backend works with, how people sign in (public parts of each identity
 * provider only), and who the instance is, by id and public key. With `?nonce=`, the instance
 * signs the nonce, so a kit can prove it reached the backend it was built for.
 *
 * Every value is public, and the answer carries no cookie, so any origin may read it.
 */
export const metaQuery = z
  .object({
    nonce: z.string().regex(NONCE).optional().meta({
      description:
        '16 to 128 base64url characters the instance signs, chosen afresh by the caller.',
    }),
  })
  .strict();

const provider = z
  .object({
    id: z.number().int(),
    name: z.string(),
    protocol: z.enum(['oidc', 'saml']),
    issuer: z.string().meta({
      description: 'OpenID Connect: the issuer URL. SAML: the identity provider’s entity ID.',
    }),
    clientId: z.string().nullable().meta({ description: 'OpenID Connect only.' }),
    ssoUrl: z.string().nullable().meta({ description: 'SAML only: where sign-in requests go.' }),
    startUrl: z.string().meta({ description: 'Opens sign-in with this provider.' }),
  })
  .meta({ id: 'MetaProvider' });

export const metaAnswer = z
  .object({
    product: z.literal('taskmoor'),
    version: z.string().meta({ description: 'The backend’s version.' }),
    api: z.object({
      version: z.string().meta({ description: 'The native API’s version.' }),
      base: z.string().meta({ description: 'Where the native API is, such as `/api/v1`.' }),
    }),
    frontend: z
      .object({
        minimum: z.string().nullable(),
        recommended: z.string().nullable(),
      })
      .meta({
        description:
          'The oldest frontend this backend serves (older ones must update) and the one it was built with (older ones should). Null on a development build, which takes any frontend.',
      }),
    instance: z.object({
      id: z.string(),
      name: z.string(),
      keyAlgorithm: z.literal('Ed25519'),
      publicKey: z.string().meta({ description: 'SPKI DER, base64url.' }),
      keyFingerprint: z
        .string()
        .meta({ description: '`SHA256:` and the key’s digest, base64url.' }),
    }),
    signIn: z.object({
      password: z.boolean(),
      providers: z.array(provider),
    }),
    signature: z
      .object({
        nonce: z.string(),
        value: z.string().meta({
          description:
            'Ed25519 over `taskmoor-meta-v1`, the instance id and the nonce, one per line; base64url.',
        }),
      })
      .optional(),
  })
  .meta({ id: 'Meta' });

export interface MetaRouteOptions {
  version: string;
  publicUrl: string;
  peppers?: PepperRing | undefined;
}

export function registerMetaRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: MetaRouteOptions,
) {
  const base = options.publicUrl.replace(/\/+$/, '');
  const window = frontendWindow(options.version);
  // Loaded once per process; a failure is tried again on the next call.
  let identity: Promise<InstanceIdentity> | null = null;
  const instanceIdentity = () => {
    identity ??= loadIdentity(db, options.peppers).catch((error) => {
      identity = null;
      throw error;
    });
    return identity;
  };

  app.get('/api/meta', async (request, reply) => {
    const query = metaQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const [me, settings, providers] = await Promise.all([
      instanceIdentity(),
      readSetting<{ name?: string }>(db, INSTANCE_KEY),
      db
        .selectFrom('identity_provider')
        .select(['id', 'name', 'kind', 'issuer', 'client_id', 'saml_sso_url'])
        .where('workspace_id', '=', request.workspaceId)
        .where('enabled', '=', true)
        .orderBy(sql`lower(name)`)
        .execute(),
    ]);
    let signature: { nonce: string; value: string } | undefined;
    if (query.data.nonce !== undefined) {
      const value = me.signNonce(query.data.nonce);
      if (value === null) {
        request.log.error('the instance private key cannot be opened with the configured pepper');
        return reply.code(503).send({ error: 'identity_unavailable' });
      }
      signature = { nonce: query.data.nonce, value };
    }
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'no-store');
    return {
      product: 'taskmoor' as const,
      version: options.version,
      api: { version: API_VERSION, base: '/api/v1' },
      frontend: window,
      instance: {
        id: me.id,
        name: settings?.name ?? '',
        keyAlgorithm: 'Ed25519' as const,
        publicKey: me.publicKey,
        keyFingerprint: me.fingerprint,
      },
      signIn: {
        // Password sign-in is always there; a provider may enforce itself on its domains,
        // which POST /api/v1/auth/discover tells per email.
        password: true,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          protocol: p.kind,
          issuer: p.issuer,
          clientId: p.kind === 'oidc' ? p.client_id : null,
          ssoUrl: p.kind === 'saml' ? p.saml_sso_url : null,
          startUrl: `${base}/api/v1/auth/${p.kind}/${p.id}/start`,
        })),
      },
      ...(signature ? { signature } : {}),
    };
  });
}
