import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { ApiUsagePage } from './ApiUsagePage';
import { BUSY_HOUR, fakeApiUsageClient, LIMITS } from './apiUsageFixtures';
import { ADMIN, MEMBER } from './fixtures';

function renderPage(client = fakeApiUsageClient(), locale: 'en' | 'en-XA' = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={ADMIN}>
        <ApiUsagePage client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { errors, container: view.container, client };
}

describe('API usage page (M1-066)', () => {
  it('[API-010] (2) lists the busiest clients per token, person and address', async () => {
    renderPage(fakeApiUsageClient({ hour: BUSY_HOUR, day: [BUSY_HOUR[1] as never] }));
    const table = await screen.findByRole('table', { name: 'Busiest clients in the last hour' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Nightly sync (token of Grace Hopper)18,24031229' + '0',
      'Ada Lovelace1,20420',
      'Address 203.0.113.996960',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Last day' }));
    const day = await screen.findByRole('table', { name: 'Busiest clients in the last day' });
    expect(within(day).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Last day' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('[API-010] says when nothing called the API', async () => {
    renderPage(fakeApiUsageClient({ hour: [], day: [] }));
    expect(await screen.findByText('No API requests in this period.')).toBeVisible();
  });

  it('[API-010] changes the workspace limits', async () => {
    const { client } = renderPage();
    const tokens = await screen.findByRole('group', { name: 'API tokens' });
    const rate = within(tokens).getByRole('spinbutton', { name: 'Requests a second' });
    await userEvent.clear(rate);
    await userEvent.type(rate, '80');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Limits saved.');
    expect(client.saved).toEqual([{ ...LIMITS, token: { rate: 80, burst: 200 } }]);
  });

  it('[API-010] is for site administrators only', async () => {
    window.location.hash = '#/admin/api-usage';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(403, { error: 'forbidden' })),
    );
    render(<App session={MEMBER} />);
    expect(
      await screen.findByText('Only site administrators see API usage and change rate limits.'),
    ).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeApiUsageClient(), 'en-XA');
    await screen.findByRole('table');
    await screen.findAllByRole('group');
    const data = ['Nightly sync', 'Grace Hopper', 'Ada Lovelace', '203.0.113.9'];
    const texts = visibleTexts(container).filter(
      (t) => !/^[\d,.]+$/.test(t) && !data.some((d) => t.includes(d)),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('[API-010] shows one block per client on a phone, its figures beneath its name (D19, AD-3)', async () => {
    setViewportWidth(360);
    renderPage(fakeApiUsageClient({ hour: BUSY_HOUR, day: [] }));
    const list = await screen.findByRole('list', { name: 'Busiest clients in the last hour' });
    expect(screen.queryByRole('table')).toBeNull();
    const [first] = within(list).getAllByRole('listitem');
    expect(
      within(first as HTMLElement).getByText('Nightly sync (token of Grace Hopper)'),
    ).toBeVisible();
    expect(within(first as HTMLElement).getByText('Refused by the limits')).toBeVisible();
    expect(within(first as HTMLElement).getByText('18,240')).toBeVisible();
  });

  it('[API-010] lets the keyboard reach the table when it scrolls sideways (AD-3)', async () => {
    renderPage(fakeApiUsageClient({ hour: BUSY_HOUR, day: [] }));
    const table = await screen.findByRole('table', { name: 'Busiest clients in the last hour' });
    const scroller = screen.getByRole('region', { name: 'Busiest clients in the last hour' });
    expect(scroller).toContainElement(table);
    expect(scroller).toHaveAttribute('tabindex', '0');
  });
});
