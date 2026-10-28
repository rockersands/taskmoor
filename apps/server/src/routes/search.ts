import type { Database } from '@taskmoor/db';
import { parseQuery, QueryError, resolveQuery } from '@taskmoor/query';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from '../search/catalogue';

/**
 * Checking a query before running it (M1-036; QRY-001 to QRY-003): parsed, every field found
 * under any of its names (custom fields the person may see, by name or `cf[id]`), every
 * operator checked against the field's type and every value read. The answer says what the
 * query uses, or where and why it is wrong, for the query editor (M1-041). Running queries is
 * M1-037.
 */
const checkQuery = z.object({ q: z.string().max(20_000) }).strict();

export function registerSearchRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
): void {
  app.get('/api/v1/search/check', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = checkQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const browse = await request.authz.allowedTracks('browse_track');
    const catalogue = await queryCatalogue(db, ws, await catalogs.get(ws), browse);
    try {
      const plan = resolveQuery(parseQuery(parsed.data.q), catalogue, {
        currentUserId: user.id,
        now: new Date(),
      });
      const fields = new Map<string, { name: string; custom: number | null }>();
      const visit = (pred: unknown) => {
        if (!pred || typeof pred !== 'object') return;
        const p = pred as {
          field?: { kind: string; name: string; id?: number };
          items?: unknown[];
          pred?: unknown;
        };
        if (p.field) {
          const custom = p.field.kind === 'custom' ? (p.field.id as number) : null;
          fields.set(custom === null ? p.field.name : `cf[${custom}]`, {
            name: p.field.name,
            custom,
          });
        }
        for (const item of p.items ?? []) visit(item);
        visit(p.pred);
      };
      visit(plan.where);
      for (const o of plan.orderBy) visit(o);
      return {
        ok: true,
        fields: [...fields.values()],
        orderBy: plan.orderBy.map((o) => ({ field: o.field.name, direction: o.direction })),
      };
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      return {
        ok: false,
        error: {
          message: error.detail,
          position: error.position,
          length: error.length,
          line: error.line,
          column: error.column,
          expected: error.expected,
        },
      };
    }
  });
}
