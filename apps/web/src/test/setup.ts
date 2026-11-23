import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installMatchMedia, setCoarsePointer, setRootFontSize, setViewportWidth } from './viewport';

installMatchMedia();

// findBy* and waitFor wait up to 5 s, not Testing Library's 1 s: on a machine that also runs other
// suites, a 2,000-card board settles after a second or more, and that is not what a test checks
// (speed limits are expectWithinBudget's). A wait for something that never comes now fails after
// 5 s instead of 1, still well inside a test's own 20 s limit (vitest.config.ts).
configure({ asyncUtilTimeout: 5_000 });

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

// Every test starts on a desktop-sized viewport with a mouse, the primary target.
beforeEach(() => {
  setRootFontSize(16);
  setViewportWidth(1440);
  setCoarsePointer(false);
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
