import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { assertClaudeRequestPolicy, SERVER_FALLBACK_BETA, TASK_BUDGET_BETA } from '../policy';
import type {
  AdapterRequest,
  AdapterResponse,
  ChatMessage,
  ContentPart,
  StopReason,
  ToolCall,
  Usage,
} from '../types';

export type ClaudeParams = MessageCreateParamsNonStreaming;

export interface ClaudeParamsOptions {
  /** The model ID as the platform spells it (Bedrock adds `anthropic.`). */
  model: string;
  /** Ask the Anthropic API to retry a refusal on its recommended fallback model. */
  serverFallback: boolean;
}

/** Block types that may not be echoed from before a fallback seam (they belong to the declined model). */
const DECLINED_MODEL_BLOCKS = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'server_tool_use',
]);

/**
 * The assistant turn to send back. Thinking blocks go back unchanged, as Claude requires.
 * After a refusal fallback, the declined model's thinking and tool calls before the last
 * `fallback` seam are left out, and the seams themselves (audit markers the API ignores) are
 * dropped.
 */
export function echoableContent(
  content: readonly BetaContentBlockParam[],
): BetaContentBlockParam[] {
  const lastSeam = content.findLastIndex((block) => block.type === 'fallback');
  return content.filter(
    (block, index) =>
      block.type !== 'fallback' && !(index < lastSeam && DECLINED_MODEL_BLOCKS.has(block.type)),
  );
}

function partToBlock(part: ContentPart): BetaContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool-call':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      };
  }
}

export function toClaudeMessages(messages: readonly ChatMessage[]): BetaMessageParam[] {
  return messages.map((message): BetaMessageParam => {
    if (message.role === 'assistant' && message.native?.format === 'claude-messages') {
      const native = message.native.content as BetaContentBlockParam[];
      return { role: 'assistant', content: echoableContent(native) };
    }
    if (typeof message.content === 'string') {
      return { role: message.role, content: message.content };
    }
    return { role: message.role, content: message.content.map(partToBlock) };
  });
}

/**
 * Builds the Messages API body for every Claude platform: stable prefix first (tools sorted by
 * name, then the system instructions and the scope context, each a cache breakpoint), adaptive
 * thinking, an explicit effort, strict structured output or strict tools with automatic tool
 * choice. The result is checked against the request policy before it is returned.
 */
export function buildClaudeParams(
  request: AdapterRequest,
  options: ClaudeParamsOptions,
): ClaudeParams {
  const cache = request.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {};
  const system: BetaTextBlockParam[] = [];
  if (request.system) system.push({ type: 'text', text: request.system, ...cache });
  if (request.context) system.push({ type: 'text', text: request.context, ...cache });

  const tools: BetaTool[] | undefined = request.tools?.length
    ? [...request.tools]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as BetaTool.InputSchema,
          strict: true,
        }))
    : undefined;

  const betas = [
    ...(options.serverFallback ? [SERVER_FALLBACK_BETA] : []),
    ...(request.taskBudget !== undefined ? [TASK_BUDGET_BETA] : []),
  ];
  const params: ClaudeParams = {
    model: options.model,
    max_tokens: request.maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: toClaudeMessages(request.messages),
    thinking: { type: 'adaptive' },
    output_config: {
      effort: request.effort,
      ...(request.jsonSchema
        ? { format: { type: 'json_schema', schema: request.jsonSchema } }
        : {}),
      // An agent run's budget (M1-131): the server counts down from the total itself.
      ...(request.taskBudget !== undefined
        ? { task_budget: { type: 'tokens', total: request.taskBudget } }
        : {}),
    },
    ...(tools ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(betas.length > 0 ? { betas } : {}),
    ...(options.serverFallback ? { fallbacks: 'default' } : {}),
  };
  assertClaudeRequestPolicy(params as unknown as Record<string, unknown>);
  return params;
}

function stopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
    case 'refusal':
      return reason;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'unknown';
  }
}

/**
 * Billed tokens. When a fallback ran, the top-level usage covers only the attempt that
 * answered; the per-attempt `iterations` hold the whole cost.
 */
export function claudeUsage(usage: BetaUsage): Usage {
  const attempts = (usage.iterations ?? []).filter(
    (entry) => entry.type === 'message' || entry.type === 'fallback_message',
  ) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }[];
  if (attempts.length > 1) {
    return attempts.reduce(
      (sum, entry) => ({
        inputTokens: sum.inputTokens + entry.input_tokens,
        outputTokens: sum.outputTokens + entry.output_tokens,
        cacheReadTokens: sum.cacheReadTokens + (entry.cache_read_input_tokens ?? 0),
        cacheWriteTokens: sum.cacheWriteTokens + (entry.cache_creation_input_tokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Reads `stop_reason` before content: a refusal never yields text or tool calls, even partial. */
export function fromClaudeMessage(message: BetaMessage): AdapterResponse {
  const reason = stopReason(message.stop_reason);
  const refused = reason === 'refusal';
  const blocks: readonly BetaContentBlock[] = message.content;
  const text = refused
    ? ''
    : blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
  const toolCalls: ToolCall[] = refused
    ? []
    : blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  const fellBack =
    blocks.some((block) => block.type === 'fallback') ||
    (message.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message');
  const parts: ContentPart[] = [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...toolCalls.map((call) => ({ type: 'tool-call' as const, ...call })),
  ];
  return {
    text,
    toolCalls,
    stopReason: reason,
    refused,
    refusalCategory: refused ? (message.stop_details?.category ?? null) : null,
    model: message.model,
    fellBack,
    usage: claudeUsage(message.usage),
    message: {
      role: 'assistant',
      content: parts,
      native: { format: 'claude-messages', content: message.content },
    },
  };
}
