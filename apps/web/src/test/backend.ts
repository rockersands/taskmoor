import { vi } from 'vitest';
import { jsonResponse } from './setup';

export type Call = { method: string; path: string; body: unknown };
export type Handler = (body: unknown, path: string) => Response;

/**
 * A fake backend keyed by "METHOD /path" (the path after /api/v1, query included); a key
 * ending in `*` matches every path that starts with it. Everything else answers 404.
 */
export function stubBackend(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.replace(/^\/api\/v1/, '');
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const handler =
        handlers[key] ??
        Object.entries(handlers).find(
          ([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)),
        )?.[1];
      return handler ? handler(body, path) : jsonResponse(404, { error: 'not_found' });
    }),
  );
  return calls;
}

export const noContent = () => new Response(null, { status: 204 });
