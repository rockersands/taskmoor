// Fakes for contract tests: nothing here talks to a network.

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** The JSON body, or the raw string when it is not JSON. */
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  json: unknown;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [name, value] of entries) out[name.toLowerCase()] = String(value);
  return out;
}

/** A fetch that records every request and answers with what `respond` returns. */
export function fakeFetch(
  respond: (call: RecordedCall) => FakeResponse | Promise<FakeResponse>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown = raw;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body,
    };
    calls.push(call);
    const reply = await respond(call);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

/** A successful Messages API reply in the shape the SDK expects. */
export function claudeMessage(
  options: {
    text?: string;
    model?: string;
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } = {},
): FakeResponse {
  return {
    json: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: options.model ?? 'claude-opus-5-5',
      content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
      stop_reason: options.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: options.inputTokens ?? 100,
        output_tokens: options.outputTokens ?? 20,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: options.cacheWrite ?? 0,
      },
    },
  };
}

/** A successful OpenAI-style chat completion reply. */
export function chatCompletion(
  options: {
    content?: string;
    model?: string;
    finishReason?: string;
    promptTokens?: number;
    completionTokens?: number;
  } = {},
): FakeResponse {
  return {
    json: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: options.model ?? 'local-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: options.content ?? '' },
          finish_reason: options.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: options.promptTokens ?? 50,
        completion_tokens: options.completionTokens ?? 10,
      },
    },
  };
}
