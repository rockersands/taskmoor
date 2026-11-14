import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { trackPeopleClient } from './client';

const invitation = (id: number) => ({
  id,
  email: `person-${id}@example.net`,
  role: { id: 2, name: 'Members' },
  invitedBy: 'Ana',
  delivery: 'email',
  sendFailed: false,
  lastSentAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-11-15T12:00:00.000Z',
  state: 'open',
  external: false,
});

describe('a track’s pending invitations (T-305)', () => {
  it('[IAM-027] reads every page of them, not the first 500 alone', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = url.replace(/^\/api\/v1/, '');
        asked.push(path);
        const after = new URL(url, 'http://x').searchParams.get('after');
        const flags = {
          canInvite: true,
          invitingGiven: false,
          emailAvailable: true,
          canCopyLinks: false,
        };
        return after === null
          ? jsonResponse(200, {
              invitations: [invitation(9)],
              next: '1700000000000000-9',
              ...flags,
            })
          : jsonResponse(200, { invitations: [invitation(4)], next: null, ...flags });
      }),
    );
    const view = await trackPeopleClient.invitations(3);
    expect(view.invitations.map((i) => i.id)).toEqual([9, 4]);
    expect(view).toMatchObject({
      canInvite: true,
      invitingGiven: false,
      emailAvailable: true,
      canCopyLinks: false,
    });
    expect(view).not.toHaveProperty('next');
    expect(asked).toEqual([
      '/tracks/3/invitations',
      '/tracks/3/invitations?after=1700000000000000-9',
    ]);
  });
});
