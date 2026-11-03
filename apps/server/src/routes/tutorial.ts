import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { withEvent } from '../events/bus';

/** The tutorial's sections (ADR-115); the web app's `tutorial/sections.ts` lists the same. */
export const TUTORIAL_SECTIONS = [
  'tracks',
  'workflows',
  'boards',
  'search',
  'dashboards',
  'releases',
  'admin',
  'import',
] as const;

const OFFER = 'offer';

const sectionBody = z
  .object({
    state: z.enum(['active', 'done', 'skipped']),
    step: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const offerBody = z.object({ state: z.enum(['shown', 'dismissed']) }).strict();

/**
 * A person's place in the guided tutorial (ADR-115). `GET /api/v1/account/tutorial` reads it and
 * `PUT /api/v1/account/tutorial/:section` changes one section, or the first-run offer with the
 * section `offer`. Signed-in browsers only, and always the caller's own progress.
 */
export function registerTutorialRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/account/tutorial', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const rows = await db
      .selectFrom('tutorial_progress')
      .select(['section', 'state', 'step', 'updated_at'])
      .where('workspace_id', '=', request.workspaceId)
      .where('user_id', '=', user.id)
      .orderBy('section')
      .execute();
    return {
      offer: rows.find((row) => row.section === OFFER)?.state ?? null,
      sections: rows
        .filter((row) => row.section !== OFFER)
        .map((row) => ({
          section: row.section,
          state: row.state,
          step: row.step,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
    };
  });

  app.put('/api/v1/account/tutorial/:section', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { section } = request.params as { section: string };
    const isOffer = section === OFFER;
    if (!isOffer && !(TUTORIAL_SECTIONS as readonly string[]).includes(section)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const parsed = (isOffer ? offerBody : sectionBody).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { state } = parsed.data;
    const step = 'step' in parsed.data ? (parsed.data.step ?? 0) : 0;
    await withEvent(db, { workspaceId: request.workspaceId, actorId: user.id }, async (trx) => {
      await trx
        .insertInto('tutorial_progress')
        .values({ workspace_id: request.workspaceId, user_id: user.id, section, state, step })
        .onConflict((conflict) =>
          conflict.columns(['workspace_id', 'user_id', 'section']).doUpdateSet({
            state,
            step,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      return {
        result: null,
        event: {
          type: 'tutorial.progress_changed' as const,
          subjectId: user.id,
          payload: { section, state, step },
        },
      };
    });
    return { section, state, step };
  });
}
