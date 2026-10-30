import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { fakeReleaseClient } from './fixtures';
import { ReleasePage } from './ReleasePage';

function renderRelease(releaseId = 2, client = fakeReleaseClient({ approver: true })) {
  render(
    <I18nProvider locale="en">
      <ReleasePage
        releaseId={releaseId}
        client={client}
        now={() => new Date('2026-10-30T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}
const section = (name: string) => within(screen.getByRole('region', { name }));
const searchOf = (href: string | null) => new URLSearchParams(href?.split('?')[1]).get('q');

describe('a release’s page (M1-050)', () => {
  it('[CORE-016] shows the tickets by stage, each number opening the search that finds them', async () => {
    renderRelease();
    expect(await screen.findByRole('heading', { name: 'Checkout 2.0' })).toBeVisible();
    const progress = section('Progress');
    const closed = progress.getByRole('link', { name: 'Closed 1, open the search' });
    expect(searchOf(closed.getAttribute('href'))).toBe('targetRelease = 2 AND stage = closed');
    expect(progress.getByRole('link', { name: 'New 2, open the search' })).toBeVisible();
    const warnings = section('Warnings');
    expect(
      warnings.getByText('3 tickets are still open and the release date has passed.'),
    ).toBeVisible();
    expect(
      searchOf(warnings.getByRole('link', { name: 'Show these tickets' }).getAttribute('href')),
    ).toBe('targetRelease = 2 AND stage != closed');
    expect(warnings.getByText('1 approval is still to come.')).toBeVisible();
    const rows = section('Tickets').getAllByRole('row');
    expect(rows.map((r) => within(r).queryByRole('link')?.textContent ?? null)).toEqual([
      null,
      'CHK-21',
      'CHK-22',
      'CHK-23',
      'CHK-24',
    ]);
    expect(within(rows[3] as HTMLElement).getByText('Unassigned')).toBeVisible();
  });

  it('[CORE-016] ships only once approved, moving the open tickets to the next release', async () => {
    const user = userEvent.setup();
    const client = renderRelease();
    await screen.findByRole('heading', { name: 'Checkout 2.0' });
    const shipping = section('Shipping');
    await user.click(shipping.getByRole('button', { name: 'Ship this release…' }));
    expect(shipping.getByLabelText('Ship on')).toHaveValue('2026-10-30');
    await user.click(await shipping.findByRole('radio', { name: 'Move them to 2.1' }));
    await user.click(shipping.getByRole('button', { name: 'Ship 2.0' }));
    expect(await shipping.findByRole('alert')).toHaveTextContent('Every approver must approve');
    // The approver approves on the same page.
    const approvals = section('Approvals');
    await user.type(approvals.getByRole('textbox', { name: 'Comment (optional)' }), 'Go');
    await user.click(approvals.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approvals.getByText('Approved')).toBeVisible());
    expect(screen.getByRole('status')).toHaveTextContent('You approved this release.');
    await user.click(shipping.getByRole('button', { name: 'Ship 2.0' }));
    await waitFor(() =>
      expect(screen.getByText('Shipped', { selector: '.release-state' })).toBeVisible(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('2.0 shipped.');
    expect(client.releases().find((r) => r.name === '2.1')?.progress.open).toBe(4);
    expect(screen.queryByRole('region', { name: 'Shipping' })).toBeNull();
  });

  it('[CORE-016] shows the generated notes, to copy as Markdown or download', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRelease(1);
    const notes = within(await screen.findByRole('region', { name: 'Release notes' }));
    expect(await notes.findByRole('heading', { name: 'Feature', level: 3 })).toBeVisible();
    expect(notes.getByRole('link', { name: 'CHK-26' }).closest('li')).toHaveTextContent(
      'CHK-26 Totals off by a cent',
    );
    expect(notes.getByText('Left out (closed without being done): Duplicate (1).')).toBeVisible();
    await user.click(notes.getByRole('button', { name: 'Copy as Markdown' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## Bug\n\n- CHK-26'));
    expect(await screen.findByText('Release notes copied.')).toBeVisible();
    expect(notes.getByRole('link', { name: 'Download Markdown' })).toHaveAttribute(
      'href',
      '/api/v1/releases/1/notes?format=markdown',
    );
    // Shipped: no shipping section, the day it shipped.
    expect(screen.queryByRole('region', { name: 'Shipping' })).toBeNull();
    expect(screen.getByText('Shipped on').nextElementSibling).toHaveTextContent('2026-10-01');
  });

  it('[CORE-016] fits a phone: nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderRelease();
    await screen.findByRole('heading', { name: 'Checkout 2.0' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
