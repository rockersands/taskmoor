import { vi } from 'vitest';
import { jsonResponse } from './setup';

export type Call = { method: string; path: string; body: unknown };
export type Handler = (body: unknown, path: string) => Response | Promise<Response>;

/**
 * A fake backend keyed by "METHOD /path" (the path after /api/v1, query included); a key
 * ending in `*` matches every path that starts with it. Everything else answers 404.
 */
const DEV_META = {
  version: '0.0.0-dev',
  frontend: { minimum: null, recommended: null },
  instance: { id: 'test-instance', name: '' },
};

export function stubBackend(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      // The app asks the meta endpoint, outside /api/v1, when it starts (M1-106): a development
      // backend answers, and it is not one of the page's calls, unless the test handles it.
      if (url === '/api/meta' && !handlers['GET /api/meta']) return jsonResponse(200, DEV_META);
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

/**
 * Every visible text and accessible name inside `root`, for the pseudo-locale checks. A path or an
 * address that offers a line break after each '/' (BreakAtSlashes) is one text, not its pieces.
 */
export function visibleTexts(root: HTMLElement): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('.slash-breaks')) continue;
    const text = node.textContent?.trim();
    if (text) texts.push(text);
  }
  for (const whole of root.querySelectorAll('.slash-breaks')) {
    const text = whole.textContent?.trim();
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
