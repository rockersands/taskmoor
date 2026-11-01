import { redactSecrets } from '../secrets';
import type { Embedder } from './types';
import { normalize } from './types';

/**
 * An external embedding endpoint (AI-012: "optionally an external embedding endpoint"; ADR-106):
 * any server with the OpenAI-compatible `POST /embeddings` (a local Ollama, vLLM or text
 * embeddings server, or a cloud provider). The texts leave this server, so it is only used when
 * an operator configures it; the bundled model is the default.
 */
export interface EndpointEmbedderOptions {
  /** The API's base URL, such as `http://ollama:11434/v1`. */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token when set; from the environment only. */
  apiKey?: string;
  /** The vectors' length when known ahead; otherwise read from the first answer. */
  dimensions?: number;
  /** Texts per request. */
  batchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EndpointEmbedder implements Embedder {
  readonly model: string;
  private size: number;
  private readonly options: EndpointEmbedderOptions;

  constructor(options: EndpointEmbedderOptions) {
    this.options = options;
    this.model = `endpoint:${options.model}`;
    this.size = options.dimensions ?? 0;
  }

  /** 0 until the first answer when not configured. */
  get dimensions(): number {
    return this.size;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    const batch = this.options.batchSize ?? 64;
    for (let from = 0; from < texts.length; from += batch) {
      out.push(...(await this.request(texts.slice(from, from + batch))));
    }
    return out;
  }

  private async request(input: readonly string[]): Promise<Float32Array[]> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const res = await (this.options.fetch ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.options.model, input }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(
        `the embedding endpoint answered ${res.status}: ${redactSecrets(text, this.options.apiKey ? [this.options.apiKey] : [])}`,
      );
    }
    const body = (await res.json()) as { data?: { index?: number; embedding?: unknown }[] };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== input.length) {
      throw new Error(`the embedding endpoint returned ${data.length} vectors for ${input.length}`);
    }
    return data.map((item) => {
      const values = item.embedding;
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'number')) {
        throw new Error('the embedding endpoint returned a vector that is not a list of numbers');
      }
      if (this.size === 0) this.size = values.length;
      if (values.length !== this.size) {
        throw new Error(
          `the embedding endpoint returned ${values.length} dimensions, not ${this.size}`,
        );
      }
      return normalize(Float32Array.from(values as number[]));
    });
  }

  async close(): Promise<void> {}
}
