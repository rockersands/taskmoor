import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { rememberTrack } from '../tracks/recentTracks';
import { fakeHomeClient, fakeHomeTracks } from './fixtures';
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
            mayCreate ? { ...MEMBER, user: { ...MEMBER.user, mayCreateLocalTracks: true } } : MEMBER
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
    const all = await within(section).findByRole('link', { name: 'All tracks (8)' });
    expect(all).toHaveAttribute('href', '#/tracks');
    const cards = within(section).getAllByRole('listitem');
    expect(cards).toHaveLength(6);
    expect(within(cards[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '#/tracks/T7',
    );
  });

  it('[CORE-001] explains itself with no tracks, and offers New track only to those who may', async () => {
    const { unmount } = renderWith([], true);
    const section = screen.getByRole('region', { name: 'Your tracks' });
    expect(await within(section).findByRole('link', { name: 'New track' })).toHaveAttribute(
      'href',
      '#/tracks?new',
    );
    unmount();
    renderWith([]);
    const plain = screen.getByRole('region', { name: 'Your tracks' });
    expect(await within(plain).findByText('No tracks yet')).toBeVisible();
    expect(within(plain).queryByRole('link', { name: 'New track' })).toBeNull();
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
