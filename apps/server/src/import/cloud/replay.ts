import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson } from '../../tickets/model';
import { ATLASSIAN_HOST, type CloudRequest, type CloudResponse, type Transport } from './client';

/**
 * Recorded exchanges with a server that speaks the Jira-compatible REST API (M1-095; ADR-094),
 * and a transport that answers from them. The fixtures in this folder were recorded from
 * Taskmoor's own compatible API over synthetic data (`testing/compat-source.ts`), never from an
 * Atlassian product (ADR-003). A recording holds requests and answers only: the
 * `Authorization` value never reaches the recorder.
 */
export const REPLAY_FORMAT = 'taskmoor-compat-replay';

export interface Exchange {
  method: CloudRequest['method'];
  path: string;
  body?: unknown;
  status: number;
  headers?: Record<string, string>;
  response: unknown;
}

export interface Recording {
  format: typeof REPLAY_FORMAT;
  version: 1;
  /** What the answers were recorded from; never an Atlassian host. */
  source: string;
  exchanges: Exchange[];
}

const keyOf = (r: { method: string; path: string; body?: unknown }) =>
  `${r.method} ${r.path} ${r.body === undefined ? '' : canonicalJson(r.body)}`;

export class ReplayMiss extends Error {}

/** A transport that answers each request with its recorded answer; unknown ones throw. */
export function replayTransport(recording: Recording): Transport {
  if (recording.format !== REPLAY_FORMAT) throw new Error('not a replay recording');
  const answers = new Map(recording.exchanges.map((e) => [keyOf(e), e]));
  return async (request) => {
    const found = answers.get(keyOf(request));
    if (!found) throw new ReplayMiss(`no recorded answer for ${request.method} ${request.path}`);
    // A copy: the caller may change what it gets.
    return {
      status: found.status,
      headers: { ...(found.headers ?? {}) },
      body: structuredClone(found.response),
    };
  };
}

/** Wraps a transport and keeps every exchange, each request once. */
export function recorder(inner: Transport): { transport: Transport; exchanges: () => Exchange[] } {
  const kept = new Map<string, Exchange>();
  return {
    transport: async (request, authorization) => {
      const response: CloudResponse = await inner(request, authorization);
      kept.set(keyOf(request), {
        method: request.method,
        path: request.path,
        ...(request.body !== undefined ? { body: request.body } : {}),
        status: response.status,
        ...(Object.keys(response.headers).length > 0 ? { headers: response.headers } : {}),
        response: response.body,
      });
      return response;
    },
    exchanges: () =>
      [...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e),
  };
}

export function readRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, 'utf8')) as Recording;
}

export function writeRecording(path: string, source: string, exchanges: Exchange[]): void {
  if (ATLASSIAN_HOST.test(new URL(source).hostname)) {
    throw new Error('Recordings come from Taskmoor only, never an Atlassian product (ADR-003).');
  }
  const recording: Recording = { format: REPLAY_FORMAT, version: 1, source, exchanges };
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
}
