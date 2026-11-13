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

  it('[CORE-026] raises a limit at once and gives guidance, with one Save for the page (D20)', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await screen.findByRole('form', { name: 'Limits' });
    // One Save for the whole page, not one per limit (AD-32).
    expect(within(form).getAllByRole('button')).toHaveLength(1);
    const limit = within(form).getByLabelText('Limit: Releases per track (archived ones aside)');
    // The limit keeps the separators of the text beside it.
    expect(limit).toHaveValue('15,000');
    await user.clear(limit);
    await user.type(limit, '20,000');
    await user.click(within(form).getByRole('button', { name: 'Save the limits' }));
    expect(
      await screen.findByText('Releases per track (archived ones aside) is limited to 20,000 now.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Raised limits take effect at once/)).toBeVisible();
    expect(client.calls).toEqual([{ name: 'releases_per_track', limit: 20_000 }]);
  });

  it('[CORE-026] saves every changed limit together and refuses a limit that is not a number', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await screen.findByRole('form', { name: 'Limits' });
    const fields = within(form).getByLabelText('Limit: Custom fields per track');
    const options = within(form).getByLabelText('Limit: Options per field');
    await user.clear(fields);
    await user.type(fields, 'many');
    await user.click(within(form).getByRole('button', { name: 'Save the limits' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Each limit is a whole number from 1 to 1,000,000.',
    );
    expect(fields).toHaveAttribute('aria-invalid', 'true');
    expect(client.calls).toEqual([]);
    await user.clear(fields);
    await user.type(fields, '800');
    await user.clear(options);
    await user.type(options, '15000');
    await user.click(within(form).getByRole('button', { name: 'Save the limits' }));
    expect(await screen.findByText('2 limits were saved.')).toBeInTheDocument();
    expect(client.calls).toEqual([
      { name: 'fields_per_track', limit: 800 },
      { name: 'options_per_field', limit: 15_000 },
    ]);
  });

  it('[CORE-026] names a permission and a bulk change by their words, not their codes (AD-32)', async () => {
    const client = fakeGuardrailsClient();
    const list = client.list;
    client.list = async () => {
      const answer = await list();
      return {
        ...answer,
        guardrails: [
          {
            name: 'grants_per_permission',
            limit: 50,
            default: 50,
            usage: {
              value: 4,
              where: { kind: 'access_policy', id: 1, name: 'Default access policy: browse_track' },
            },
          },
          {
            name: 'tickets_per_bulk_operation',
            limit: 10_000,
            default: 10_000,
            usage: { value: 2, where: { kind: 'bulk_operation', id: 3, name: 'edit' } },
          },
        ],
      };
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <GuardrailsPage client={client} storage={fakeStorageClient()} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      await screen.findByText('Most used: 4 of 50 in Default access policy, for “See the track”'),
    ).toBeVisible();
    expect(screen.getByText('Most used: 2 of 10,000 tickets in one bulk edit')).toBeVisible();
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
