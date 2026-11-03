import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

/**
 * A fake OpenID Connect provider for tests (M1-080): discovery, an authorize endpoint that
 * signs in whoever the test chose, a token endpoint that checks the client secret and PKCE,
 * and user info. RS256 ID tokens with the nonce, audience and issuer a real provider sets.
 *
 * With `shape: 'google'` (IAM-032, ADR-119) it answers as Google's public documents say Google
 * does: its discovery document, its several hosts (`GOOGLE_HOSTS`, which `routedOutbound` leads
 * here without any network), no `iss` on the way back but `scope`, `authuser` and `prompt`, an
 * ID token with `azp`, `at_hash` and `hd`, and no group claim anywhere. This is what the
 * documents say, not a proof of what Google answers: the real test is in
 * `docs/plan/google-signin-tasks.md`.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_HOSTS = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  'www.googleapis.com',
] as const;

export interface FakePerson {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name: string;
  groups?: string[];
  /** Google's hosted domain, for an account of a Google Workspace organization. */
  hd?: string;
}

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface Grant {
  person: FakePerson;
  nonce: string | undefined;
  challenge: string | undefined;
  redirectUri: string;
}

export class FakeIdp {
  issuer = '';
  person: FakePerson | null = null;
  /** Put the groups in the ID token (true) or only in user info (false). */
  groupsInIdToken = true;
  /** The query of every authorization request, as the browser brought it. */
  readonly authorizations: URLSearchParams[] = [];
  /** How many times user info was asked. */
  userInfoCalls = 0;
  private server: Server | undefined;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, FakePerson>();
  private keys: { privateKey: SigningKey; jwk: JWK } | undefined;

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
    readonly shape: 'plain' | 'google' = 'plain',
  ) {}

  /** Listens on loopback; port 0 picks a free one, the end-to-end suite names its own. */
  async start(port = 0): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.keys = {
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' },
    };
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
        (error) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(error));
        },
      );
    });
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    const listening = typeof address === 'object' && address ? address.port : 0;
    this.issuer = `http://127.0.0.1:${listening}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The issuer the provider says it is: Google's own name, or this server's address. */
  get publicIssuer(): string {
    return this.shape === 'google' ? GOOGLE_ISSUER : this.issuer;
  }

  private googleDiscovery() {
    return {
      issuer: GOOGLE_ISSUER,
      authorization_endpoint: `${GOOGLE_ISSUER}/o/oauth2/v2/auth`,
      device_authorization_endpoint: 'https://oauth2.googleapis.com/device/code',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      response_types_supported: [
        'code',
        'token',
        'id_token',
        'code token',
        'code id_token',
        'token id_token',
        'code token id_token',
        'none',
      ],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      claims_supported: [
        'aud',
        'email',
        'email_verified',
        'exp',
        'family_name',
        'given_name',
        'iat',
        'iss',
        'name',
        'picture',
        'sub',
      ],
      code_challenge_methods_supported: ['plain', 'S256'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      ],
    };
  }

  private claims(person: FakePerson, withGroups: boolean) {
    return {
      sub: person.sub,
      email: person.email,
      email_verified: person.emailVerified ?? true,
      name: person.name,
      ...(withGroups && person.groups && this.shape !== 'google' ? { groups: person.groups } : {}),
      ...(this.shape === 'google'
        ? {
            given_name: person.name.split(' ')[0],
            family_name: person.name.split(' ').slice(1).join(' '),
            picture: 'https://example.com/a-picture',
            ...(person.hd ? { hd: person.hd } : {}),
          }
        : {}),
    };
  }

  private async handle(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', this.issuer);
    const json = (status: number, body: unknown) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const google = this.shape === 'google';
    if (url.pathname === '/.well-known/openid-configuration' && google) {
      return json(200, this.googleDiscovery());
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (url.pathname === (google ? '/oauth2/v3/certs' : '/jwks')) {
      return json(200, { keys: [this.keys?.jwk] });
    }
    if (url.pathname === (google ? '/o/oauth2/v2/auth' : '/authorize')) {
      this.authorizations.push(new URLSearchParams(url.searchParams));
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const back = new URL(redirectUri);
      if (url.searchParams.get('client_id') !== this.clientId || !this.person) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = randomBytes(16).toString('base64url');
        this.grants.set(code, {
          person: this.person,
          nonce: url.searchParams.get('nonce') ?? undefined,
          challenge: url.searchParams.get('code_challenge') ?? undefined,
          redirectUri,
        });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (google) {
        back.searchParams.set('scope', url.searchParams.get('scope') ?? '');
        back.searchParams.set('authuser', '0');
        back.searchParams.set('prompt', 'consent');
        if (this.person?.hd) back.searchParams.set('hd', this.person.hd);
      } else {
        back.searchParams.set('iss', this.issuer);
      }
      return { status: 302, headers: { location: back.toString() }, body: '' };
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const raw = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => resolve(data));
      });
      const form = new URLSearchParams(raw);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64')
            .toString()
            .split(':')
            .map(decodeURIComponent)
        : [form.get('client_id'), form.get('client_secret')];
      if (basic[0] !== this.clientId || basic[1] !== this.clientSecret) {
        return json(401, { error: 'invalid_client' });
      }
      const grant = this.grants.get(form.get('code') ?? '');
      this.grants.delete(form.get('code') ?? '');
      if (!grant || grant.redirectUri !== form.get('redirect_uri'))
        return json(400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (grant.challenge !== challenge)
        return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const accessToken = randomBytes(16).toString('base64url');
      const atHash = createHash('sha256')
        .update(accessToken)
        .digest()
        .subarray(0, 16)
        .toString('base64url');
      const idToken = await new SignJWT({
        ...this.claims(grant.person, this.groupsInIdToken),
        ...(grant.nonce ? { nonce: grant.nonce } : {}),
        ...(google ? { azp: this.clientId, at_hash: atHash } : {}),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.publicIssuer)
        .setAudience(this.clientId)
        .setSubject(grant.person.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.keys?.privateKey as SigningKey);
      this.tokens.set(accessToken, grant.person);
      return json(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        ...(google ? { scope: 'openid email profile' } : {}),
        id_token: idToken,
      });
    }
    if (url.pathname === (google ? '/v1/userinfo' : '/userinfo')) {
      this.userInfoCalls++;
      const person = this.tokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!person) return json(401, { error: 'invalid_token' });
      return json(200, this.claims(person, true));
    }
    return json(404, { error: 'not_found' });
  }
}
