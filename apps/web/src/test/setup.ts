import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installMatchMedia, setViewportWidth } from './viewport';

installMatchMedia();

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
