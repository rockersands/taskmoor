import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { type HeldRun, ScheduleResult } from './ScheduleResult';
import { scheduleRunFixture } from './scheduleResultFixture';
import { scheduleLookup } from './scheduleWords';

function show(run: HeldRun = scheduleRunFixture(), onRunAgain?: () => void) {
  return render(
    <I18nProvider locale="en">
      <ScheduleResult
        run={run}
        unit="points"
        names={scheduleLookup(run.result)}
        compareHref="#/plans/12/scenarios?scenario=2&a=1&b=2"
        compareWith="main"
        onRunAgain={onRunAgain}
      />
    </I18nProvider>,
  );
}

describe('the result of an auto-schedule run (PLN-004)', () => {
  it('[PLN-004] says its counts in words and takes the focus once', () => {
    const run = scheduleRunFixture();
    const { unmount } = show(run);
    const heading = screen.getByRole('heading', { name: 'Auto-schedule' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Auto-schedule' })).toBeVisible();
    expect(
      screen.getByText(
        '2 placed, 1 kept, 2 not placed, 1 earlier proposal removed. 1 of your drafts stays.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Into Faster. 1 ticket was left out. 1 earlier proposal stays on tickets this plan does not show you.',
      ),
    ).toBeVisible();
    unmount();
    // Back on the tab later: the same run does not take the focus again.
    show(run);
    expect(screen.getByRole('heading', { name: 'Auto-schedule' })).not.toHaveFocus();
  });

  it('[PLN-004] lists the tickets not placed first, and filters by Placed, Not placed and Kept with their reasons', async () => {
    show();
    const notPlaced = screen.getByRole('button', { name: 'Not placed (2)' });
    expect(notPlaced).toHaveAttribute('aria-pressed', 'true');
    let list = screen.getByRole('list', { name: 'Tickets Not placed (2)' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByRole('link', { name: 'SHOP-5 Gift wrapping' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-5',
    );
    expect(within(list).getByText('Not placed: no estimate.')).toBeVisible();
    expect(
      within(list).getByText('Not placed: waits on a ticket this plan does not show you.'),
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Placed (2)' }));
    expect(screen.getByRole('button', { name: 'Placed (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(notPlaced).toHaveAttribute('aria-pressed', 'false');
    list = screen.getByRole('list', { name: 'Tickets Placed (2)' });
    expect(
      within(list).getByText(
        'Placed in Nov 9 to Nov 20: Atlas had 8 of 20 points free after 4 higher-ranked tickets.',
      ),
    ).toBeVisible();
    // A blocker listed by the run is named by its key; a warning is in words after "Note:".
    expect(
      within(list).getByText('Starts Nov 21, the day after SHOP-2 ends; SHOP-2 blocks it.'),
    ).toBeVisible();
    expect(
      within(list).getByText('Note: due 9 days after its release 2.1 (Nov 25).'),
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Kept (1)' }));
    list = screen.getByRole('list', { name: 'Tickets Kept (1)' });
    expect(within(list).getByRole('link', { name: 'OPS-4 Warehouse sync' })).toBeVisible();
    expect(within(list).getByText('Kept: your draft in this scenario.')).toBeVisible();
  });

  it('[PLN-004] [PLN-003] compares with main, runs again and says its choices in sentences', async () => {
    const again = vi.fn();
    show(scheduleRunFixture(), again);
    expect(screen.getByRole('link', { name: 'Compare with main' })).toHaveAttribute(
      'href',
      '#/plans/12/scenarios?scenario=2&a=1&b=2',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Run again…' }));
    expect(again).toHaveBeenCalledTimes(1);
    const choices = screen.getByRole('button', { name: 'Its choices' });
    expect(choices).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/^From Nov 9, 3 periods\./)).not.toBeVisible();
    await userEvent.click(choices);
    expect(choices).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('From Nov 9, 3 periods. Tickets in progress kept. Bug left out.'),
    ).toBeVisible();
  });

  it('[PLN-004] offers no Run again to a reader who may not run it, and says when a filter is empty or the list is cut', async () => {
    const run = scheduleRunFixture({ more: 3 });
    run.result.tickets = run.result.tickets.filter((x) => x.outcome !== 'kept');
    show(run);
    expect(screen.queryByRole('button', { name: 'Run again…' })).toBeNull();
    expect(screen.getByText('3 more tickets are counted but not listed.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Kept (1)' }));
    expect(screen.getByText('No tickets here.')).toBeVisible();
  });

  it('[PLN-004] says tickets that changed while it ran, and a scenario it made', () => {
    show(
      scheduleRunFixture({
        created: true,
        scenario: { id: 5, name: 'Auto-schedule 14 Nov', main: true, version: 1 },
        counts: { ...scheduleRunFixture().result.counts, changedMeanwhile: 2, notShown: 0 },
      }),
    );
    expect(screen.getByText('2 tickets changed while the run worked; run again.')).toBeVisible();
    expect(
      screen.getByText('Into Auto-schedule 14 Nov, a new scenario. 1 ticket was left out.'),
    ).toBeVisible();
  });
});
