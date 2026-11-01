import { AiGateway, type AiSettings, type ProviderAdapter } from '@taskmoor/ai';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app';
import { sharedLocalEmbedder } from '../../../embeddings/service';
import { DUPLICATE_BUDGET_MS, RERANK_TOP, rerank } from '../../features/duplicates';
import { ticketText } from '../duplicates-eval';
import type { EvalCandidate } from '../runner';
import type { EvalWorld } from '../seed';

/**
 * A candidate made of the product's own AI features (M1-079; ADR-108): an app on the eval
 * database whose AI provider is `adapter`, asked through its routes as each case's person, the
 * way the web app asks. Queries come from `POST /api/v1/ai/query`, summaries from the streamed
 * summary route, duplicates from the bundled embedding model re-ranked by the feature's own
 * prompt within its 2-second budget, and the injection run goes through every feature.
 */
export function featureCandidate(
  name: string,
  makeAdapter: (world: EvalWorld | null) => ProviderAdapter | Promise<ProviderAdapter>,
  options: { features?: AiSettings['features']; judge?: boolean } = {},
): EvalCandidate {
  const apps = new WeakMap<EvalWorld, Promise<{ app: FastifyInstance; gateway: AiGateway }>>();
  const opened: FastifyInstance[] = [];
  const features = options.features ?? {};
  const runtime = (world: EvalWorld) => {
    let hit = apps.get(world);
    if (!hit) {
      hit = (async () => {
        const adapter = await makeAdapter(world);
        const app = await buildApp({
          db: world.db,
          version: 'eval-ai',
          roles: ['api'],
          embedder: null,
          ai: {
            source: async () => ({ adapter, features }),
            // The dataset's fixed "now", so relative dates mean what the references mean.
            now: () => world.now.getTime(),
          },
        });
        opened.push(app);
        return { app, gateway: new AiGateway(adapter, { features }) };
      })();
      apps.set(world, hit);
    }
    return hit;
  };
  // The duplicates corpus is not seeded: its re-ranking needs only a provider, made once.
  let bare: Promise<AiGateway> | undefined;
  const bareGateway = () => {
    bare ??= Promise.resolve(makeAdapter(null)).then(
      (adapter) => new AiGateway(adapter, { features }),
    );
    return bare;
  };
  const embedder = sharedLocalEmbedder();

  return {
    name,
    query: async (c) => {
      const { app } = await runtime(c.world);
      const res = await c.world.asOn(app, c.user.handle, {
        method: 'POST',
        url: '/api/v1/ai/query',
        payload: { text: c.prompt },
      });
      // A refusal or a failure scores as an empty query: it does not parse, so it never runs.
      return res.statusCode === 200 ? String(res.json().query ?? '') : '';
    },
    summary: async (input) => {
      const { app } = await runtime(input.world);
      const res = await input.world.asOn(app, input.user.handle, {
        method: 'POST',
        url: `/api/v1/tickets/${input.ticketId}/ai/summary`,
        payload: {},
      });
      const done = /event: done\ndata: (.*)\n/.exec(res.body)?.[1];
      if (!done) return { text: '', citations: [] };
      const body = JSON.parse(done) as { text: string; citations: { commentId: number }[] };
      return { text: body.text, citations: body.citations.map((c) => c.commentId) };
    },
    embed: async (texts) => (await embedder.embed(texts)).map((v) => Array.from(v)),
    rerank: async (query, candidates) => {
      const head = candidates.slice(0, RERANK_TOP);
      const ranked = await rerank(await bareGateway(), {
        text: ticketText(query),
        candidates: head.map((c) => ({
          key: c.id,
          summary: c.summary,
          excerpt: c.description.slice(0, 300),
        })),
        deadline: Date.now() + DUPLICATE_BUDGET_MS,
        userId: null,
        trackId: null,
      });
      const order = ranked ? ranked.order : head.map((c) => c.id);
      return [...order, ...candidates.slice(RERANK_TOP).map((c) => c.id)];
    },
    ...(options.judge
      ? {
          judge: async (prompt: string) =>
            (
              await (
                await bareGateway()
              ).generate({
                feature: 'summarize',
                system: 'You grade summaries of work tickets carefully and answer with JSON only.',
                messages: [{ role: 'user', content: prompt }],
              })
            ).text,
        }
      : {}),
    featureApp: async (world) => (await runtime(world)).app,
    close: async () => {
      for (const app of opened.splice(0)) await app.close();
      await embedder.close();
    },
  };
}
