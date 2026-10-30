import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { ADMIN, MEMBER } from './fixtures';
import { NetworkAccessPage, parseEntries } from './NetworkAccessPage';
import { fakeNetworkClient, OFFICE_LIST } from './networkFixtures';

function renderPage(client = fakeNetworkClient(), locale: 'en' | 'en-XA' = 'en', session = ADMIN) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={session}>
        <NetworkAccessPage client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('network access page (M1-085)', () => {
  it('[IAM-015] reads one address or range per line, with a note after #', () => {
    expect(parseEntries(' 203.0.113.0/24 # Office \n\n2001:db8::1\n')).toEqual([
      { range: '203.0.113.0/24', note: 'Office' },
      { range: '2001:db8::1', note: '' },
    ]);
  });

  it('[IAM-015] turns the allowlist on with the office range and an exempt group', async () => {
    const { client } = renderPage();
    const entries = await screen.findByLabelText('Addresses and ranges');
    expect(screen.getByText(/which the list does not let in/)).toBeVisible();
    await userEvent.type(entries, '203.0.113.0/24 # Office');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only allow these addresses' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Travelling staff' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Allowlist saved.');
    expect(client.saved).toEqual([
      {
        enabled: true,
        exemptGroupIds: [4],
        entries: [{ range: '203.0.113.0/24', note: 'Office' }],
      },
    ]);
    expect(screen.getByText(/which the list lets in/)).toBeVisible();
  });

  it('[IAM-015] (2) asks before saving a list that locks the administrator out', async () => {
    const { client } = renderPage();
    await userEvent.type(await screen.findByLabelText('Addresses and ranges'), '192.0.2.0/24');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only allow these addresses' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('you would be locked out');
    expect(client.saved).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Save and lock me out' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Allowlist saved.');
    expect(client.saved[0]).toMatchObject({ confirmLockout: true });
  });

  it('[IAM-015] names the lines that are not addresses', async () => {
    renderPage(fakeNetworkClient(OFFICE_LIST));
    const entries = await screen.findByLabelText('Addresses and ranges');
    await userEvent.type(entries, '\nnot-an-address');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These lines are not an address or a range: 3.',
    );
    expect(entries).toHaveAttribute('aria-invalid', 'true');
  });

  it('[IAM-015] is for site administrators only', () => {
    renderPage(fakeNetworkClient(), 'en', MEMBER);
    expect(screen.getByText('Only site administrators change who may connect.')).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeNetworkClient(OFFICE_LIST), 'en-XA');
    await screen.findByRole('textbox');
    const data = ['Travelling staff', 'Contractors'];
    // The entries are data: addresses and notes as typed.
    const texts = visibleTexts(container).filter(
      (t) => !data.includes(t) && !t.includes('203.0.113.'),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('fits a small phone', async () => {
    setViewportWidth(360);
    renderPage(fakeNetworkClient(OFFICE_LIST));
    expect(await screen.findByRole('textbox')).toBeVisible();
  });
});
