// A provider on a local port for server tests and the end-to-end suite: it answers like the
// Anthropic API from the recorded fixtures, so "test connection" lists the fixture models with
// no network and no real key.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./adapters/__fixtures__/anthropic/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as { exchanges: { response: { status?: number; body?: unknown } }[] };

/** The fixtures' answers: the model list and a short summary. */
const MODELS = fixture('models').exchanges[0]?.response.body;
const SUMMARY = fixture('summary').exchanges[0]?.response.body;

/** A `POST /v1/messages` as an `answer` function sees it (M1-079). */
export interface FakeMessagesRequest {
  /** The system blocks' text, joined by blank lines. */
  system: string;
  /** Every user turn's text, joined by blank lines. */
  prompt: string;
  /** Asked for as server-sent events. */
  stream: boolean;
  /** The JSON schema of a structured answer, when one was asked for. */
  schema: unknown;
  body: Record<string, unknown>;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: string; text?: unknown; content?: unknown };
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'tool_result') return textOf(p.content);
      return '';
    })
    .join('\n');
};

/**
 * Accepts the keys it is told to (`x-api-key`), answers `GET /v1/models` with the recorded model
 * list, `POST /v1/messages` with the recorded summary and `POST /v1/messages/count_tokens` with
 * an estimate from the body's length (an agent run counts before each step, T-333). Any other key
 * gets the API's authentication error, whose message quotes the key it was sent, as some
 * providers do, so tests can show that the message reaches the administrator scrubbed.
 *
 * For the AI features (M1-079), `answer` may write the answer's text for a request (a scripted
 * model); it is sent as a message, or as server-sent events in small pieces `chunkDelayMs`
 * apart when the request asked for a stream, so a page sees the text arrive and can cancel.
 */
export class FakeProviderServer {
  readonly accepted = new Set<string>();
  /** Paths requested, in order, with whether the key was accepted. */
  readonly requests: { method: string; path: string; accepted: boolean }[] = [];
  /** The text to answer a message request with; the recorded summary when it gives none. */
  answer: ((request: FakeMessagesRequest) => string | undefined) | undefined;
  /** Pause between streamed pieces. */
  chunkDelayMs = 40;
  /** Streams cut short because the client went away (cancel). */
  cancelled = 0;
  private server: Server | undefined;

  /** The base URL to configure as the provider's address, such as http://127.0.0.1:41234. */
  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    return `http://${host}:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    const key = String(req.headers['x-api-key'] ?? '');
    const accepted = this.accepted.has(key);
    this.requests.push({ method: req.method ?? 'GET', path, accepted });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake' });
      res.end(JSON.stringify(body));
    };
    if (!accepted) {
      return send(401, {
        type: 'error',
        error: { type: 'authentication_error', message: `invalid x-api-key ${key}` },
      });
    }
    if (req.method === 'GET' && path === '/v1/models') return send(200, MODELS);
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      // About four characters a token: enough for a caller that sizes its next call.
      return send(200, { input_tokens: Math.max(1, Math.ceil(Buffer.concat(chunks).length / 4)) });
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable body gets the recorded answer.
      }
      const system = Array.isArray(body.system)
        ? (body.system as { text?: string }[]).map((b) => b.text ?? '').join('\n\n')
        : typeof body.system === 'string'
          ? body.system
          : '';
      const messages = Array.isArray(body.messages)
        ? (body.messages as { role?: string; content?: unknown }[])
        : [];
      const prompt = messages
        .filter((m) => m.role === 'user')
        .map((m) => textOf(m.content))
        .join('\n\n');
      const format = (body.output_config as { format?: { schema?: unknown } } | undefined)?.format;
      const text = this.answer?.({
        system,
        prompt,
        stream: body.stream === true,
        schema: format?.schema ?? null,
        body,
      });
      if (text === undefined) return send(200, SUMMARY);
      if (body.stream === true) return this.streamText(res, text);
      return send(200, message(text));
    }
    return send(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
  }

  private async streamText(res: ServerResponse, text: string): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fake' });
    const event = (name: string, data: object) =>
      res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) gone = true;
    });
    event('message_start', { message: { ...message(''), content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    // A few words at a time, as a model writes.
    const pieces = text.match(/\S+\s*/g) ?? [text];
    for (let i = 0; i < pieces.length; i += 3) {
      if (gone) {
        this.cancelled += 1;
        return;
      }
      event('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: pieces.slice(i, i + 3).join('') },
      });
      await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
    }
    if (gone) {
      this.cancelled += 1;
      return;
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: pieces.length },
    });
    event('message_stop', {});
    res.end();
  }
}

/** A whole answer in the Messages API's shape. */
function message(text: string) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: Math.max(1, text.split(/\s+/).length),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}
