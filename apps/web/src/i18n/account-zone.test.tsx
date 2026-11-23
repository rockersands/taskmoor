import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { listPath } from '../inbox/client';
import { ITEMS } from '../inbox/fixtures';
import type { Session } from '../session/SessionProvider';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { useTimeZone } from '../test/timeZone';
import { personTimeZone } from './zone';

const member = MEMBER as Extract<Session, { status: 'signed-in' }>;
const withZone = (timeZone: string | null): Session => ({
  status: 'signed-in',
  user: { ...member.user, timeZone },
});

/** The zone each request to the backend carried, by path. */
const zonesSent = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url, init]) => [
      String(url).replace(/^\/api\/v1/, ''),
      new Headers(init?.headers).get('taskmoor-time-zone'),
    ]);

/**
 * One clock per person (T-280): the zone saved on the account writes the app's times and goes to
 * the server with every request; Automatic is the device's. The device here is Mexico City.
 */
describe('the time zone saved on the account (IAM-008, NFR-006)', () => {
  useTimeZone('America/Mexico_City');
  afterEach(() => {
    window.location.hash = '';
    vi.unstubAllGlobals();
  });

  const openInbox = (session: Session) => {
    stubBackend({
      [`GET ${listPath({ view: 'all' })}`]: () =>
        jsonResponse(200, {
          items: ITEMS.slice(0, 1),
          unread: { all: 1, priority: 1 },
          next: null,
        }),
    });
    // No realtime socket here.
    vi.stubGlobal('WebSocket', undefined);
    window.location.hash = '#/inbox';
    return render(<App session={session} />);
  };

  it('[IAM-008] [NFR-006] writes times on the saved zone and sends it with every request, whatever the device’s', async () => {
    const { unmount } = openInbox(withZone('Asia/Tokyo'));
    // Made at 09:41 in UTC: 18:41 in Tokyo, 03:41 on the device.
    expect(await screen.findByText(/^Oct 29, 2026, 6:41\sPM$/)).toBeVisible();
    expect(personTimeZone()).toBe('Asia/Tokyo');
    expect(zonesSent()).toContainEqual(['/inbox?view=all', 'Asia/Tokyo']);
    // Signed out of this page, the clock is the device's again.
    unmount();
    expect(personTimeZone()).toBe('America/Mexico_City');
  });

  it('[IAM-008] keeps the device’s clock on Automatic', async () => {
    openInbox(withZone(null));
    expect(await screen.findByText(/^Oct 29, 2026, 3:41\sAM$/)).toBeVisible();
    expect(zonesSent()).toContainEqual(['/inbox?view=all', 'America/Mexico_City']);
  });
});
