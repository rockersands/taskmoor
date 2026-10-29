import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeHomeClient } from './fixtures';
import { HomePage } from './HomePage';

function renderPage(client = fakeHomeClient(), locale: Locale = 'en') {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={MEMBER}>
        <main>
          <HomePage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
}

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
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
