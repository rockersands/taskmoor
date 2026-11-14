import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { type HeldRun, ScheduleResult } from './ScheduleResult';
import { evenOutRunFixture, scheduleRunFixture } from './scheduleResultFixture';
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
        '2 placed, 1 kept, 2 not placed, 1 earlier proposal removed. 1 draft a person made stays.',
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
    expect(
      within(list).getByText('Kept: a person drafted its days in this scenario.'),
    ).toBeVisible();
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

  it('[PLN-004] says tickets that changed while it ran, and a scenario it made', async () => {
    const run = scheduleRunFixture({
      created: true,
      scenario: { id: 5, name: 'Auto-schedule 14 Nov', main: true, version: 1 },
      counts: {
        ...scheduleRunFixture().result.counts,
        placed: 1,
        changedMeanwhile: 1,
        notShown: 0,
      },
    });
    // SHOP-2 changed while the run worked: nothing was written for it, so it is not placed.
    run.result.tickets = run.result.tickets.map((x) =>
      x.key === 'SHOP-2' ? { ...x, changedMeanwhile: true } : x,
    );
    show(run);
    expect(
      screen.getByText(
        '1 ticket was left as it was: it or a ticket blocking it changed while the run worked. Run again.',
      ),
    ).toBeVisible();
    const apart = screen.getByRole('list', { name: 'Tickets left as they were' });
    expect(within(apart).getByRole('link', { name: 'SHOP-2 Cart totals' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Placed (1)' }));
    const placed = screen.getByRole('list', { name: 'Tickets Placed (1)' });
    expect(within(placed).getAllByRole('listitem')).toHaveLength(1);
    expect(within(placed).queryByRole('link', { name: /^SHOP-2 / })).toBeNull();
    expect(
      screen.getByText('Into Auto-schedule 14 Nov, a new scenario. 1 ticket was left out.'),
    ).toBeVisible();
  });
});

describe('the result of a run that evened out load (PLN-011)', () => {
  it('[PLN-011] says what moved later in words, and lists only what moved, did not move or was kept', async () => {
    const user = userEvent.setup();
    show(evenOutRunFixture());
    expect(screen.getByRole('heading', { name: 'Even out load' })).toHaveFocus();
    expect(
      screen.getByText('2 tickets moved later, 1 kept, 2 not moved, 0 earlier proposals removed.'),
    ).toBeVisible();
    // Not moved first: they need a person.
    let list = screen.getByRole('list', { name: 'Tickets Not moved (2)' });
    expect(
      within(list).getByText('Not moved: moving it would make kept OPS-4 late.'),
    ).toBeVisible();
    expect(within(list).getByText('Still over: no room for Atlas up to Dec 20.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Moved (2)' }));
    list = screen.getByRole('list', { name: 'Tickets Moved (2)' });
    expect(
      within(list).getByText(
        'Moved 2 weeks later, from Nov 9–Nov 22 to Nov 23–Dec 6: Atlas was 6 points over.',
      ),
    ).toBeVisible();
    expect(
      within(list).getByText('Moved 3 days later after SHOP-3, which was moved.'),
    ).toBeVisible();
    // A ticket left where it is is not listed.
    expect(screen.queryByRole('link', { name: 'SHOP-6 Loyalty points' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Kept (1)' }));
    expect(screen.getByText('Kept: it is in progress.')).toBeVisible();
  });

  it('[PLN-011] lists every cell still over capacity, with why', () => {
    show(evenOutRunFixture());
    const over = screen.getByRole('region', { name: 'Still over capacity' });
    const items = within(over).getAllByRole('listitem');
    expect(items.map((x) => x.textContent)).toEqual([
      'Atlas is 2 points over in Nov 9–Nov 22: no later period of the run has room.',
      'Atlas is 4 points over in Dec 7–Dec 20: only tickets that do not move are there.',
    ]);
  });

  it('[PLN-011] counts what moved from the run’s counts when the list is cut before the moved tickets', () => {
    const run = evenOutRunFixture();
    const cut = run.result.tickets.filter((x) => x.outcome !== 'placed');
    show(
      evenOutRunFixture({
        tickets: cut,
        more: 2300,
        counts: { ...run.result.counts, placed: 301, moved: 300 },
      }),
    );
    expect(
      screen.getByText(
        '300 tickets moved later, 1 kept, 2 not moved, 0 earlier proposals removed.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Moved (300)' })).toBeVisible();
  });

  it('[PLN-011] says when every team and person is within capacity after the run', () => {
    show(evenOutRunFixture({ overLeft: [] }));
    const over = screen.getByRole('region', { name: 'Still over capacity' });
    expect(within(over).queryByRole('list')).toBeNull();
    expect(
      within(over).getByText('Every team and person is within capacity in the run’s periods now.'),
    ).toBeVisible();
  });

  it('[PLN-004] [PLN-011] says nothing of cells over capacity after a run in rank order', () => {
    show();
    expect(screen.queryByRole('region', { name: 'Still over capacity' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Placed (2)' })).toBeVisible();
  });
});
