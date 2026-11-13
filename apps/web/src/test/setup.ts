import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installMatchMedia, setRootFontSize, setViewportWidth } from './viewport';

installMatchMedia();

// jsdom lays nothing out; the rich text editor (ProseMirror) measures ranges and asks what is
// under a point while it keeps the caret in view. Empty answers are what it gets on a page
// that is not drawn.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.elementFromPoint ??= () => null;

/**
 * No test talks to a backend. By default every API call answers 401 (signed out) as JSON, so
 * the session check settles to "anonymous"; a test that needs other answers stubs fetch itself.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Every test starts on a desktop-sized viewport, the primary target.
beforeEach(() => {
  setRootFontSize(16);
  setViewportWidth(1440);
  window.location.hash = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(401, { error: 'not_signed_in' })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
