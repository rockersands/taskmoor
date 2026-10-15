import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

/**
 * A fake OpenID Connect provider for tests (M1-080): discovery, an authorize endpoint that
 * signs in whoever the test chose, a token endpoint that checks the client secret and PKCE,
 * and user info. RS256 ID tokens with the nonce, audience and issuer a real provider sets.
 */
export interface FakePerson {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name: string;
  groups?: string[];
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
  private server: Server | undefined;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, FakePerson>();
  private keys: { privateKey: SigningKey; jwk: JWK } | undefined;

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
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

  private claims(person: FakePerson, withGroups: boolean) {
    return {
      sub: person.sub,
      email: person.email,
      email_verified: person.emailVerified ?? true,
      name: person.name,
      ...(withGroups && person.groups ? { groups: person.groups } : {}),
    };
  }

  private async handle(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', this.issuer);
    const json = (status: number, body: unknown) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
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
    if (url.pathname === '/jwks') return json(200, { keys: [this.keys?.jwk] });
    if (url.pathname === '/authorize') {
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
      back.searchParams.set('iss', this.issuer);
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
      const idToken = await new SignJWT({
        ...this.claims(grant.person, this.groupsInIdToken),
        ...(grant.nonce ? { nonce: grant.nonce } : {}),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.issuer)
        .setAudience(this.clientId)
        .setSubject(grant.person.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.keys?.privateKey as SigningKey);
      const accessToken = randomBytes(16).toString('base64url');
      this.tokens.set(accessToken, grant.person);
      return json(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }
    if (url.pathname === '/userinfo') {
      const person = this.tokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!person) return json(401, { error: 'invalid_token' });
      return json(200, this.claims(person, true));
    }
    return json(404, { error: 'not_found' });
  }
}
