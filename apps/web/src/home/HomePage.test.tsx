import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { rememberTrack } from '../tracks/recentTracks';
import { HOME_TRACKS_PATH, homeTracks, recentHomeTracksPath } from './client';
import { fakeHomeClient, fakeHomeTracks, TRACKS } from './fixtures';
import { HomePage } from './HomePage';

function renderPage(client = fakeHomeClient(), locale: Locale = 'en') {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={MEMBER}>
        <main>
          <HomePage client={client} tracks={fakeHomeTracks()} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
}

describe('your tracks on the home page', () => {
  // Which tracks were opened lately is kept in this browser; each test starts with none.
  beforeEach(() => window.localStorage.clear());

  const many = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    key: `T${i}`,
    name: `Track ${i}`,
    type: 'software',
  }));
  const renderWith = (tracks: typeof many, mayCreate = false) =>
    render(
      <I18nProvider locale="en">
        <SessionProvider
          session={
            mayCreate
              ? {
                  status: 'signed-in',
                  user: {
                    id: 7,
                    name: 'Mina',
                    email: 'mina@example.com',
                    isSiteAdmin: false,
                    mayCreateLocalTracks: true,
                    timeZone: null,
                    locale: null,
                  },
                }
              : MEMBER
          }
        >
          <main>
            <HomePage client={fakeHomeClient()} tracks={async () => tracks} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );

  it('[AGL-019] comes first, keeps to six with the latest opened first, and leads to all', async () => {
    rememberTrack('T7');
    renderWith(many);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    const page = screen.getByRole('main');
    expect(
      section.compareDocumentPosition(
        within(page).getByRole('region', { name: 'Assigned to you' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const all = await within(section).findByRole('link', { name: 'All tracks' });
    expect(all).toHaveAttribute('href', '#/tracks');
    const cards = within(section).getAllByRole('listitem');
    expect(cards).toHaveLength(6);
    expect(within(cards[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '#/tracks/T7',
    );
  });

  const renderLive = () =>
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <HomePage client={fakeHomeClient()} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );

  it('[AGL-019] asks the server for the tracks the person belongs to, not every track they see', async () => {
    const calls = stubBackend({
      [`GET ${HOME_TRACKS_PATH}`]: () => jsonResponse(200, { tracks: TRACKS, next: null }),
    });
    renderLive();
    const section = screen.getByRole('region', { name: 'Your tracks' });
    const cards = await within(section).findAllByRole('link', { name: /Key/ });
    expect(cards.map((c) => c.getAttribute('href'))).toEqual(['#/tracks/OPS', '#/tracks/SHOP']);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /tracks?member=true&limit=500',
    ]);
  });

  it('[AGL-019] puts the track opened last first for someone in more than 500, however late its key sorts', async () => {
    // 600 tracks of hers: the first page holds 500 by key, and ZEN, opened last, is not on it.
    const hers = Array.from({ length: 600 }, (_, i) => ({
      id: i + 1,
      key: `A${String(i).padStart(3, '0')}`,
      name: `Track ${String(i).padStart(3, '0')}`,
      type: 'software',
    }));
    const zen = { id: 9001, key: 'ZEN', name: 'Zen garden', type: 'software' };
    rememberTrack('A550');
    rememberTrack('OLD');
    rememberTrack('ZEN');
    const calls = stubBackend({
      [`GET ${HOME_TRACKS_PATH}`]: () =>
        jsonResponse(200, { tracks: hers.slice(0, 500), next: 'A499' }),
      // OLD is no longer hers: the server leaves it out.
      'GET /tracks?member=true&keys=ZEN,OLD,A550': () =>
        jsonResponse(200, { tracks: [hers[550], zen], next: null }),
    });
    renderLive();
    const section = screen.getByRole('region', { name: 'Your tracks' });
    const cards = await within(section).findAllByRole('link', { name: /Key/ });
    expect(cards.map((c) => c.getAttribute('href'))).toEqual([
      '#/tracks/ZEN',
      '#/tracks/A550',
      '#/tracks/A000',
      '#/tracks/A001',
      '#/tracks/A002',
      '#/tracks/A003',
    ]);
    expect(within(section).getByRole('link', { name: 'All tracks' })).toBeVisible();
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /tracks?member=true&keys=ZEN,OLD,A550',
      'GET /tracks?member=true&limit=500',
    ]);
  });

  it('[AGL-019] sends only keys a track can have, each once and at most 50', async () => {
    const calls = stubBackend({
      'GET /tracks*': () => jsonResponse(200, { tracks: [], next: null }),
    });
    const keys = Array.from({ length: 60 }, (_, i) => `K${i}`);
    await homeTracks(['OPS', 'not a key', 'OPS', '<b>', ...keys]);
    expect(calls.map((c) => c.path)).toContain(recentHomeTracksPath(['OPS', ...keys.slice(0, 49)]));
    expect(recentHomeTracksPath(['OPS', 'SHOP'])).toBe('/tracks?member=true&keys=OPS,SHOP');
  });

  it('[AGL-019] says when the person is in no track and points to the Tracks page', async () => {
    renderWith([]);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    expect(await within(section).findByText('You are not in any track yet')).toBeVisible();
    expect(
      within(section).getByText(/The Tracks page lists every track you can see\./),
    ).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Go to Tracks' })).toHaveAttribute(
      'href',
      '#/tracks',
    );
    expect(within(section).queryByRole('link', { name: 'New track' })).toBeNull();
    expect(within(section).queryByRole('link', { name: 'All tracks' })).toBeNull();
  });

  it('[CORE-001] offers New track beside the way to Tracks only to those who may create one', async () => {
    renderWith([], true);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    expect(await within(section).findByRole('link', { name: 'New track' })).toHaveAttribute(
      'href',
      '#/tracks?new',
    );
    expect(within(section).getByRole('link', { name: 'Go to Tracks' })).toBeVisible();
  });

  it('[AGL-019] says which tracks it holds and that the order is kept in this browser', async () => {
    renderWith(many);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    await within(section).findAllByRole('listitem');
    await userEvent.click(
      within(section).getByRole('button', { name: 'What is Your tracks for?' }),
    );
    expect(
      within(section).getByText(/The tracks you belong to: .* lately in this browser come first/),
    ).toBeVisible();
  });

  it('[AGL-019] fits a small phone with no track of yours', async () => {
    setViewportWidth(375);
    renderWith([]);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    expect(await within(section).findByRole('link', { name: 'Go to Tracks' })).toBeVisible();
  });
});

describe('the home page (M1-052)', () => {
  it('[AGL-019] lists assigned, recently opened and followed tickets, each linking its ticket', async () => {
    renderPage();
    const assigned = await screen.findByRole('region', { name: 'Assigned to you' });
    const links = await within(assigned).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'SHOP-41 Refunds fail for expired cards',
      'SHOP-44 Receipts show the wrong currency',
    ]);
    expect(links[0]).toHaveAttribute('href', '#/tickets/SHOP-41');
    const recent = screen.getByRole('region', { name: 'Opened lately' });
    expect(await within(recent).findByText('Closed')).toBeVisible();
    const followed = screen.getByRole('region', { name: 'You follow' });
    expect(await within(followed).findAllByRole('link')).toHaveLength(1);
  });

  it('says when a list is empty, and when one could not be read, keeping the others', async () => {
    renderPage(fakeHomeClient({ empty: ['assigned'], failing: ['followed'] }));
    expect(await screen.findByText('Nothing is assigned to you.')).toBeVisible();
    const followed = screen.getByRole('region', { name: 'You follow' });
    expect(
      await within(followed).findByText('This list could not be read. Try again in a moment.'),
    ).toBeVisible();
    const recent = screen.getByRole('region', { name: 'Opened lately' });
    expect(await within(recent).findAllByRole('link')).toHaveLength(2);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('region', { name: 'Assigned to you' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(fakeHomeClient(), 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('link');
    const data = new Set([
      'SHOP-41',
      'SHOP-44',
      'SHOP-12',
      'Refunds fail for expired cards',
      'Receipts show the wrong currency',
      'Checkout times out on slow networks',
      'Active',
      'New',
      'Closed',
      'Shop',
      'Operations',
      'SHO',
      'OPS',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
