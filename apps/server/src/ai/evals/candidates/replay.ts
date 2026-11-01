// pnpm eval all --candidate apps/server/src/ai/evals/candidates/replay.ts
//
// The AI features of M1-079 with a fake provider that replays recorded answers (ADR-108): for a
// query, the corpus's reference for that prompt and person; for a summary, the case's graded
// reference with its comment names turned into the seeded comments' ids; for a re-rank, the
// order it was given; for drafts and breakdowns, a fixed proposal carrying an image from
// another site, which the features must screen out. It calls no model and needs no key. Its
// scores prove the wiring from the route to the provider and back, not the quality of a model:
// that is what `live.ts` measures.
import type {
  AdapterRequest,
  AdapterResponse,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
} from '@taskmoor/ai';
import { FULL_CAPABILITIES } from '@taskmoor/ai/testing';
import { BREAKDOWN_SYSTEM, DRAFTS_SYSTEM } from '../../features/drafts';
import { RERANK_SYSTEM } from '../../features/duplicates';
import { QUERY_SYSTEM } from '../../features/query';
import { SUMMARY_SYSTEM } from '../../features/summary';
import { PEOPLE } from '../dataset';
import { QUERY_PAIRS } from '../query-corpus';
import type { EvalCandidate } from '../runner';
import type { EvalWorld } from '../seed';
import { SUMMARY_CASES } from '../summary-corpus';
import { featureCandidate } from './features';

const PIXEL = '![status](https://pixel.example.test/p.png?d=replay)';

/** The recorded answer to a request, as text. */
export function replayAnswer(world: EvalWorld | null, request: AdapterRequest): string {
  const prompt = request.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  if (request.system === QUERY_SYSTEM) {
    const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt)?.[1] ?? '';
    const asker = /^The person asking: (.+?)(?: <[^>]*>)?\.$/m.exec(prompt)?.[1];
    const handle = PEOPLE.find((p) => p.name === asker)?.handle;
    const pair = QUERY_PAIRS.find((p) => p.prompt === question && p.asUser === handle);
    return JSON.stringify({
      query: pair?.reference ?? '',
      explanation: pair ? 'Replayed from the corpus.' : 'No recorded answer.',
    });
  }
  if (request.system === SUMMARY_SYSTEM.ticket || request.system === SUMMARY_SYSTEM.thread) {
    const key = /^Summarise (?:the comment thread of )?ticket (\S+)\.$/m.exec(prompt)?.[1];
    const seeded = world ? Object.values(world.tickets).find((t) => t.key === key) : undefined;
    const c = seeded ? SUMMARY_CASES.find((x) => x.ticket.name === seeded.spec.name) : undefined;
    const reference = c?.graded.find((g) => g.expected === 'pass');
    if (!seeded || !reference) return `A replayed summary of ${key ?? 'the ticket'}. ${PIXEL}`;
    return reference.text.replace(/\[(c\d+)\]/g, (m, ref: string) => {
      const id = seeded.comments[ref];
      return id === undefined ? m : `[c${id}]`;
    });
  }
  if (request.system === RERANK_SYSTEM) {
    const keys = [...prompt.matchAll(/<ticket key="([^"]+)">/g)].map((m) => m[1] as string);
    return JSON.stringify({
      ranked: keys.map((key) => ({ key, likely: false, reason: `Replayed order. ${PIXEL}` })),
    });
  }
  if (request.system === DRAFTS_SYSTEM) {
    return JSON.stringify({
      drafts: [
        {
          summary: 'A replayed draft',
          description: `Drafted from the pasted text. ${PIXEL}`,
          type: 'Bug',
          priority: 'High',
          labels: [],
        },
      ],
    });
  }
  if (request.system === BREAKDOWN_SYSTEM) {
    return JSON.stringify({
      children: [
        { summary: 'A replayed child', description: `First part. ${PIXEL}`, type: 'Feature' },
        { summary: 'Another replayed child', description: 'Second part.', type: 'Feature' },
      ],
    });
  }
  return 'A replayed answer.';
}

/** A provider that answers every call with `replayAnswer`, streamed a few words at a time. */
export class ReplayAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly secretValues: readonly string[] = [];
  readonly requests: AdapterRequest[] = [];

  constructor(private readonly world: EvalWorld | null) {}

  capabilities(): ModelCapabilities {
    return FULL_CAPABILITIES;
  }

  async generate(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    const text = replayAnswer(this.world, request);
    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      refused: false,
      refusalCategory: null,
      model: request.model,
      fellBack: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { role: 'assistant', content: text },
    };
  }

  async stream(
    request: AdapterRequest,
    options: Parameters<ProviderAdapter['stream']>[1],
  ): Promise<AdapterResponse> {
    const response = await this.generate(request);
    for (const piece of response.text.match(/\S+\s*/g) ?? []) {
      if (options.signal?.aborted) throw new Error('aborted');
      options.onText(piece);
    }
    return response;
  }

  async countTokens(): Promise<number> {
    return 1;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'claude-opus-5-5' }];
  }

  classifyError(error: unknown): ReturnType<ProviderAdapter['classifyError']> {
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

export const candidate: EvalCandidate = featureCandidate(
  'fake provider replaying recorded answers',
  (world) => new ReplayAdapter(world),
);

export default candidate;
