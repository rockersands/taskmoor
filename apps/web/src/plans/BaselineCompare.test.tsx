import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useT } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { BaselineCompare } from './BaselineCompare';
import type { BaselineRow } from './baselineClient';
import { baselineCsv } from './baselineExport';
import { type FakeBaselineOptions, fakeBaselineClient } from './baselineFixtures';

const KICK_OFF: BaselineRow = {
  id: 1,
  name: 'Kick-off',
  source: 'live',
  scenarioName: null,
  tickets: 6,
  createdAt: '2026-11-01T09:00:00Z',
  createdBy: { id: 7, name: 'Ana Ruiz' },
  version: 1,
};

/**
 * "Kick-off" against the days now (T-089a; PLN-011; ADR-122 stage 9): SHOP-2 ends 14 days later,
 * SHOP-1 9, OPS-5 (closed) 3; OPS-4 3 days earlier; SHOP-3 the same; WEB-6 not in it; WEB-7
 * without days then. The plan's end moves from 1 to 4 December.
 */
function renderCompare(
  options: FakeBaselineOptions = {},
  client: ReturnType<typeof fakeBaselineClient> = fakeBaselineClient(options),
) {
  render(
    <I18nProvider locale="en">
      <BaselineCompare
        planId={12}
        planName="Spring launch"
        client={client}
        baseline={KICK_OFF}
        filters={{}}
        closeHref="#/plans/12/baselines"
      />
    </I18nProvider>,
  );
  return client;
}

afterEach(() => {
  act(() => setViewportWidth(1440));
});

describe('a baseline compared with the days now (PLN-011)', () => {
  it('[PLN-011] says first, in one sentence, what ends later, by how much, and the plan’s end', async () => {
    renderCompare({ notShown: 4 });
    expect(
      await screen.findByText(
        '3 tickets end later than in Kick-off, by up to 14 days; 1 earlier; 1 the same. The plan ends 3 days later (Dec 4, was Dec 1). 4 tickets in this baseline are not shown to you.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        '1 not in the baseline; 1 without days then; 0 without days now. A ticket not in the baseline was added to the plan since, or was not shown to whoever captured it.',
      ),
    ).toBeVisible();
    // Later by default, the largest delay first, each in words.
    const list = screen.getByRole('list', { name: 'Tickets: Later (3)' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'SHOP-2 Payment form14 days later: due Dec 4, was Nov 20',
      'SHOP-1 Checkout page9 days later: due Nov 21, was Nov 12',
      'OPS-5 Runbook3 days later: due Nov 13, was Nov 10 (closed)',
    ]);
    expect(within(list).getByRole('link', { name: 'SHOP-2 Payment form' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-2',
    );
  });

  it('[PLN-011] filters by Later, Earlier, Not in the baseline and All, pressed in turn', async () => {
    const user = userEvent.setup();
    renderCompare();
    const later = await screen.findByRole('button', { name: 'Later (3)' });
    expect(later).toHaveAttribute('aria-pressed', 'true');
    const earlier = screen.getByRole('button', { name: 'Earlier (1)' });
    await user.click(earlier);
    // The pressed button stays where it is while its list is read, and keeps focus.
    expect(earlier).toHaveAttribute('aria-pressed', 'true');
    expect(earlier).toHaveFocus();
    expect(await screen.findByText('3 days earlier: due Nov 28, was Dec 1')).toBeVisible();
    expect(earlier).toHaveFocus();
    // Never "added since": a ticket without a row may also have been hidden from the capturer.
    await user.click(screen.getByRole('button', { name: 'Not in the baseline (1)' }));
    expect(await screen.findByText('Not in the baseline: due Dec 10')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'All' }));
    const all = await screen.findByRole('list', { name: 'Tickets: All' });
    expect(within(all).getAllByRole('listitem')).toHaveLength(7);
    expect(within(all).getByText('Same end: due Nov 25')).toBeVisible();
    expect(within(all).getByText('No days then; now due Dec 2')).toBeVisible();
  });

  it('[PLN-011] reads more a page at a time', async () => {
    const user = userEvent.setup();
    const client = renderCompare({ page: 2 });
    const list = await screen.findByRole('list', { name: 'Tickets: Later (3)' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText(/^3 days later/)).toBeVisible();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    // The button went with the last page: its first ticket takes focus, not the page.
    expect(within(list).getByRole('link', { name: 'OPS-5 Runbook' })).toHaveFocus();
    expect(client.asked.map((a) => a.after ?? null)).toEqual([null, '2']);
  });

  it('[PLN-011] keeps focus on Download CSV while it reads every page, and saves once', async () => {
    const user = userEvent.setup();
    const client = fakeBaselineClient({ page: 2 });
    const read = client.compare.bind(client);
    let release = () => {};
    // The file's second page waits until released, so the button is seen while it reads.
    client.compare = (planId, id, query) => {
      const answer = read(planId, id, query);
      return query.after
        ? new Promise((resolve) => {
            release = () => resolve(answer);
          })
        : answer;
    };
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:baseline';
    });
    URL.revokeObjectURL = vi.fn();
    try {
      renderCompare({}, client);
      await screen.findByRole('list', { name: 'Tickets: Later (3)' });
      const download = screen.getByRole('button', { name: 'Download CSV' });
      download.focus();
      await user.keyboard('{Enter}');
      // Off, yet focusable: a second press reads nothing more.
      await waitFor(() => expect(download).toHaveAttribute('aria-disabled', 'true'));
      expect(download).not.toBeDisabled();
      expect(download).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(client.asked.filter((a) => a.after)).toHaveLength(1);
      release();
      await waitFor(() => expect(download).not.toHaveAttribute('aria-disabled'));
      expect(download).toHaveFocus();
      expect(saved).toHaveLength(1);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
  });

  it('[PLN-011] stays a list on a phone, never a table', async () => {
    act(() => setViewportWidth(360));
    renderCompare();
    expect(await screen.findByRole('list', { name: 'Tickets: Later (3)' })).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('[PLN-011] says so when the comparison cannot be read', async () => {
    renderCompare({ failCompare: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The comparison could not be read. Try again in a moment.',
    );
  });

  it('[PLN-011] writes the file through the shared CSV rule: the baseline, then a ticket a row', async () => {
    const client = fakeBaselineClient({ notShown: 2 });
    const data = await client.compare(12, 1, { filters: {}, show: 'all' });
    let text = '';
    function Probe() {
      const t = useT();
      text = baselineCsv(t, 'Kick-off', data.tickets, data.counts.notShown);
      return null;
    }
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    const lines = text.replace(/^﻿/, '').split('\r\n');
    expect(lines.slice(0, 4)).toEqual([
      'Baseline: Kick-off',
      '2 tickets in this baseline are not shown to you.',
      'Key,Summary,Closed,Start then,Due then,Days then from,Start now,Due now,Days now from,Delay (days),Start moved (days)',
      'SHOP-2,Payment form,No,2026-11-09,2026-11-20,Its own days,2026-11-16,2026-12-04,Its own days,14,7',
    ]);
    expect(lines).toContain('WEB-6,Landing copy,No,,,,,2026-12-10,Its own days,,');
  });
});
