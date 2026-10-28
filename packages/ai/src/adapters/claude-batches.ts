import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessageBatch } from '@anthropic-ai/sdk/resources/messages/batches';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  AdapterRequest,
  BatchAdapter,
  BatchInfo,
  BatchItemOutcome,
  CallOptions,
} from '../types';
import { type ClaudeParams, fromClaudeMessage } from './claude-request';

function toBatchInfo(batch: MessageBatch): BatchInfo {
  return {
    id: batch.id,
    status: batch.processing_status,
    counts: {
      processing: batch.request_counts.processing,
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
    },
    createdAt: batch.created_at,
    endedAt: batch.ended_at,
  };
}

function requestOptions(options: CallOptions | undefined) {
  return options?.signal ? { signal: options.signal } : {};
}

/**
 * Message Batches on the Anthropic API: half price, results within 24 hours, matched by the
 * caller's ID (never by position). Batch requests get the same policy-checked body as
 * interactive ones, minus the server-side fallback the Batches API rejects.
 */
export class ClaudeBatches implements BatchAdapter {
  constructor(
    private readonly client: Anthropic,
    private readonly params: (request: AdapterRequest) => ClaudeParams,
  ) {}

  async submit(
    items: { id: string; request: AdapterRequest }[],
    options?: CallOptions,
  ): Promise<BatchInfo> {
    const batch = await this.client.messages.batches.create(
      {
        requests: items.map((item) => ({
          custom_id: item.id,
          params: this.params(item.request) as unknown as MessageCreateParamsNonStreaming,
        })),
      },
      requestOptions(options),
    );
    return toBatchInfo(batch);
  }

  async retrieve(batchId: string, options?: CallOptions): Promise<BatchInfo> {
    return toBatchInfo(
      await this.client.messages.batches.retrieve(batchId, {}, requestOptions(options)),
    );
  }

  async cancel(batchId: string, options?: CallOptions): Promise<BatchInfo> {
    return toBatchInfo(
      await this.client.messages.batches.cancel(batchId, {}, requestOptions(options)),
    );
  }

  async *results(batchId: string, options?: CallOptions): AsyncIterable<BatchItemOutcome> {
    const results = await this.client.messages.batches.results(
      batchId,
      {},
      requestOptions(options),
    );
    for await (const entry of results) {
      const id = entry.custom_id;
      switch (entry.result.type) {
        case 'succeeded':
          yield {
            id,
            ok: true,
            response: fromClaudeMessage(entry.result.message as unknown as BetaMessage),
          };
          break;
        case 'errored':
          yield {
            id,
            ok: false,
            error: { type: 'errored', message: entry.result.error.error.message },
          };
          break;
        case 'canceled':
          yield { id, ok: false, error: { type: 'canceled', message: 'The batch was cancelled' } };
          break;
        case 'expired':
          yield { id, ok: false, error: { type: 'expired', message: 'The batch expired' } };
          break;
      }
    }
  }
}
