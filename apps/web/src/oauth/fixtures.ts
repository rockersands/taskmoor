import { ApiError } from '../api/client';
import type { ConsentClient, ConsentRequest } from './client';

export const SAMPLE_REQUEST: ConsentRequest = {
  client: {
    id: 'tmc_sample0000000000000000000',
    name: 'Desktop assistant',
    clientUri: null,
    registeredAt: '2026-10-31T00:40:00.000Z',
  },
  redirectUri: 'http://127.0.0.1:33418/callback',
  scope: 'read write',
};

/** An in-memory consent backend for stories and tests; `answers` records what was answered. */
export function fakeConsentClient(
  overrides: Partial<ConsentClient> = {},
  request: ConsentRequest = SAMPLE_REQUEST,
): ConsentClient & { answers: { approve: boolean; scope: string }[]; visited: string[] } {
  const answers: { approve: boolean; scope: string }[] = [];
  const visited: string[] = [];
  return {
    answers,
    visited,
    load: async () => structuredClone(request),
    answer: async (_id, approve, scope) => {
      answers.push({ approve, scope });
      return approve
        ? `${request.redirectUri}?code=sample-code&iss=https%3A%2F%2Ftracker.example.com`
        : `${request.redirectUri}?error=access_denied`;
    },
    go: (url) => {
      visited.push(url);
    },
    ...overrides,
  };
}

/** A load that fails as the backend answers it: 401 signed out, 404 gone. */
export const failingLoad = (status: number) => () => Promise.reject(new ApiError(status, null));
