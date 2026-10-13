import { vi } from 'vitest';
import { jsonResponse } from './setup';

export type Call = { method: string; path: string; body: unknown };
export type Handler = (body: unknown) => Response | Promise<Response>;

/**
 * A fake backend keyed by "METHOD /path" (the path after /api/v1); everything else answers
 * 404. Returns the calls it received, in order, with parsed JSON bodies.
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
      const handler = handlers[`${method} ${path}`];
      return handler ? handler(body) : jsonResponse(404, { error: 'not_found' });
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
