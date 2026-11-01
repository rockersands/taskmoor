import { PassThrough } from 'node:stream';
import { AiAbortedError, screenAnswer } from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AiContext } from '../ai/context';
import {
  BREAKDOWN_SYSTEM,
  breakdownAnswer,
  breakdownMessages,
  choose,
  DRAFTS_SYSTEM,
  draftMessages,
  draftsAnswer,
  type TrackChoices,
} from '../ai/features/drafts';
import {
  QUERY_SYSTEM,
  type QueryAnswer,
  queryAnswer,
  queryMessages,
  repairMessages,
} from '../ai/features/query';
import {
  citationsOf,
  SUMMARY_SYSTEM,
  type SummaryMaterials,
  summaryMessages,
  withinBudget,
} from '../ai/features/summary';
import { queryVocabulary } from '../ai/features/vocabulary';
import { type AiService, aiErrorBody } from '../ai/service';
import { requireUser } from '../auth';
import type { FieldCatalogs } from '../fields/catalog';
import { SearchError } from '../search/bind';
import { prepareSearch } from '../search/run';
import { setMembers } from '../tickets/configuration';
import { parentLevelAllowed } from '../tickets/hierarchy';
import { loadTicket, resolveTicket, resolveTrack, type TicketRow } from '../tickets/store';
import { searchPerson, searchScope } from './search';

/**
 * The AI features of v1 (M1-079; AI-013 to AI-016, NFR-011, NFR-012; ADR-108). Each runs on
 * explicit request, through `AiService.call` (refused when AI is off for the workspace, the
 * track or the feature, or not set up), as the person asking: what goes into a prompt is what
 * they may read, fenced as data, and every answer is screened before it is shown. None of them
 * changes anything: drafts and breakdowns are proposals the person confirms in the app, which
 * then creates tickets through the ticket routes.
 *
 * - `POST /api/v1/tickets/:id/ai/summary`: a summary of the ticket (`scope: ticket`) or of its
 *   comment thread (`thread`), streamed as server-sent events (`text`, then `done` with the
 *   comments cited, or `refused` or `error`); closing the request cancels the provider's call.
 * - `POST /api/v1/ai/query`: a question in any language turned into a query and an explanation,
 *   parsed and resolved as the person but not run; a query that fails says why.
 * - `POST /api/v1/ai/drafts`: tickets drafted from pasted text, for a track.
 * - `POST /api/v1/tickets/:id/ai/breakdown`: children proposed for a ticket, of the types that
 *   may sit under it.
 *
 * Duplicate suggestions at create time are `POST /api/v1/tickets/similar` with `reasons: true`
 * (`routes/similar.ts`): embeddings always, a model's re-ranking when one is set up.
 */
export interface AiFeatureRouteOptions {
  ai: { service: AiService; context: AiContext };
  catalogs: FieldCatalogs;
  /** The instance's own address and the frontends allowed to call it: links there are safe. */
  publicUrl: string;
  origins: readonly string[];
  /** The clock a query's "now" reads (tests and evals pass a fixed one). */
  now?: () => number;
}

const MAX_INT = 2_147_483_647;
const ref = z.union([z.number().int().positive().max(MAX_INT), z.string().min(1).max(300)]);

export const summaryBody = z
  .object({
    scope: z.enum(['ticket', 'thread']).default('ticket').meta({
      description: 'The whole ticket (`ticket`), or only its comment thread (`thread`).',
    }),
  })
  .strict();

export const queryFromTextBody = z
  .object({
    text: z.string().trim().min(1).max(2000).meta({
      description: 'The question, in any language, such as "my open bugs updated this week".',
    }),
  })
  .strict();

export const draftsBody = z
  .object({
    text: z.string().trim().min(1).max(20_000).meta({
      description: 'Pasted text to draft tickets from: notes, an email, a bug report.',
    }),
    track: ref.meta({ description: 'The track the tickets would be created in (key or id).' }),
  })
  .strict();

export const breakdownBody = z
  .object({
    guidance: z.string().trim().max(2000).optional().meta({
      description: 'What the person wants from the breakdown, such as "by platform".',
    }),
  })
  .strict();

const idParams = z.object({ id: z.string().min(1).max(300) });

export function registerAiFeatureRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: AiFeatureRouteOptions,
): void {
  const { ai } = options;
  const allowedOrigins = [...new Set([new URL(options.publicUrl).origin, ...options.origins])];
  const screen = (text: string) => screenAnswer(text, { allowedOrigins, base: options.publicUrl });
  const now = () => new Date(options.now?.() ?? Date.now());

  const invalid = (reply: FastifyReply, error: z.ZodError) =>
    reply.code(400).send({
      error: 'invalid_fields',
      fields: Object.fromEntries(
        error.issues.map((i) => [i.path.join('.') || 'body', i.message] as const),
      ),
    });
  const refuse = (reply: FastifyReply, error: unknown) => {
    const answer = aiErrorBody(error);
    return reply.code(answer.status).send(answer.body);
  };

  /** The ticket of `:id` as the caller sees it, or null (answered 404). */
  async function visibleTicket(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<TicketRow | null> {
    const params = idParams.safeParse(request.params);
    const found = params.success
      ? await resolveTicket(db, request.workspaceId, params.data.id)
      : null;
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at !== null || !(await request.authz.seesTicket(row))) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return row;
  }

  // ---------------------------------------------------------------------------------------
  // Summaries (AI-013)

  app.post('/api/v1/tickets/:id/ai/summary', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = summaryBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const row = await visibleTicket(request, reply);
    if (!row) return reply;
    const ticket = await ai.context.ticket(request, row.id);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    const scope = body.data.scope;
    const [comments, changes] = await Promise.all([
      ai.context.comments(request, row),
      scope === 'ticket' ? ai.context.changes(request, row) : Promise.resolve([]),
    ]);
    const kept = withinBudget(comments);
    const materials: SummaryMaterials = {
      ticketKey: ticket.key,
      ticketText: ticket.text,
      comments: kept.comments,
      changes,
      omitted: kept.omitted,
      sensitive: ticket.sensitive,
    };
    const cited = new Set(kept.comments.map((c) => c.id));
    const authors = new Map(kept.comments.map((c) => [c.id, c.author]));
    try {
      await ai.service.call(
        { workspaceId: request.workspaceId, trackId: row.track_id, feature: 'summarize' },
        async (gateway) => {
          const stream = gateway.stream({
            feature: 'summarize',
            system: SUMMARY_SYSTEM[scope],
            messages: summaryMessages(scope, materials),
            tag: { userId: user.id, trackId: row.track_id },
            sensitive: materials.sensitive,
          });
          const events = stream[Symbol.asyncIterator]();
          // Nothing is sent until the call is under way: a refusal before it (a spend limit,
          // the provider down) is answered as an error with its status.
          const first = await events.next();
          const out = new PassThrough();
          const write = (event: string, data: unknown) =>
            out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          reply
            .header('content-type', 'text/event-stream; charset=utf-8')
            .header('cache-control', 'no-store')
            .header('x-accel-buffering', 'no');
          void reply.send(out);
          // The person cancelled or left: stop the provider generating (and billing) the rest.
          reply.raw.on('close', () => {
            if (!reply.raw.writableFinished) stream.abort();
          });
          try {
            let next = first;
            while (!next.done) {
              const event = next.value;
              if (event.type === 'text') write('text', { text: event.text });
              else write('refused', {});
              next = await events.next();
            }
            const result = await stream.result;
            if (result.refused) {
              write('refused', {});
            } else {
              const screened = screen(result.text);
              const { text, citations } = citationsOf(screened.text, cited);
              write('done', {
                text,
                citations: citations.map((id) => ({ commentId: id, author: authors.get(id) })),
                comments: kept.comments.length,
                omitted: kept.omitted,
                externalLinks: screened.externalLinks,
                removedImages: screened.removedImages.length,
              });
            }
          } catch (error) {
            if (!(error instanceof AiAbortedError)) {
              write('error', aiErrorBodySafe(error));
            }
          } finally {
            out.end();
          }
        },
      );
    } catch (error) {
      if (reply.sent) return reply;
      return refuse(reply, error);
    }
    return reply;
  });

  // ---------------------------------------------------------------------------------------
  // Natural language to query (AI-014)

  app.post('/api/v1/ai/query', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = queryFromTextBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const { ws, filter, catalog, catalogue } = await searchScope(
      db,
      options.catalogs,
      request,
      false,
    );
    const person = searchPerson(request);
    const at = now();
    const vocabulary = await queryVocabulary(db, ws, filter.tracks, catalogue);
    const messages = queryMessages({
      prompt: body.data.text,
      user: { name: user.name, email: user.email },
      now: at.toISOString(),
      timeZone: person.timeZone ?? 'UTC',
      weekStart: 'sunday',
      vocabulary,
    });
    /** Parses and resolves the query as the person; null when it would run, else why not. */
    const check = async (q: string): Promise<{ stage: string; message: string } | null> => {
      if (q.trim() === '') return { stage: 'parse', message: 'The query is empty' };
      try {
        await prepareSearch({
          db,
          workspaceId: ws,
          catalog,
          catalogue,
          filter,
          q,
          currentUserId: person.currentUserId,
          sessionId: person.sessionId,
          now: at,
          timeZone: person.timeZone,
          allowedTracks: person.allowedTracks,
        });
        return null;
      } catch (error) {
        if (error instanceof QueryError) {
          return { stage: 'parse', message: error.detail ?? error.message };
        }
        if (error instanceof SearchError) return { stage: 'resolve', message: error.message };
        throw error;
      }
    };
    try {
      return await ai.service.call(
        { workspaceId: ws, trackId: null, feature: 'query-from-text' },
        async (gateway) => {
          const ask = async (turns: typeof messages): Promise<QueryAnswer> => {
            const result = await gateway.generate({
              feature: 'query-from-text',
              system: QUERY_SYSTEM,
              messages: turns,
              schema: queryAnswer,
              tag: { userId: user.id, trackId: null },
            });
            if (result.refused || !result.parsed) throw new RefusedAnswer();
            return result.parsed;
          };
          let answer = await ask(messages);
          let problem = await check(answer.query);
          let repaired = false;
          if (problem) {
            // One repair attempt with the parser's own words (AI-007 (2)).
            const second = await ask(repairMessages(messages, answer, problem.message));
            const again = await check(second.query);
            if (!again) {
              answer = second;
              problem = null;
              repaired = true;
            }
          }
          return {
            query: answer.query,
            explanation: screen(answer.explanation).text,
            valid: problem === null,
            repaired,
            ...(problem ? { problem } : {}),
          };
        },
      );
    } catch (error) {
      if (error instanceof RefusedAnswer) return reply.code(422).send({ error: 'ai_refused' });
      return refuse(reply, error);
    }
  });

  // ---------------------------------------------------------------------------------------
  // Assisted creation and breakdown (AI-015)

  async function trackChoices(
    workspaceId: number,
    track: { id: number; key: string; name: string; type_set_id: number | null },
  ): Promise<TrackChoices & { levels: Map<number, number> }> {
    const members =
      track.type_set_id === null
        ? []
        : ((await setMembers(db, workspaceId, [track.type_set_id])).get(track.type_set_id) ?? []);
    const [priorities, labels] = await Promise.all([
      db
        .selectFrom('priority')
        .select(['id', 'name'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('sort_order')
        .execute(),
      db
        .selectFrom('label')
        .select('name')
        .where('workspace_id', '=', workspaceId)
        .orderBy('name')
        .limit(200)
        .execute(),
    ]);
    return {
      trackKey: track.key,
      trackName: track.name,
      types: members.map((m) => ({ id: m.id, name: m.name })),
      levels: new Map(members.map((m) => [m.id, m.level_rank])),
      priorities,
      labels: labels.map((l) => l.name),
    };
  }

  const trackRow = (workspaceId: number, id: number) =>
    db
      .selectFrom('track')
      .select(['id', 'key', 'name', 'type_set_id'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

  app.post('/api/v1/ai/drafts', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = draftsBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const ws = request.workspaceId;
    const filter = await request.authz.ticketFilter();
    const trackId = await resolveTrack(db, ws, body.data.track);
    const track = trackId === null ? undefined : await trackRow(ws, trackId);
    if (!track || (filter.tracks !== 'all' && !filter.tracks.includes(track.id))) {
      return reply.code(400).send({ error: 'invalid_fields', fields: { track: 'No such track' } });
    }
    const choices = await trackChoices(ws, track);
    try {
      return await ai.service.call(
        { workspaceId: ws, trackId: track.id, feature: 'assisted-creation' },
        async (gateway) => {
          const result = await gateway.generate({
            feature: 'assisted-creation',
            system: DRAFTS_SYSTEM,
            messages: draftMessages(body.data.text, choices),
            schema: draftsAnswer,
            tag: { userId: user.id, trackId: track.id },
          });
          if (result.refused || !result.parsed) throw new RefusedAnswer();
          const known = new Set(choices.labels.map((l) => l.toLowerCase()));
          return {
            track: { id: track.id, key: track.key },
            drafts: result.parsed.drafts
              .filter((d) => d.summary.trim() !== '')
              .map((d) => ({
                summary: d.summary.trim().slice(0, 255),
                description: screen(d.description).text,
                ticketType: choose(choices.types, d.type),
                priority: choose(choices.priorities, d.priority),
                labels: d.labels.filter((l) => known.has(l.toLowerCase())),
              })),
          };
        },
      );
    } catch (error) {
      if (error instanceof RefusedAnswer) return reply.code(422).send({ error: 'ai_refused' });
      return refuse(reply, error);
    }
  });

  app.post('/api/v1/tickets/:id/ai/breakdown', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = breakdownBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const row = await visibleTicket(request, reply);
    if (!row) return reply;
    const ws = request.workspaceId;
    const ticket = await ai.context.ticket(request, row.id);
    const track = await trackRow(ws, row.track_id);
    if (!ticket || !track) return reply.code(404).send({ error: 'not_found' });
    const choices = await trackChoices(ws, track);
    const parentRank = choices.levels.get(row.ticket_type_id);
    const parentLevel =
      parentRank ??
      (
        await db
          .selectFrom('ticket_type as t')
          .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
          .select('l.rank')
          .where('t.id', '=', row.ticket_type_id)
          .executeTakeFirst()
      )?.rank;
    const childTypes =
      parentLevel === undefined
        ? []
        : choices.types.filter((t) =>
            parentLevelAllowed(choices.levels.get(t.id) ?? -99, parentLevel),
          );
    if (childTypes.length === 0) {
      return reply.code(409).send({ error: 'no_child_types' });
    }
    // Existing children the person sees, so the proposals do not repeat them.
    const children = await db
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .select(['k.id', 'k.summary', 'k.number', 't.key'])
      .where('k.workspace_id', '=', ws)
      .where('k.parent_id', '=', row.id)
      .where('k.deleted_at', 'is', null)
      .orderBy('k.id')
      .limit(100)
      .execute();
    const visible = await request.authz.visibleTickets(children.map((c) => c.id));
    const existing = children
      .filter((c) => visible.has(c.id))
      .map((c) => ({ key: `${c.key}-${c.number}`, summary: c.summary }));
    try {
      return await ai.service.call(
        { workspaceId: ws, trackId: row.track_id, feature: 'assisted-creation' },
        async (gateway) => {
          const result = await gateway.generate({
            feature: 'assisted-creation',
            system: BREAKDOWN_SYSTEM,
            messages: breakdownMessages(ticket.text, existing, childTypes, body.data.guidance),
            schema: breakdownAnswer,
            tag: { userId: user.id, trackId: row.track_id },
            sensitive: ticket.sensitive,
          });
          if (result.refused || !result.parsed) throw new RefusedAnswer();
          const fallback = childTypes[0] as { id: number; name: string };
          return {
            parent: { id: row.id, key: ticket.key },
            track: { id: track.id, key: track.key },
            childTypes,
            children: result.parsed.children
              .filter((c) => c.summary.trim() !== '')
              .map((c) => ({
                summary: c.summary.trim().slice(0, 255),
                description: screen(c.description).text,
                ticketType: choose(childTypes, c.type) ?? fallback,
              })),
          };
        },
      );
    } catch (error) {
      if (error instanceof RefusedAnswer) return reply.code(422).send({ error: 'ai_refused' });
      return refuse(reply, error);
    }
  });
}

/** The model declined, or gave no usable answer: never shown as partial content (AI-009 (2)). */
class RefusedAnswer extends Error {}

function aiErrorBodySafe(error: unknown): Record<string, unknown> {
  try {
    return aiErrorBody(error).body;
  } catch {
    return { error: 'ai_failed' };
  }
}
