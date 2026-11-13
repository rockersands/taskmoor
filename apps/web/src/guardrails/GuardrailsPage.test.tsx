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
import { GuardrailsPage, parseLimit } from './GuardrailsPage';

function renderPage(locale: Locale = 'en', client = fakeGuardrailsClient()) {
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

  it('[CORE-026] says which limits were saved when one fails partway, and keeps what was typed', async () => {
    const user = userEvent.setup();
    const client = fakeGuardrailsClient();
    const set = client.set;
    client.set = async (name, limit) => {
      if (name === 'releases_per_track') throw new Error('offline');
      await set(name, limit);
    };
    renderPage('en', client);
    const form = await screen.findByRole('form', { name: 'Limits' });
    const type = async (label: string, value: string) => {
      const field = within(form).getByLabelText(`Limit: ${label}`);
      await user.clear(field);
      await user.type(field, value);
      return field;
    };
    const fields = await type('Custom fields per track', '800');
    const releases = await type('Releases per track (archived ones aside)', '16,000');
    const options = await type('Options per field', '25,000');
    const save = within(form).getByRole('button', { name: 'Save the limits' });
    await user.click(save);
    // The second of three failed: the first and third are saved and named, the second is named
    // as not saved, and every field keeps what was typed.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: Releases per track (archived ones aside). Try again in a moment',
    );
    expect(
      screen.getByText('Saved: Custom fields per track and Options per field.'),
    ).toHaveAttribute('role', 'status');
    expect(client.calls).toEqual([
      { name: 'fields_per_track', limit: 800 },
      { name: 'options_per_field', limit: 25_000 },
    ]);
    expect(fields).toHaveValue('800');
    expect(releases).toHaveValue('16,000');
    expect(options).toHaveValue('25,000');
    // The form is the same one: the focus stays on Save.
    expect(within(form).getByRole('button', { name: 'Save the limits' })).toHaveFocus();
    expect(screen.getByRole('form', { name: 'Limits' })).toBe(form);

    // Saving again sends only what is still unsaved and clears the old messages.
    client.set = set;
    await user.click(save);
    expect(await screen.findByText(/is limited to 16,000 now/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ name: 'releases_per_track', limit: 16_000 });
    expect(save).toHaveFocus();
  });

  it("[CORE-026] reads only the locale's group separator and refuses a decimal", () => {
    expect(parseLimit('20,000', 'en')).toBe(20_000);
    expect(parseLimit(' 20000 ', 'en')).toBe(20_000);
    expect(parseLimit('1.5', 'en')).toBeNull();
    expect(parseLimit('20.000', 'en')).toBeNull();
    expect(parseLimit('20.000', 'es')).toBe(20_000);
    expect(parseLimit('1,5', 'es')).toBeNull();
    // Where the separator is a space, an ordinary one will do.
    expect(parseLimit('20 000', 'fr')).toBe(20_000);
    expect(parseLimit('20,5', 'fr')).toBeNull();
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
