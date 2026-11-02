import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeGuardrailsClient, fakeStorageClient } from './fixtures';
import { GuardrailsPage } from './GuardrailsPage';

function renderPage(locale: Locale = 'en') {
  const client = fakeGuardrailsClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          <GuardrailsPage client={client} storage={fakeStorageClient()} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('guardrails (M1-055)', () => {
  it('[CORE-026] shows usage against every limit, and which are above theirs', async () => {
    renderPage();
    expect(await screen.findByText('Most used: 120 of 15,000 in SHOP')).toBeVisible();
    expect(screen.getByText('Not used yet; the limit is 20,000')).toBeVisible();
    const areas = screen.getByText('Areas per track').closest('li') as HTMLElement;
    expect(within(areas).getByText('Above the limit')).toBeVisible();
    expect(
      screen.getByRole('meter', {
        name: 'Releases per track (archived ones aside): 1 percent used',
      }),
    ).toBeVisible();
  });

  it('[CORE-026] raises a limit at once and gives guidance', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await screen.findByRole('form', {
      name: 'Change the limit: Releases per track (archived ones aside)',
    });
    const limit = within(form).getByLabelText('Limit');
    await user.clear(limit);
    await user.type(limit, '20000');
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    expect(
      await screen.findByText('Releases per track (archived ones aside) is limited to 20,000 now.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Raised limits take effect at once/)).toBeVisible();
    expect(client.calls).toEqual([{ name: 'releases_per_track', limit: 20_000 }]);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByText('Custom fields per track')).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const texts = visibleTexts(main).filter(
      (t) => !['SHOP', 'OPS'].includes(t) && !t.includes('Sam Rivera'),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
