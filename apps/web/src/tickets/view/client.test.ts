import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../test/setup';
import { ticketClient } from './client';

const entry = (id: number) => ({
  id,
  author: { id: 1, name: 'Ana' },
  startedAt: `2026-11-0${id}T09:00:00Z`,
  duration: 3600,
  description: '',
  visibility: null,
});

describe('a ticket’s work log (T-305)', () => {
  it('[TIM-001] reads every time entry, past the list’s first page, where the newest are', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url.replace(/^\/api\/v1/, ''));
        const cursor = new URL(url, 'http://x').searchParams.get('cursor');
        return cursor === null
          ? jsonResponse(200, { timeEntries: [entry(1), entry(2)], next: 2 })
          : jsonResponse(200, { timeEntries: [entry(3)], next: null });
      }),
    );
    expect((await ticketClient.timeEntries(42)).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(asked).toEqual([
      '/tickets/42/time-entries?limit=500',
      '/tickets/42/time-entries?limit=500&cursor=2',
    ]);
  });
});
