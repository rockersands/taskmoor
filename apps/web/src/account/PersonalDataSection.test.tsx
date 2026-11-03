import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakePersonalDataClient, SIGNED_IN } from './fixtures';
import { PersonalDataSection } from './PersonalDataSection';

function renderSection(locale: 'en' | 'en-XA' = 'en') {
  const client = fakePersonalDataClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={SIGNED_IN}>
        <main>
          <PersonalDataSection client={client} timeZone="UTC" pollMs={0} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('a download of one’s own data (ASVS 8.3.2, ADR-111)', () => {
  it('[IAM-008] lists the downloads and offers the finished ones', async () => {
    renderSection();
    const section = screen.getByRole('region', { name: 'Your data' });
    const items = await within(section).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    const link = within(items[0] as HTMLElement).getByRole('link', {
      name: /Download the data asked for Nov 1, 2026/,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://taskmoor.example.com/api/v1/account/data-exports/7/download',
    );
    expect(within(items[0] as HTMLElement).getByText('Ready')).toBeVisible();
    expect(within(items[1] as HTMLElement).getByText('Expired')).toBeVisible();
    expect(within(items[1] as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('[IAM-008] asks for a download, says it is being prepared and offers it when ready', async () => {
    const client = renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Prepare a download' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/being prepared/);
    // The new download is ready after the next poll: until then only the older one is a link.
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /Download the data/ })).toHaveLength(2),
    );
    expect(client.calls).toContain('request');
  });

  it('[IAM-008] says why a download cannot be asked for', async () => {
    const client = {
      ...fakePersonalDataClient(),
      request: async () => {
        throw new ApiError(409, { error: 'export_in_progress' });
      },
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={SIGNED_IN}>
          <PersonalDataSection client={client} timeZone={null} pollMs={0} />
        </SessionProvider>
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Prepare a download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A download is already being prepared.',
    );
  });

  it('fits a small phone', async () => {
    setViewportWidth(360);
    renderSection();
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
  });

  it('passes every string through the pseudo-locale', async () => {
    renderSection('en-XA');
    await screen.findAllByRole('listitem');
    // Sizes are numbers in the locale's format, not messages.
    const texts = visibleTexts(screen.getByRole('main')).filter((t) => !/^[\d.,\s]+MB$/.test(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
