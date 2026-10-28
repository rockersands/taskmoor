import { vi } from 'vitest';
import { jsonResponse } from './setup';

export type Call = { method: string; path: string; body: unknown };
export type Handler = (body: unknown, path: string) => Response | Promise<Response>;

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
      // Uploads send FormData; everything else JSON.
      const body: unknown =
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? JSON.parse(String(init.body))
            : undefined;
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

/** Every visible text and accessible name inside `root`, for the pseudo-locale checks. */
export function visibleTexts(root: HTMLElement): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) texts.push(text);
  }
  for (const el of root.querySelectorAll('[aria-label], [title]')) {
    for (const attr of ['aria-label', 'title']) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  }
  return texts;
}

/** Texts that did not go through the catalogue: pseudo-localized ones are in brackets. */
export const untranslated = (texts: string[]) => texts.filter((t) => !/^\[.+\]$/s.test(t));
