import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { countRefusal } from './alerts';

/**
 * Refused requests (ASVS 7.2.2; ADR-109): every 403 answered under `/api/` to a signed-in person
 * or an API token counts towards the `access_refusals` rule of its person or token, which is
 * audited in aggregate (one record at 10 refusals in the window, one more at each tenfold) and
 * alerts the site administrators at the rule's threshold.
 *
 * Counted before the answer leaves (`onSend`), so a test or a client that reads the audit log
 * right after its refusal finds it. Anonymous refusals (an origin the CORS policy refuses, a
 * sign-in that must use single sign-on) are no one's: the request log and the sign-in audit
 * hold those. The Jira-compatible routes run the native ones in-process, which count there.
 */
export function registerRefusalAudit(app: FastifyInstance, db: Kysely<Database>): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode !== 403 || !request.user || !request.url.startsWith('/api/')) {
      return payload;
    }
    try {
      await countRefusal(db, request.workspaceId, {
        userId: request.user.id,
        tokenId: request.apiToken?.id ?? null,
        ip: request.ip,
        method: request.method,
        route: request.routeOptions.url ?? null,
      });
    } catch (error) {
      // Never let the audit of a refusal turn it into a server error.
      request.log.warn({ error }, 'refusal not counted');
    }
    return payload;
  });
}
