import type { Version } from '../operations';

/**
 * The shim's view of the server (M1-069; ADR-016, ADR-086). Each compatible route turns a
 * request into calls to Taskmoor's own API, made in-process with the caller's credentials, so
 * every permission, field rule, history row and event is the native API's own. The shim never
 * reads the database and knows nothing of the web framework: the server registers
 * `COMPAT_ROUTES` and supplies `native`.
 */
export interface NativeAnswer {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
  body: any;
}

/** Calls the native API as the request's caller; `path` starts with `/api/`. */
export type Native = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<NativeAnswer>;

export interface ShimContext {
  version: Version;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  native: Native;
  /** The server's public address, for `self` links. */
  baseUrl: string;
  /** A stored rich-text document in this version's form: Markdown on v2, the document format on v3. */
  richText: (doc: unknown) => unknown;
}

export interface ShimReply {
  status: number;
  body?: unknown;
}

export interface ShimRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** A route pattern with `:name` parameters; `:v` is the API version, 2 or 3. */
  path: string;
  handle: (ctx: ShimContext) => Promise<ShimReply>;
}

/** Thrown inside a handler to answer at once, usually with a Jira-compatible error. */
export class ShimError extends Error {
  constructor(readonly reply: ShimReply) {
    super(`compat ${reply.status}`);
  }
}
