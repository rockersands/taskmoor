import { OPERATIONS, type OperationId } from './generated/operations';
import type { components, operations } from './generated/schema';

/**
 * A typed client for Taskmoor's REST API v1 (M1-065; ADR-067), over `fetch`. Every stable
 * operation is called by its id, with its path parameters, query and body typed from the API
 * document; the answer is the documented success body. A refusal throws `TaskmoorError` with
 * the status and the shared error body. Lists that page by cursor can be read whole with
 * `pages`.
 *
 *   const taskmoor = createClient({ baseUrl: 'https://tracker.example.com', token });
 *   const { ticket } = await taskmoor.call('getTicket', { path: { id: 'PAY-12' } });
 */
export type { components, OperationId, operations };
export type Schemas = components['schemas'];

type Op<K extends OperationId> = operations[K];
type Params<K extends OperationId> = Op<K>['parameters'];
/** Path parameters, when the operation has them (they are then required). */
type PathOf<K extends OperationId> = Params<K> extends { path: infer T } ? T : never;
/** Query parameters, all optional or not, when the operation takes any. */
type QueryOf<K extends OperationId> = Exclude<
  Params<K> extends { query?: infer T } ? T : never,
  undefined
>;
/** The JSON body, when the operation takes one. */
type BodyOf<K extends OperationId> =
  Op<K> extends {
    requestBody: { content: { 'application/json': infer B } };
  }
    ? B
    : never;

/** What an operation takes: the parts it has, the path and body required when it has them. */
export type Input<K extends OperationId> = ([PathOf<K>] extends [never]
  ? { path?: never }
  : { path: PathOf<K> }) &
  ([QueryOf<K>] extends [never] ? { query?: never } : { query?: QueryOf<K> }) &
  ([BodyOf<K>] extends [never] ? { body?: never } : { body: BodyOf<K> });

type Responses<K extends OperationId> = Op<K>['responses'];
type Success<K extends OperationId> = Extract<keyof Responses<K>, 200 | 201 | 202 | 204>;
/** What an operation answers with when it succeeds; undefined for 204. */
export type Output<K extends OperationId> = {
  [S in Success<K>]: Responses<K>[S] extends { content: { 'application/json': infer B } }
    ? B
    : undefined;
}[Success<K>];

/** The operations that page by cursor, for `pages`. */
export type PagedOperationId = {
  [K in OperationId]: (typeof OPERATIONS)[K]['paged'] extends true ? K : never;
}[OperationId];

export class TaskmoorError extends Error {
  constructor(
    readonly status: number,
    readonly body: Schemas['Error'] | unknown,
  ) {
    super(`Taskmoor API ${status}`);
    this.name = 'TaskmoorError';
  }

  /** The server's short code, such as `not_found`, when it sent one. */
  get code(): string | undefined {
    const b = this.body as { error?: unknown } | null;
    return typeof b?.error === 'string' ? b.error : undefined;
  }
}

export interface ClientOptions {
  /** The server's address, such as `https://tracker.example.com` (no `/api/v1`). */
  baseUrl: string;
  /** An API token (a person's or a service account's); sent as a bearer token. */
  token?: string;
  /** More headers for every request. */
  headers?: Record<string, string>;
  /** Another fetch, for tests or proxies. */
  fetch?: typeof fetch;
}

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<K extends OperationId>(id: K, input?: Input<K>): Promise<Output<K>> {
    const { method, path } = OPERATIONS[id];
    const given = (input ?? {}) as {
      path?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
    };
    const url = new URL(
      base +
        path.replace(/\{([A-Za-z0-9]+)\}/g, (_, name: string) =>
          encodeURIComponent(String(given.path?.[name])),
        ),
    );
    for (const [name, value] of Object.entries(given.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const one of Array.isArray(value) ? value : [value])
        url.searchParams.append(name, String(one));
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (given.body !== undefined) headers['content-type'] = 'application/json';
    const response = await doFetch(url, {
      method,
      headers,
      ...(given.body !== undefined ? { body: JSON.stringify(given.body) } : {}),
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new TaskmoorError(response.status, body ?? null);
    return body as Output<K>;
  }

  /** Every page of a paged list, following `next` until the last. */
  async function* pages<K extends PagedOperationId>(
    id: K,
    input?: Input<K>,
  ): AsyncGenerator<Output<K>> {
    let cursor: unknown;
    do {
      const given = (input ?? {}) as { query?: Record<string, unknown> };
      const page = await call(id, {
        ...(input ?? {}),
        query: { ...(given.query ?? {}), ...(cursor !== undefined ? { cursor } : {}) },
      } as Input<K>);
      yield page;
      cursor = (page as { next?: unknown }).next ?? undefined;
    } while (cursor !== undefined);
  }

  return { call, pages };
}

export type TaskmoorClient = ReturnType<typeof createClient>;
