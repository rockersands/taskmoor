import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import { type FakePlanOptions, fakePlanClient, manyPlanItems } from './fixtures';
import { PlanPage } from './PlanPage';
import type { ScenarioClient } from './scenarioClient';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

/**
 * The change list of a scenario (T-089e; PLN-002; ADR-122 stage 6). "Main plan", the main
 * scenario, drafts SHOP-2 due a day later, SHOP-3 due a day later and OPS-4 a day later; "Faster"
 * drafts SHOP-2 only.
 */
const DRAFTS = [
  { ticketId: 2, dueDate: '2026-11-11' },
  { ticketId: 3, dueDate: '2026-11-21' },
  { ticketId: 4, startDate: '2026-11-13', dueDate: '2026-11-19' },
];

function renderChanges(
  hash = '#/plans/12/changes?scenario=1',
  options: FakeScenarioOptions = {},
  planOptions: FakePlanOptions = {},
  wrap: (client: ScenarioClient) => ScenarioClient = (client) => client,
) {
  window.location.hash = hash;
  const plans = fakePlanClient(planOptions);
  const scenarios = fakeScenarioClient(plans, {
    scenarios: [
      { name: 'Main plan', drafts: DRAFTS },
      { name: 'Faster', drafts: [{ ticketId: 2, dueDate: '2026-11-12' }] },
    ],
    ...options,
  });
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="changes"
        client={plans}
        scenarios={wrap(scenarios)}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { plans, scenarios };
}
const rowOf = (key: string) => {
  const link = screen.getByRole('link', { name: new RegExp(`^${key} `) });
  return link.closest('tr, li') as HTMLElement;
};
const due = (plans: ReturnType<typeof fakePlanClient>, key: string) =>
  plans.items().find((i) => i.key === key)?.due;

afterEach(() => {
  window.location.hash = '';
  act(() => setViewportWidth(1440));
});

describe('the change list (PLN-002)', () => {
  it('[PLN-002] lists each ticket’s drafts with their values now and drafted, its state in words, and only counts hidden ones', async () => {
    renderChanges('#/plans/12/changes?scenario=1', {
      notShown: { 'Main plan': 3 },
      cannotApply: ['OPS-4'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Changes in Main plan, the main scenario' }),
    ).toBeVisible();
    expect(
      screen.getByText(/^3 changes: 3 ready, 0 changed since drafted, 0 refused\./),
    ).toBeVisible();
    const shop2 = rowOf('SHOP-2');
    expect(within(shop2).getByText('Due: Nov 10, 2026 → Nov 11, 2026')).toBeVisible();
    expect(within(shop2).getByText('Ready')).toBeVisible();
    expect(within(shop2).getByText(/^Ana Ruiz, /)).toBeVisible();
    const ops4 = rowOf('OPS-4');
    expect(within(ops4).getByText('Start: Nov 12, 2026 → Nov 13, 2026')).toBeVisible();
    expect(within(ops4).getByText('You may not schedule tickets in OPS')).toBeVisible();
    expect(
      screen.getByText('3 more changes are on tickets this plan does not show you.'),
    ).toBeVisible();
    // Only those the reader can apply.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only those I can apply' }));
    expect(screen.queryByRole('link', { name: /^OPS-4 / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Select all 2 shown' })).toBeVisible();
  });

  it('[PLN-002] says a field changed since drafted, and Keep my draft takes the value now', async () => {
    const user = userEvent.setup();
    const { plans, scenarios } = renderChanges();
    // Someone changes SHOP-3 live after it was drafted.
    await plans.reschedule('SHOP-3', { startDate: '2026-11-09', dueDate: '2026-11-23' });
    const row = await waitFor(() => rowOf('SHOP-3'));
    await waitFor(() =>
      expect(within(row).getByText('Changed since drafted: due is now Nov 23, 2026')).toBeVisible(),
    );
    expect(
      within(row).getByText('Due: Nov 23, 2026 → Nov 21, 2026 (drafted from Nov 20, 2026)'),
    ).toBeVisible();
    await user.click(within(row).getByRole('button', { name: 'Keep my draft of SHOP-3' }));
    expect(scenarios.writes.at(-1)).toEqual([{ ticketId: 3, dueDate: '2026-11-21' }]);
    await screen.findByText('The draft of SHOP-3 is kept, against its values now.');
    await waitFor(() => expect(within(rowOf('SHOP-3')).getByText('Ready')).toBeVisible());
    // Its Keep button is gone: the list's heading holds focus, not the page.
    expect(
      screen.getByRole('heading', { name: 'Changes in Main plan, the main scenario' }),
    ).toHaveFocus();
  });

  it('[PLN-002] applies the chosen tickets only, after asking, and the rest stay pending', async () => {
    const user = userEvent.setup();
    const { plans } = renderChanges();
    await user.click(await screen.findByRole('checkbox', { name: 'Select SHOP-2' }));
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    const ask = screen.getByRole('group', {
      name: 'Change 1 ticket as you, with your permissions?',
    });
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(due(plans, 'SHOP-2')).toBe('2026-11-10');
    await user.click(within(ask).getByRole('button', { name: 'Apply 1 change' }));
    const result = await screen.findByRole('heading', { name: '1 applied, 0 refused' });
    await waitFor(() => expect(result).toHaveFocus());
    expect(due(plans, 'SHOP-2')).toBe('2026-11-11');
    expect(due(plans, 'SHOP-3')).toBe('2026-11-20');
    expect(due(plans, 'OPS-4')).toBe('2026-11-18');
    await waitFor(() => expect(screen.queryByRole('link', { name: /^SHOP-2 / })).toBeNull());
    expect(screen.getByRole('link', { name: /^SHOP-3 / })).toBeVisible();
    expect(screen.getByRole('link', { name: /^OPS-4 / })).toBeVisible();
  });

  it('[PLN-002] refuses a ticket with its reason without stopping the rest, and keeps it chosen', async () => {
    const user = userEvent.setup();
    const { plans } = renderChanges('#/plans/12/changes?scenario=1', {
      refuse: {
        'OPS-4': {
          reason: 'locked',
          locks: [{ by: 'status', statusId: 4, statusName: 'In review', allowed: [] }],
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Select all 3 shown' }));
    await user.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await user.click(
      within(
        screen.getByRole('group', { name: 'Change 3 tickets as you, with your permissions?' }),
      ).getByRole('button', { name: 'Apply 3 changes' }),
    );
    const result = await screen.findByRole('heading', { name: '2 applied, 1 refused' });
    const refused = within(result.closest('section') as HTMLElement).getByRole('listitem');
    expect(refused).toHaveTextContent(/^OPS-4: it is locked\. /);
    expect(due(plans, 'SHOP-2')).toBe('2026-11-11');
    expect(due(plans, 'OPS-4')).toBe('2026-11-18');
    await waitFor(() => expect(screen.queryByRole('link', { name: /^SHOP-2 / })).toBeNull());
    expect(within(rowOf('OPS-4')).getByText(/^Refused: it is locked/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select OPS-4' })).toBeChecked();
  });

  it('[PLN-002] applies a large choice 100 tickets at a time and says how far it got', async () => {
    const user = userEvent.setup();
    const items = manyPlanItems(150);
    const { scenarios } = renderChanges(
      '#/plans/12/changes?scenario=1',
      {
        scenarios: [
          {
            name: 'Main plan',
            drafts: items.map((i) => ({ ticketId: i.id, dueDate: '2027-06-30' })),
          },
        ],
      },
      { items },
    );
    await user.click(
      await screen.findByRole('button', { name: 'Select all 150 shown' }, { timeout: 5000 }),
    );
    await user.click(screen.getByRole('button', { name: 'Apply 150 changes' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Change 150 tickets/ })).getByRole('button', {
        name: 'Apply 150 changes',
      }),
    );
    await screen.findByRole('heading', { name: '150 applied, 0 refused' }, { timeout: 5000 });
    expect(scenarios.applies.map((a) => (a === 'all' ? a : a.length))).toEqual([100, 50]);
  });

  it('[PLN-002] discards the chosen tickets’ drafts after asking, and the tickets stay as they are', async () => {
    const user = userEvent.setup();
    const { plans, scenarios } = renderChanges();
    await user.click(await screen.findByRole('checkbox', { name: 'Select SHOP-3' }));
    await user.click(screen.getByRole('button', { name: 'Discard 1 change' }));
    const ask = screen.getByRole('group', {
      name: 'The drafts of 1 ticket in Main plan go. The ticket stays as it is.',
    });
    await user.click(within(ask).getByRole('button', { name: 'Discard 1 change' }));
    await screen.findByText('The drafts of 1 ticket in Main plan are discarded.');
    expect(scenarios.discards).toEqual([[3]]);
    expect(due(plans, 'SHOP-3')).toBe('2026-11-20');
    await waitFor(() => expect(screen.queryByRole('link', { name: /^SHOP-3 / })).toBeNull());
  });

  it('[PLN-003] offers to make another scenario main instead of applying from it', async () => {
    const user = userEvent.setup();
    const { scenarios } = renderChanges('#/plans/12/changes?scenario=2');
    await screen.findByRole('heading', { name: 'Changes in Faster' });
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Make Faster main' }));
    const ask = screen.getByRole('group', {
      name: 'Faster’s 1 change becomes the plan’s drafts to apply. Main plan keeps its 3 changes as a scenario.',
    });
    await user.click(within(ask).getByRole('button', { name: 'Make Faster main' }));
    await screen.findByText('Faster is now main: its drafts are the ones to apply.');
    const list = await scenarios.list(12);
    expect(list.scenarios.map((s) => [s.name, s.main, s.drafts])).toEqual([
      ['Faster', true, 1],
      ['Main plan', false, 3],
    ]);
    // Make main is gone once Faster is main: the list's heading holds focus, not the page.
    const heading = await screen.findByRole('heading', {
      name: 'Changes in Faster, the main scenario',
    });
    expect(heading).toHaveFocus();
  });

  it('[PLN-002] starts afresh on another scenario: nothing chosen, no result of the one before', async () => {
    const user = userEvent.setup();
    renderChanges();
    await user.click(await screen.findByRole('checkbox', { name: 'Select SHOP-3' }));
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Change 1 ticket/ })).getByRole('button', {
        name: 'Apply 1 change',
      }),
    );
    await screen.findByRole('heading', { name: '1 applied, 0 refused' });
    await user.click(screen.getByRole('checkbox', { name: 'Select SHOP-2' }));
    const select = screen.getByRole('combobox', { name: 'Scenario' });
    await user.selectOptions(select, 'Faster');
    await screen.findByRole('heading', { name: 'Changes in Faster' });
    // SHOP-2 has a draft in Faster too: it was chosen in Main plan, not here.
    expect(await screen.findByRole('checkbox', { name: 'Select SHOP-2' })).not.toBeChecked();
    expect(screen.queryByRole('heading', { name: /applied/ })).toBeNull();
  });

  it('[PLN-002] never brings back a discarded ticket when a page asked for before answers late', async () => {
    const user = userEvent.setup();
    let answer: (() => void) | undefined;
    // The first page holds SHOP-2; the next one, read before the discard, answers after it.
    const paged = (client: ScenarioClient): ScenarioClient => ({
      ...client,
      changes: async (planId, sid, page = {}) => {
        const all = await client.changes(planId, sid);
        if (page.cursor === undefined) {
          const first = all.changes.filter((c) => c.ticketId <= 2);
          return { ...all, changes: first, next: 2 };
        }
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return { ...all, changes: all.changes.filter((c) => c.ticketId > 2), next: null };
      },
    });
    renderChanges('#/plans/12/changes?scenario=1', {}, {}, paged);
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select SHOP-2' }));
    await user.click(screen.getByRole('button', { name: 'Discard 1 change' }));
    await user.click(
      within(screen.getByRole('group', { name: /^The drafts of 1 ticket/ })).getByRole('button', {
        name: 'Discard 1 change',
      }),
    );
    await screen.findByText('The drafts of 1 ticket in Main plan are discarded.');
    await waitFor(() => expect(screen.queryByRole('link', { name: /^SHOP-2 / })).toBeNull());
    await act(async () => answer?.());
    expect(screen.queryByRole('link', { name: /^SHOP-2 / })).toBeNull();
  });

  it('[PLN-002] on a phone, shows each ticket as a card and keeps the actions in a bar', async () => {
    act(() => setViewportWidth(360));
    const user = userEvent.setup();
    renderChanges();
    const cards = await screen.findByRole('list', { name: 'Draft changes' });
    expect(within(cards).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(within(cards).getByRole('checkbox', { name: 'Select SHOP-2' }));
    const bar = screen.getByRole('group', { name: 'Chosen changes' });
    expect(within(bar).getByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Discard 1 change' })).toBeEnabled();
  });

  it('[PLN-002] asks for a scenario on the Changes tab when the plan is Live', async () => {
    renderChanges('#/plans/12/changes');
    expect(await screen.findByText('No scenario chosen')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Scenarios' })).toHaveAttribute(
      'href',
      '#/plans/12/scenarios',
    );
  });
});
