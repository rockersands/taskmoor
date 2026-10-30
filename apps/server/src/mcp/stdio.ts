import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * MCP over stdio (M1-072; API-012; ADR-068): a local bridge for MCP clients that start a
 * command, such as desktop assistants and coding agents. Each line on stdin is a JSON-RPC
 * message; it goes to the server's streamable HTTP endpoint with the person's API token, and
 * the answer comes back as one line on stdout. The session the server opens is kept for the
 * following messages and ended when stdin closes. Logs go to stderr only: stdout carries the
 * protocol.
 *
 *   TASKMOOR_URL=https://tracker.example.com TASKMOOR_TOKEN=... node cli.mjs mcp
 */
export interface BridgeOptions {
  /** The server's address, without `/api/v1`. */
  url: string;
  token: string;
  input: Readable;
  output: Writable;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export async function bridgeStdio(options: BridgeOptions): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const endpoint = new URL('/api/v1/mcp', options.url);
  const log = options.log ?? (() => {});
  let session: string | null = null;
  let version: string | null = null;
  const write = (value: unknown) => options.output.write(`${JSON.stringify(value)}\n`);

  const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message: { id?: unknown; method?: unknown } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } });
      continue;
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${options.token}`,
    };
    if (session) headers['mcp-session-id'] = session;
    if (version) headers['mcp-protocol-version'] = version;
    let response: Response;
    try {
      response = await doFetch(endpoint, { method: 'POST', headers, body: line });
    } catch (error) {
      log(`mcp bridge: ${(error as Error).message}`);
      if (message?.id !== undefined) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'The server cannot be reached.' },
        });
      }
      continue;
    }
    const opened = response.headers.get('mcp-session-id');
    if (opened) session = opened;
    if (response.status === 202) continue;
    const text = await response.text();
    let body: { result?: { protocolVersion?: unknown } } | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && 'jsonrpc' in body) {
      if (message?.method === 'initialize' && typeof body.result?.protocolVersion === 'string') {
        version = body.result.protocolVersion;
      }
      write(body);
    } else if (message?.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `The server answered ${response.status}.` },
      });
    }
  }
  if (session) {
    await doFetch(endpoint, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${options.token}`, 'mcp-session-id': session },
    }).catch(() => undefined);
  }
}
