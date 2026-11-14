import type { Database } from '@taskmoor/db';
import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, RawBuilder } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { datesBetween, dayEnd, dayStart } from '../reports/flow';
import { createdVsClosed, PERIODS, parseAxis, twoDimensional } from '../reports/general';
import { viewerTimeZone } from '../reports/zone';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { searchRefusal } from './search';

/**
 * General reports over any query (M1-062; RPT-002, RPT-005; ADR-059): created vs closed per
 * period, and two-dimensional statistics over two fields. The tickets are the query's as the
 * viewer sees them (an empty query is every ticket they see; a saved search is `filter = "…"`,
 * a track `track = KEY`), through the search compiler.
 */
const MAX_DAYS = 731;
const DAY = 86_400_000;
const query = z.string().max(10_000).default('');
const localDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().startsWith(d), 'invalid');
const createdQuery = z
  .object({
    query,
    from: localDay.optional(),
    to: localDay.optional(),
    /** Without `from`: this many days up to `to`. */
    days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
    period: z.enum(PERIODS).default('day'),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => knownTimeZone(zone))
      .optional(),
  })
  .strict();
const axis = z.string().regex(/^([a-zA-Z]{1,40}|cf\[\d{1,10}\])$/);
const twoQuery = z.object({ query, x: axis, y: axis }).strict();

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const daysBefore = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

export interface ReportRouteDeps {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

export function registerReportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  deps: ReportRouteDeps,
): void {
  const { catalogs } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  /** The query's tickets as a condition, or null once a refusal is sent. */
  async function compile(
    request: FastifyRequest,
    reply: FastifyReply,
    text: string,
  ): Promise<{ scope: Scope; where: RawBuilder<boolean> } | null> {
    try {
      const scope = await boardScope(db, catalogs, request);
      return { scope, where: await compileQuery(db, scope, text, new Date()) };
    } catch (error) {
      await searchRefusal(reply, error, timeoutMs);
      return null;
    }
  }

  app.get('/api/v1/reports/created-vs-closed', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = createdQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const timeZone = viewerTimeZone(request, q.data.timeZone);
    const now = Date.now();
    const to = q.data.to ?? localDate(new Date(now), timeZone);
    const from = q.data.from ?? daysBefore(to, (q.data.days ?? 30) - 1);
    if (from > to) return invalidFields(reply, { from: 'after_to' });
    if (datesBetween(from, to).length > MAX_DAYS) return invalidFields(reply, { from: 'too_long' });
    const compiled = await compile(request, reply, q.data.query);
    if (!compiled) return reply;
    try {
      const counts = await readOnly(db, timeoutMs, (trx) =>
        createdVsClosed(trx, {
          workspaceId: request.workspaceId,
          scope: compiled.where,
          from,
          to,
          start: new Date(dayStart(from, timeZone)),
          end: new Date(dayEnd(to, timeZone)),
          timeZone,
          period: q.data.period,
        }),
      );
      return { timeZone, from, to, period: q.data.period, ...counts };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.get('/api/v1/reports/two-dimensional', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const q = twoQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const compiled = await compile(request, reply, q.data.query);
    if (!compiled) return reply;
    const x = parseAxis(q.data.x, compiled.scope);
    const y = parseAxis(q.data.y, compiled.scope);
    if (typeof x === 'string' || typeof y === 'string') {
      return invalidFields(reply, {
        ...(typeof x === 'string' ? { x } : {}),
        ...(typeof y === 'string' ? { y } : {}),
      });
    }
    try {
      const table = await readOnly(db, timeoutMs, (trx) =>
        twoDimensional(trx, { workspaceId: request.workspaceId, scope: compiled.where, x, y }),
      );
      return { fields: { x: q.data.x, y: q.data.y }, ...table };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
