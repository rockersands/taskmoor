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

/**
 * Accepts the keys it is told to (`x-api-key`), answers `GET /v1/models` with the recorded model
 * list and `POST /v1/messages` with the recorded summary. Any other key gets the API's
 * authentication error, whose message quotes the key it was sent, as some providers do, so tests
 * can show that the message reaches the administrator scrubbed.
 */
export class FakeProviderServer {
  readonly accepted = new Set<string>();
  /** Paths requested, in order, with whether the key was accepted. */
  readonly requests: { method: string; path: string; accepted: boolean }[] = [];
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for await (const _ of req) {
      // Drain the body; the answers do not depend on it.
    }
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
    if (req.method === 'POST' && path === '/v1/messages') return send(200, SUMMARY);
    return send(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
  }
}
