import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { BulkOperationPage } from './BulkOperationPage';
import { FAILURES, fakeBulkClient, RUNNING } from './fixtures';

function openPage(operation = RUNNING) {
  const calls = stubBackend({
    'GET /bulk-operations/7': () => jsonResponse(200, { bulkOperation: operation }),
    'GET /bulk-operations/7/items?outcome=failed&limit=100': () =>
      jsonResponse(200, { items: FAILURES, next: null }),
    'POST /bulk-operations/7/cancel': () =>
      jsonResponse(202, { bulkOperation: { ...operation, cancelRequested: true } }),
  });
  window.location.hash = '#/bulk/7';
  render(<App session={MEMBER} />);
  return calls;
}

describe('bulk operation progress (M1-021)', () => {
  it('[CORE-024] shows how far a bulk change got and why tickets were not changed', async () => {
    openPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bulk edit of 1,200 tickets' }),
    ).toBeVisible();
    expect(
      screen.getByRole('progressbar', { name: '643 of 1,200 tickets finished' }),
    ).toHaveAttribute('value', '643');
    const failures = await screen.findByRole('region', { name: 'Tickets that were not changed' });
    // The region shows before its items, which come from a request of their own.
    const items = await within(failures).findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'SHOP-12In status Approved, only the Approvers group can edit this ticket.',
      'SHOP-19You may not make this change to this ticket.',
      'OLD-3Not found, or you may not see it.',
    ]);
    expect(within(failures).getByRole('link', { name: 'SHOP-12' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-12',
    );
  });

  it('[CORE-024] cancels the rest of a running bulk change', async () => {
    const user = userEvent.setup();
    const calls = openPage();
    await user.click(await screen.findByRole('button', { name: 'Cancel the rest' }));
    expect(await screen.findByText('Cancelling after the tickets in hand.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel the rest' })).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/bulk-operations/7/cancel')).toBe(
      true,
    );
  });

  it('[CORE-024] follows progress until the bulk change is done', async () => {
    const client = fakeBulkClient({ ...RUNNING, failed: 0 }, { step: 300, failures: [] });
    render(
      <I18nProvider locale="en">
        <BulkOperationPage id="7" client={client} pollMs={5} />
      </I18nProvider>,
    );
    expect(await screen.findByText('Done.')).toBeVisible();
    expect(
      screen.getByRole('progressbar', { name: '1,200 of 1,200 tickets finished' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel the rest' })).toBeNull();
  });

  it('[CORE-024] ends a bulk change with failures in a warning, not Done (PL-23, D14)', async () => {
    const client = fakeBulkClient(
      { ...RUNNING, succeeded: 1197, pending: 2, failed: 1 },
      { step: 300 },
    );
    render(
      <I18nProvider locale="en">
        <BulkOperationPage id="7" client={client} pollMs={5} />
      </I18nProvider>,
    );
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(
      'The bulk edit finished with problems: 1,199 tickets were changed, and 1 ticket was not. The list below gives the reasons.',
    );
    expect(warning).toHaveClass('bulk-warning');
    expect(screen.queryByText('Done.')).toBeNull();
    // Each failed ticket, with its reason.
    const failures = screen.getByRole('region', { name: 'Tickets that were not changed' });
    expect(within(failures).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('[CORE-024] a cancelled bulk change with failures says how many were changed, failed and skipped (PL-23)', async () => {
    const client = fakeBulkClient({
      ...RUNNING,
      status: 'cancelled',
      cancelRequested: true,
      succeeded: 640,
      failed: 3,
      skipped: 557,
      pending: 0,
    });
    render(
      <I18nProvider locale="en">
        <BulkOperationPage id="7" client={client} pollMs={5} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The bulk edit was cancelled with problems: 640 tickets were changed, 3 tickets were not, and 557 tickets were skipped. The list below gives the reasons.',
    );
    // The same in Spanish.
    cleanup();
    render(
      <I18nProvider locale="es">
        <BulkOperationPage id="7" client={client} pollMs={5} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La edición masiva se canceló con problemas: se cambiaron 640 tickets, 3 tickets no y se omitieron 557 tickets. En la lista de abajo tienes los motivos.',
    );
  });

  it('[CORE-024] says so when the bulk change is not there', async () => {
    stubBackend({ 'GET /bulk-operations/8': () => jsonResponse(404, { error: 'not_found' }) });
    window.location.hash = '#/bulk/8';
    render(<App session={MEMBER} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This bulk change does not exist, or it is not yours to see.',
    );
  });

  it('[CORE-024] fits a small phone', async () => {
    setViewportWidth(375);
    openPage();
    expect(await screen.findByRole('button', { name: 'Cancel the rest' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    stubBackend({
      'GET /bulk-operations/7': () => jsonResponse(200, { bulkOperation: RUNNING }),
      'GET /bulk-operations/7/items?outcome=failed&limit=100': () =>
        jsonResponse(200, { items: FAILURES, next: null }),
    });
    window.location.hash = '#/bulk/7';
    const errors: Error[] = [];
    render(<App session={MEMBER} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    // Ticket keys and counts are data, not strings to translate.
    const texts = visibleTexts(main).filter((t) => !/^([A-Z]+-\d+|[\d,]+)$/.test(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
