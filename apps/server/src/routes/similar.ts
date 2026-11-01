import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  DUPLICATE_BUDGET_MS,
  RERANK_TOP,
  type RerankCandidate,
  type Reranked,
  rerank,
} from '../ai/features/duplicates';
import type { AiService } from '../ai/service';
import type { EmbeddingService } from '../embeddings/service';
import type { SimilarHit } from '../embeddings/similar';
import type { FieldCatalogs } from '../fields/catalog';
import { commentReadableSql, commentText } from '../tickets/comments';
import { loadTicket, resolveTicket, resolveTrack } from '../tickets/store';
import { project, searchViews } from './search';

/**
 * Similar tickets (M1-078; AI-012, AI-016; ADR-106): the tickets nearest in meaning to a
 * ticket, or to a text being typed (duplicate suggestions while a ticket is created), from
 * the bundled local model's vectors. They need no AI provider and no key (NFR-011). Results
 * are only tickets the person may see, each with its score; a match through a comment names
 * the comment, never its text, and only a comment the person reads counts.
 */
const MAX_INT = 2_147_483_647;
const ref = z.union([z.number().int().positive().max(MAX_INT), z.string().min(1).max(300)]);

export const similarQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(10).meta({
      description: 'How many tickets, at most 50.',
    }),
    minScore: z.coerce.number().min(-1).max(1).optional().meta({
      description: 'Leave out tickets less similar than this (cosine similarity, -1 to 1).',
    }),
  })
  .strict();

export const similarTextBody = z
  .object({
    text: z.string().trim().min(1).max(10_000).meta({
      description: 'What is being written: a summary, with the description after it if any.',
    }),
    track: ref.optional().meta({
      description: 'Only tickets of this track (its key or id), such as the one being created in.',
    }),
    excludeTicket: ref.optional().meta({
      description: 'A ticket to leave out (its key or id), such as the one being edited.',
    }),
    limit: z.number().int().min(1).max(50).default(10),
    minScore: z.number().min(-1).max(1).optional(),
    reasons: z.boolean().default(false).meta({
      description:
        'Have the configured AI model re-rank the first candidates and give a reason for each, within 2 seconds of the request; without a model, or past the time, the embedding order is answered with `reranked: false`.',
    }),
  })
  .strict();

/** The ticket properties a result shows. */
const SHOWN = {
  keys: new Set(['track', 'ticketType', 'status', 'summary']),
  custom: new Set<string>(),
};

export function registerSimilarRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  embeddings: EmbeddingService | null,
  /** The AI features (M1-079), read at request time; null without AI. */
  ai: () => { service: AiService } | null = () => null,
): void {
  const invalid = (reply: FastifyReply, fields: Record<string, string>) =>
    reply.code(400).send({ error: 'invalid_fields', fields });
  const fieldErrors = (error: z.ZodError) =>
    Object.fromEntries(
      error.issues.map((i) => [i.path.join('.') || 'body', i.message] as const),
    ) as Record<string, string>;

  /** The hits as the person may see them now, best first. */
  async function answer(
    request: FastifyRequest,
    hits: SimilarHit[],
    filter: Awaited<ReturnType<FastifyRequest['authz']['ticketFilter']>>,
    minScore: number | undefined,
  ) {
    const kept = hits.filter((h) => minScore === undefined || h.score >= minScore);
    const views = await searchViews(
      db,
      catalogs,
      request,
      kept.map((h) => h.ticketId),
      filter.sql,
    );
    const byId = new Map(views.map((v) => [v.id, v]));
    return {
      model: embeddings?.model ?? null,
      similar: kept.flatMap((h) => {
        const view = byId.get(h.ticketId);
        if (!view) return [];
        return [
          {
            ticket: project(view, SHOWN),
            score: h.score,
            match: h.match,
            ...(h.commentId !== undefined ? { commentId: h.commentId } : {}),
          },
        ];
      }),
    };
  }

  app.get('/api/v1/tickets/:id/similar', async (request, reply) => {
    const q = similarQuery.safeParse(request.query);
    if (!q.success) return invalid(reply, fieldErrors(q.error));
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, (request.params as { id: string }).id);
    const row = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!row || row.deleted_at !== null || !(await request.authz.seesTicket(row))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!embeddings) return { model: null, similar: [] };
    const vector = await embeddings.ticketVector(ws, row.id);
    if (!vector) return { model: embeddings.model, similar: [] };
    const filter = await request.authz.ticketFilter();
    const hits = await embeddings.similar({
      workspaceId: ws,
      vector,
      tickets: filter.sql,
      comments: commentReadableSql(ws, request.user?.id ?? null),
      exclude: row.id,
      limit: q.data.limit,
    });
    return answer(request, hits, filter, q.data.minScore);
  });

  /**
   * The model's order and reasons for the first answers, or null: no model for the track, the
   * caller's AI switched off there, a refusal, or no answer within the budget.
   */
  async function reranked(
    request: FastifyRequest,
    text: string,
    found: Awaited<ReturnType<typeof answer>>,
    trackId: number | null,
    deadline: number,
  ): Promise<Reranked | null> {
    const service = ai()?.service;
    const top = found.similar.slice(0, RERANK_TOP);
    if (!service || top.length === 0) return null;
    const ws = request.workspaceId;
    const ids = top.map((h) => (h.ticket as { id: number }).id);
    const [policy, rows] = await Promise.all([
      service.settings.policyOf(ws),
      db
        .selectFrom('ticket')
        .select(['id', 'description'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', ids)
        .execute(),
    ]);
    const hideDescription = policy.redactedFields.includes('description');
    const description = new Map(rows.map((r) => [r.id, r.description]));
    const candidates: RerankCandidate[] = top.map((h) => {
      const t = h.ticket as { id: number; key: string; summary?: string };
      const body = description.get(t.id);
      return {
        key: t.key,
        summary: t.summary ?? '',
        excerpt: hideDescription || !body ? '' : commentText(body, 300),
      };
    });
    try {
      return await service.call({ workspaceId: ws, trackId, feature: 'duplicates' }, (gateway) =>
        rerank(gateway, {
          text,
          candidates,
          deadline,
          userId: request.user?.id ?? null,
          trackId,
        }),
      );
    } catch {
      // AI not available here: the embedding order, without reasons (NFR-011).
      return null;
    }
  }

  app.post('/api/v1/tickets/similar', async (request, reply) => {
    const deadline = Date.now() + DUPLICATE_BUDGET_MS - 100;
    const body = similarTextBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, fieldErrors(body.error));
    const ws = request.workspaceId;
    const filter = await request.authz.ticketFilter();
    let trackId: number | undefined;
    if (body.data.track !== undefined) {
      const id = await resolveTrack(db, ws, body.data.track);
      // A track the person sees no tickets in is answered as one that does not exist.
      if (id === null || (filter.tracks !== 'all' && !filter.tracks.includes(id))) {
        return invalid(reply, { track: 'No such track' });
      }
      trackId = id;
    }
    let exclude: number | undefined;
    if (body.data.excludeTicket !== undefined) {
      exclude = (await resolveTicket(db, ws, body.data.excludeTicket))?.id;
    }
    if (!embeddings) return { model: null, similar: [] };
    const vector = await embeddings.embedText(body.data.text);
    const hits = await embeddings.similar({
      workspaceId: ws,
      vector,
      tickets: filter.sql,
      comments: commentReadableSql(ws, request.user?.id ?? null),
      ...(trackId !== undefined ? { trackId } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      limit: body.data.limit,
    });
    const found = await answer(request, hits, filter, body.data.minScore);
    if (!body.data.reasons) return found;
    const ranked = await reranked(request, body.data.text, found, trackId ?? null, deadline);
    if (!ranked) return { ...found, reranked: false };
    const byKey = new Map(found.similar.map((h) => [(h.ticket as { key: string }).key, h]));
    const head = ranked.order.flatMap((key) => {
      const hit = byKey.get(key);
      if (!hit) return [];
      byKey.delete(key);
      const why = ranked.reasons.get(key);
      return [why ? { ...hit, likely: why.likely, reason: why.reason } : hit];
    });
    return { ...found, reranked: true, similar: [...head, ...byKey.values()] };
  });
}
