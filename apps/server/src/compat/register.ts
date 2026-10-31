import {
  COMPAT_ROUTES,
  type Native,
  ShimError,
  type ShimReply,
  type Version,
} from '@taskmoor/api-jira-compat';
import { type PmJson, toAdfFromJson, toWiki } from '@taskmoor/richtext';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Serves the Jira-compatible API (M1-069; API-002, API-003, API-004; ADR-016, ADR-086). Each
 * route of `@taskmoor/api-jira-compat` is registered under `/rest/api/2` and `/rest/api/3` (or
 * its own path), and its native calls run in-process with the caller's credentials:
 *
 * - `Authorization: Bearer <API token>`, or `Basic` with the email address and an API token as
 *   the password, as scripts send it. The email must be the token owner's. A password is never
 *   taken here: it would get past second factors.
 * - Cookies are not read, so a page on another site cannot make the browser call these routes
 *   as its person; the native routes' origin rules never see these calls either.
 *
 * Refusals are Jira-compatible errors (`errorMessages`, `errors`). A body with a JSON content
 * type may be empty, as scripts send for votes and transitions.
 */
export interface CompatOptions {
  publicUrl: string;
}

const AUTH_ERROR = {
  errorMessages: [
    'Sign in with an API token: Bearer, or Basic with your email address and the token.',
  ],
  errors: {},
};

type Credentials = { authorization: string; email: string | null } | null;

function credentials(request: FastifyRequest): Credentials {
  const header = request.headers.authorization ?? '';
  const bearer = /^Bearer[ \t]+(\S+)\s*$/i.exec(header);
  if (bearer) return { authorization: `Bearer ${bearer[1]}`, email: null };
  const basic = /^Basic[ \t]+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  if (at < 1) return null;
  const email = decoded.slice(0, at);
  const token = decoded.slice(at + 1);
  // Only API tokens: a password would get past second factors and sign-in throttling.
  if (!/^tm[ka]_\S+$/.test(token)) return null;
  return { authorization: `Bearer ${token}`, email };
}

export async function registerJiraCompat(app: FastifyInstance, options: CompatOptions) {
  const baseUrl = options.publicUrl.replace(/\/+$/, '');
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 },
      (_request, body, done) => {
        const text = String(body);
        if (text.trim() === '') return done(null, undefined);
        try {
          done(null, JSON.parse(text));
        } catch {
          const err = new Error('The body is not valid JSON') as Error & { statusCode: number };
          err.statusCode = 400;
          done(err, undefined);
        }
      },
    );

    for (const route of COMPAT_ROUTES) {
      const versions: Version[] = route.path.includes(':v') ? ['2', '3'] : ['2'];
      for (const version of versions) {
        scope.route({
          method: route.method,
          url: route.path.replace(':v', version),
          handler: async (request, reply) => {
            reply.header('cache-control', 'no-store');
            const creds = credentials(request);
            if (!creds) {
              return reply
                .code(401)
                .header('www-authenticate', 'Basic realm="taskmoor", Bearer realm="taskmoor"')
                .send(AUTH_ERROR);
            }
            const native: Native = async (method, path, body) => {
              const res = await app.inject({
                method,
                url: path,
                headers: {
                  authorization: creds.authorization,
                  ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                  ...(request.headers['user-agent']
                    ? { 'user-agent': String(request.headers['user-agent']) }
                    : {}),
                },
                remoteAddress: request.ip,
                ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
              });
              let parsed: unknown = null;
              try {
                parsed = res.body ? JSON.parse(res.body) : null;
              } catch {
                parsed = res.body;
              }
              return { status: res.statusCode, body: parsed };
            };
            let answer: ShimReply;
            try {
              if (creds.email !== null) {
                // Basic: the email must be the token owner's.
                const me = await native('GET', '/api/v1/session');
                const email = String(me.body?.user?.email ?? '');
                if (me.status !== 200 || email.toLowerCase() !== creds.email.toLowerCase()) {
                  return reply.code(401).send(AUTH_ERROR);
                }
              }
              answer = await route.handle({
                version,
                params: (request.params ?? {}) as Record<string, string>,
                query: (request.query ?? {}) as Record<string, string | undefined>,
                body: request.body,
                native,
                baseUrl,
                richText: (doc) =>
                  version === '3' ? toAdfFromJson(doc as PmJson) : toWiki(doc as PmJson),
              });
            } catch (error) {
              if (error instanceof ShimError) answer = error.reply;
              else {
                request.log.error({ err: error }, 'compatible API route failed');
                answer = {
                  status: 500,
                  body: { errorMessages: ['The server could not do this.'], errors: {} },
                };
              }
            }
            reply.code(answer.status);
            return answer.body === undefined ? reply.send() : reply.send(answer.body);
          },
        });
      }
    }
  });
}
