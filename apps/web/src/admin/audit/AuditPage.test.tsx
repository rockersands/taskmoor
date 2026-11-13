import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { SessionProvider } from '../../session/SessionProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { ADMIN, MEMBER } from '../fixtures';
import { AuditPage } from './AuditPage';
import { filterParams } from './client';
import { fakeAuditClient, RECORDS } from './fixtures';

function renderPage(client = fakeAuditClient(), locale: 'en' | 'en-XA' = 'en', session = ADMIN) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={session}>
        <AuditPage client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('audit log page (M1-085)', () => {
  it('[IAM-013] lists records newest first and filters them by action', async () => {
    const { client } = renderPage();
    const table = await screen.findByRole('table', { name: 'Audit records, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Action codes read as words at every width (D19, AD-2), subjects by their kind's name.
    expect(rows.map((r) => within(r).getAllByRole('cell')[2]?.textContent)).toEqual([
      'API token created',
      'Person signed in',
      'Backup completed',
    ]);
    expect(rows.map((r) => within(r).getAllByRole('cell')[3]?.textContent)).toEqual([
      'API token 7',
      'Person 1',
      '',
    ]);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[0]).toHaveClass('audit-when');
    expect(within(rows[2] as HTMLElement).getByText('Taskmoor')).toBeVisible();
    // The action is picked in words and sent as its code: every event about a person (AD-2).
    expect(screen.queryByRole('combobox', { name: 'What happened' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Action about' }), 'Person');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await expect.poll(() => within(screen.getByRole('table')).getAllByRole('row').length).toBe(2);
    expect(client.calls.at(-1)).toContain('"action":"user."');
    // The downloads take the filter in force.
    expect(screen.getByRole('link', { name: 'Download as CSV' }).getAttribute('href')).toBe(
      '/api/v1/audit/export?format=csv&action=user.',
    );
    // Then one kind of event about it.
    const happened = screen.getByRole('combobox', { name: 'What happened' });
    expect(within(happened).getByRole('option', { name: 'Signed in' })).toBeInTheDocument();
    await userEvent.selectOptions(happened, 'Signed in');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await expect.poll(() => client.calls.at(-1)).toContain('"action":"user.signed_in"');
    // Back to anything: no action filter at all.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Action about' }),
      'Anything',
    );
    expect(screen.queryByRole('combobox', { name: 'What happened' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await expect.poll(() => client.calls.at(-1)).not.toContain('"action"');
  });

  it('[IAM-013] scrolls a table too wide for a tablet in a named region the keyboard reaches (AD-3)', async () => {
    setViewportWidth(900);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Audit records, newest first' });
    const scroller = screen.getByRole('region', { name: 'Audit records, newest first' });
    expect(scroller).toContainElement(table);
    expect(scroller).toHaveAttribute('tabindex', '0');
  });

  it('[IAM-013] pages back through older records', async () => {
    renderPage(fakeAuditClient({ pageSize: 2 }));
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Show older records' }));
    await expect
      .poll(() => within(screen.getByRole('table')).getAllByRole('row').length)
      .toBe(RECORDS.length + 1);
    expect(screen.queryByRole('button', { name: 'Show older records' })).toBeNull();
  });

  it('[IAM-013] (1) checks the hash chain and says where it breaks', async () => {
    renderPage(fakeAuditClient({ brokenAt: 2 }));
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Check the chain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('broken at record 2');
  });

  it('[IAM-013] names a syslog receiver and sends it a test message', async () => {
    const { client } = renderPage();
    await screen.findByRole('table');
    const form = screen.getByRole('form', { name: 'Forward to syslog' });
    await userEvent.type(within(form).getByLabelText('Host'), 'siem.example.com');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Forward new records' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save forwarding' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Forwarding saved.');
    expect(await client.syslog()).toMatchObject({ host: 'siem.example.com', enabled: true });
    await userEvent.click(within(form).getByRole('button', { name: 'Send a test message' }));
    expect(await within(form).findByText('The receiver accepted the test message.')).toBeVisible();
  });

  it('[IAM-013] (2) keeps records for the months chosen', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Keep records for' });
    await expect.poll(() => (select as HTMLSelectElement).value).toBe('12');
    await userEvent.selectOptions(select, '84');
    expect(await screen.findByText('Retention saved.')).toBeVisible();
  });

  it('[IAM-013] turns a day filter into a half-open range', () => {
    expect(
      filterParams({ from: '2026-10-01', to: '2026-10-31', action: ' user. ' }).toString(),
    ).toBe('from=2026-10-01&to=2026-11-01&action=user.');
  });

  it('[IAM-013] is for site administrators only', () => {
    renderPage(fakeAuditClient(), 'en', MEMBER);
    expect(screen.getByText('Only site administrators read the audit log.')).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeAuditClient(), 'en-XA');
    await screen.findByRole('table');
    // Names and addresses: no action reads as its code.
    const data = ['Ada Lovelace', '203.0.113.5'];
    const texts = visibleTexts(container).filter(
      (t) => !/\d{4}|\d:\d\d/.test(t) && !data.includes(t),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('[IAM-013] shows one block per record on a phone: when, who, what, then about and from (D19, AD-1)', async () => {
    setViewportWidth(360);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Audit records, newest first' });
    expect(screen.queryByRole('table')).toBeNull();
    const [first, , last] = within(list).getAllByRole('listitem');
    expect(within(first as HTMLElement).getByText('Ada Lovelace')).toBeVisible();
    expect(within(first as HTMLElement).getByText('API token created')).toBeVisible();
    expect(within(first as HTMLElement).getByText('About: API token 7')).toBeVisible();
    expect(within(first as HTMLElement).getByText('From 203.0.113.5')).toBeVisible();
    expect(within(last as HTMLElement).getByText('Taskmoor')).toBeVisible();
    expect(within(last as HTMLElement).queryByText(/About:/)).toBeNull();
  });

  it('[IAM-013] words every action it knows, in Spanish too, and shows an unknown code as it is', async () => {
    const records = [
      {
        ...RECORDS[0],
        seq: 2,
        action: 'ticket_template.created',
        subject: { type: 'layout_set', id: '2' },
      },
      {
        ...RECORDS[0],
        seq: 1,
        action: 'brand_new.thing_done',
        subject: { type: 'gadget', id: '3' },
      },
    ] as typeof RECORDS;
    render(
      <I18nProvider locale="es">
        <SessionProvider session={ADMIN}>
          <AuditPage client={fakeAuditClient({ records })} />
        </SessionProvider>
      </I18nProvider>,
    );
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[2]?.textContent)).toEqual([
      'Plantilla de ticket: creación',
      'brand_new.thing_done',
    ]);
    expect(rows.map((r) => within(r).getAllByRole('cell')[3]?.textContent)).toEqual([
      'Conjunto de diseños 2',
      'gadget 3',
    ]);
  });
});
