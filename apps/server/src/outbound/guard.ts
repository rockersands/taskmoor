import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  addressAllowed,
  hostAllowed,
  type OutboundAllow,
  parseOutboundAllow,
  plainAddress,
  type RefusedReason,
  refusedReason,
} from './addresses';

/**
 * The outbound guard (M1-118; ASVS 5.2.6, 12.6.1; ADR-110). Every request the server makes to
 * an address someone typed (webhooks, AI providers, OpenID Connect discovery and its endpoints,
 * a Cloud import's site) goes through `guard.fetch`, a `fetch` built on `node:http` whose
 * connections resolve their host through `guard.lookup`:
 *
 * - The host is resolved, and every address it resolves to is checked; one address that may not
 *   be reached refuses the request (`refusedReason`: loopback, private, CGNAT, link-local,
 *   unique-local, multicast, reserved and metadata addresses, IPv4 and IPv6, the IPv4 forms
 *   inside IPv6 judged by the IPv4 address they carry). An address literal is checked as is.
 * - The socket connects to the address that was checked, never to a second lookup's answer, so
 *   DNS rebinding cannot swap it between the check and the connection.
 * - Redirects: `manual` and `error` behave as in `fetch`; `follow` (the default) follows at most
 *   five, each through the same check, dropping credentials when the origin changes.
 * - Only `http:` and `https:` are sent.
 * - The operator's allow list (`TASKMOOR_OUTBOUND_ALLOW`, `parseOutboundAllow`) lets named
 *   hosts, domains, addresses and ranges through, for a receiver on the internal network.
 *
 * A refusal throws `OutboundRefused`, which names the host, the address and why, never the
 * request's headers.
 */
export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;

export interface OutboundGuardOptions {
  /** The operator's allow list, parsed or as `TASKMOOR_OUTBOUND_ALLOW` spells it. */
  allow?: OutboundAllow | string;
  /** Replaced in tests so no name is ever resolved over the network. */
  resolve?: Resolver;
  /** Redirects followed at most (default 5). */
  maxRedirects?: number;
}

const LABEL: Record<RefusedReason, string> = {
  unspecified: 'unspecified',
  loopback: 'loopback',
  private: 'private',
  cgnat: 'shared address space',
  link_local: 'link-local',
  unique_local: 'unique local',
  multicast: 'multicast',
  metadata: 'cloud metadata',
  reserved: 'reserved',
};

export class OutboundRefused extends Error {
  readonly code = 'outbound_refused';
  constructor(
    readonly host: string,
    readonly address: string | null,
    readonly reason: RefusedReason | 'protocol' | 'unresolved' | 'redirect',
  ) {
    super(
      reason === 'protocol'
        ? `Refused: only http and https may be requested (${host})`
        : reason === 'unresolved'
          ? `Refused: ${host} does not resolve`
          : reason === 'redirect'
            ? `Refused: too many redirects (${host})`
            : `Refused: ${address && address !== host ? `${host} resolves to ${address}, which` : host} is not a public address (${LABEL[reason]}); an operator can allow it with TASKMOOR_OUTBOUND_ALLOW`,
    );
    this.name = 'OutboundRefused';
  }
}

/** The refusal behind an error, when a client library wrapped it (as its `cause`). */
export function outboundRefusal(error: unknown): OutboundRefused | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof OutboundRefused) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export interface OutboundGuard {
  /** `fetch` with the guard on every connection. */
  fetch: typeof fetch;
  /** Resolves a host and checks every address; the addresses it may connect to. */
  check(host: string): Promise<{ address: string; family: 4 | 6 }[]>;
  /** For `http.request` and `net.connect`: resolves through `check`. */
  lookup: LookupFunction;
  readonly allow: OutboundAllow;
  /** Ends idle keep-alive connections (shutdown, tests). */
  close(): void;
}

const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

const NULL_BODY = new Set([101, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export function createOutboundGuard(options: OutboundGuardOptions = {}): OutboundGuard {
  const allow =
    typeof options.allow === 'string' || options.allow === undefined
      ? parseOutboundAllow(options.allow)
      : options.allow;
  const resolve = options.resolve ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? 5;

  const check = async (rawHost: string): Promise<{ address: string; family: 4 | 6 }[]> => {
    const host = plainAddress(rawHost);
    const literal = isIP(host);
    if (literal !== 0) {
      if (!addressAllowed(allow, host)) {
        const reason = refusedReason(host);
        if (reason) throw new OutboundRefused(host, host, reason);
      }
      return [{ address: host, family: literal as 4 | 6 }];
    }
    let answers: readonly { address: string; family: number }[];
    try {
      answers = await resolve(host);
    } catch {
      throw new OutboundRefused(host, null, 'unresolved');
    }
    if (answers.length === 0) throw new OutboundRefused(host, null, 'unresolved');
    const named = hostAllowed(allow, host);
    const out: { address: string; family: 4 | 6 }[] = [];
    for (const answer of answers) {
      const address = plainAddress(answer.address);
      const family = isIP(address);
      if (family === 0) throw new OutboundRefused(host, address, 'reserved');
      if (!named && !addressAllowed(allow, address)) {
        const reason = refusedReason(address);
        if (reason) throw new OutboundRefused(host, address, reason);
      }
      out.push({ address, family: family as 4 | 6 });
    }
    return out;
  };

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    check(hostname).then(
      (addresses) => {
        const wanted =
          lookupOptions.family === 4 || lookupOptions.family === 6
            ? addresses.filter((a) => a.family === lookupOptions.family)
            : addresses;
        if (wanted.length === 0) {
          const error = Object.assign(new Error(`${hostname} has no address of that family`), {
            code: 'ENOTFOUND',
          });
          callback(error, '', 0);
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
            null,
            wanted,
          );
        } else {
          const first = wanted[0] as { address: string; family: number };
          callback(null, first.address, first.family);
        }
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, '', 0),
    );
  };

  // Each request names the lookup, so a pooled connection was made to a checked address too.
  const agents = {
    http: new HttpAgent({ keepAlive: true }),
    https: new HttpsAgent({ keepAlive: true }),
  };

  /** One request and its answer, without following redirects. */
  const once = async (
    url: URL,
    method: string,
    headers: Headers,
    body: Buffer | undefined,
    signal: AbortSignal | null,
  ): Promise<Response> => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OutboundRefused(url.host, null, 'protocol');
    }
    signal?.throwIfAborted();
    // An address literal never reaches the lookup: check it here. A name is checked by the
    // lookup, on the connection itself.
    if (isIP(plainAddress(url.hostname)) !== 0) await check(url.hostname);
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoing[name] = value;
    });
    if (body !== undefined) outgoing['content-length'] = String(body.length);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const answer = await new Promise<IncomingMessage>((done, fail) => {
      const req = send(url, {
        method,
        headers: outgoing,
        agent: url.protocol === 'https:' ? agents.https : agents.http,
        lookup,
        ...(signal ? { signal } : {}),
      });
      req.on('response', done);
      req.on('error', (error) => fail(signal?.aborted ? signal.reason : error));
      req.end(body);
    });
    const responseHeaders = new Headers();
    for (let i = 0; i + 1 < answer.rawHeaders.length; i += 2) {
      responseHeaders.append(answer.rawHeaders[i] as string, answer.rawHeaders[i + 1] as string);
    }
    const status = answer.statusCode ?? 502;
    if (NULL_BODY.has(status) || method === 'HEAD') {
      answer.resume();
      return new Response(null, {
        status,
        statusText: answer.statusMessage ?? '',
        headers: responseHeaders,
      });
    }
    let stream: Readable = answer;
    const encoding = (responseHeaders.get('content-encoding') ?? '').trim().toLowerCase();
    const decoder =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? createGunzip()
        : encoding === 'br'
          ? createBrotliDecompress()
          : encoding === 'deflate'
            ? createInflate()
            : null;
    if (decoder) {
      answer.on('error', (error) => decoder.destroy(error));
      stream = answer.pipe(decoder);
    }
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: status < 200 || status > 599 ? 502 : status,
      statusText: answer.statusMessage ?? '',
      headers: responseHeaders,
    });
  };

  const guardedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // The platform's Request reads every form of headers and body a caller may pass.
    const request = new Request(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    let url = new URL(request.url);
    let method = request.method;
    const headers = new Headers(request.headers);
    let body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    for (let hop = 0; ; hop++) {
      const response = await once(url, method, headers, body, signal);
      if (!REDIRECT.has(response.status) || request.redirect === 'manual') return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      await response.body?.cancel().catch(() => undefined);
      if (request.redirect === 'error') {
        throw new TypeError(`fetch failed: redirect to ${location} refused`);
      }
      if (hop >= maxRedirects) throw new OutboundRefused(url.host, null, 'redirect');
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        if (method !== 'HEAD') method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      url = next;
    }
  };

  return {
    fetch: guardedFetch as typeof fetch,
    check,
    lookup,
    allow,
    close: () => {
      agents.http.destroy();
      agents.https.destroy();
    },
  };
}

let shared: OutboundGuard | undefined;

/**
 * The process's guard, with the operator's allow list from `TASKMOOR_OUTBOUND_ALLOW` and the
 * hosts the operator configured in the environment itself (`TASKMOOR_AI_BASE_URL`): whoever
 * sets those could set the allow list as well.
 */
export function outboundGuard(env: NodeJS.ProcessEnv = process.env): OutboundGuard {
  if (shared) return shared;
  const operatorHosts = [env.TASKMOOR_AI_BASE_URL]
    .map((url) => {
      try {
        return url ? new URL(url).hostname : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  shared = createOutboundGuard({
    allow: [env.TASKMOOR_OUTBOUND_ALLOW ?? '', ...operatorHosts].join(','),
  });
  return shared;
}
