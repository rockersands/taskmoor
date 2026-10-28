import { EFFORTS } from './config';
import { AiPolicyError } from './errors';

/** Beta that enables `fallbacks: "default"` on the Anthropic API (server-side refusal fallback). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Models whose refusals the Anthropic API can retry on another model server-side, choosing
 * the substitute by refusal category. Haiku has no server-side fallback.
 */
export const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
]);

const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The last check before a Claude request leaves the process (ADR-028): adaptive thinking,
 * an explicit effort, no thinking budget, no sampling parameters, no forced tool choice and
 * only strict tools. The current models reject the banned shapes with a 400; failing here
 * keeps that from becoming a runtime surprise. Throws `AiPolicyError`.
 */
export function assertClaudeRequestPolicy(params: Record<string, unknown>): void {
  const thinking = params.thinking;
  if (!isRecord(thinking) || thinking.type !== 'adaptive') {
    throw new AiPolicyError('Claude requests use adaptive thinking');
  }
  if ('budget_tokens' in thinking) {
    throw new AiPolicyError('Claude requests never set a thinking budget');
  }
  for (const name of SAMPLING) {
    if (name in params) throw new AiPolicyError(`Claude requests never set ${name}`);
  }
  const output = params.output_config;
  if (
    !isRecord(output) ||
    typeof output.effort !== 'string' ||
    !(EFFORTS as readonly string[]).includes(output.effort)
  ) {
    throw new AiPolicyError('Claude requests always carry an explicit effort');
  }
  const choice = params.tool_choice;
  if (
    choice !== undefined &&
    (!isRecord(choice) || (choice.type !== 'auto' && choice.type !== 'none'))
  ) {
    throw new AiPolicyError('Claude requests never force a tool choice; use automatic choice');
  }
  const tools = params.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new AiPolicyError('tools must be a list');
    for (const tool of tools) {
      if (!isRecord(tool) || tool.strict !== true) {
        throw new AiPolicyError('Claude tools are always strict');
      }
    }
  }
}
