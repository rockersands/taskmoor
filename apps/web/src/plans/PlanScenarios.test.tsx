import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

/**
 * A plan's scenarios (T-089e; PLN-003; ADR-122 stage 6): "Main plan" drafts SHOP-3 due on 25
 * November (the plan's end then), "Faster" drafts it due on the 17th, which brings the plan's end
 * to OPS-4's 18th.
 */
function renderScenarios(hash = '#/plans/12/scenarios', options: FakeScenarioOptions = {}) {
  window.location.hash = hash;
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, {
    scenarios: [
      { name: 'Main plan', drafts: [{ ticketId: 3, dueDate: '2026-11-25' }] },
      { name: 'Faster', drafts: [{ ticketId: 3, dueDate: '2026-11-17' }] },
    ],
    ...options,
  });
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="scenarios"
        client={plans}
        scenarios={scenarios}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { plans, scenarios };
}
const itemOf = (name: string) =>
  screen
    .getByRole('heading', { name: new RegExp(`^${name}`), level: 3 })
    .closest('li') as HTMLElement;

afterEach(() => {
  window.location.hash = '';
  act(() => setViewportWidth(1440));
});

describe('a plan’s scenarios (PLN-003)', () => {
  it('[PLN-003] lists each scenario with its changes, the main one in words, and who made it', async () => {
    renderScenarios('#/plans/12/scenarios', { notShown: { Faster: 2 } });
    expect(
      await screen.findByRole('heading', { name: /^Main plan.*Main$/, level: 3 }),
    ).toBeVisible();
    const faster = itemOf('Faster');
    expect(
      within(faster).getByText(
        '1 change 2 more changes are on tickets this plan does not show you.',
      ),
    ).toBeVisible();
    expect(within(faster).getByText(/^Made by Ana Ruiz on /)).toBeVisible();
    expect(
      within(faster).getByRole('link', { name: 'Open Faster on the Timeline' }),
    ).toHaveAttribute('href', '#/plans/12/timeline?scenario=2');
    // Main stays while others exist: no Delete on it.
    expect(within(itemOf('Main plan')).queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('[PLN-003] makes a scenario from a copy of another, renames it and deletes it', async () => {
    const user = userEvent.setup();
    renderScenarios();
    await user.click(await screen.findByRole('button', { name: 'New scenario' }));
    const dialog = screen.getByRole('dialog', { name: 'New scenario' });
    await user.click(within(dialog).getByRole('button', { name: 'Make scenario' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the scenario a name.');
    await user.type(within(dialog).getByLabelText('Name'), 'Slower');
    await user.selectOptions(
      within(dialog).getByLabelText('Start from'),
      'A copy of Faster (1 change)',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Make scenario' }));
    await screen.findByText('Slower is made.');
    const slower = await waitFor(() => itemOf('Slower'));
    expect(within(slower).getByText('1 change')).toBeVisible();

    await user.click(within(slower).getByRole('button', { name: 'Rename Slower' }));
    const rename = screen.getByRole('dialog', { name: 'Rename Slower' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Steady');
    await user.click(within(rename).getByRole('button', { name: 'Save name' }));
    await screen.findByText('The scenario is now called Steady.');

    const steady = await waitFor(() => itemOf('Steady'));
    await user.click(within(steady).getByRole('button', { name: 'Delete Steady' }));
    const ask = within(steady).getByRole('group', {
      name: 'Steady and its 1 draft change go. No ticket changes.',
    });
    await user.click(within(ask).getByRole('button', { name: 'Delete Steady' }));
    await screen.findByText('Steady is deleted.');
    await waitFor(() => expect(screen.queryByRole('heading', { name: /^Steady/ })).toBeNull());
    // Its row is gone: the list's heading holds focus, not the page.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scenarios', level: 2 })).toHaveFocus(),
    );
  });

  it('[PLN-003] makes another scenario main after asking; the former main keeps its drafts', async () => {
    const user = userEvent.setup();
    const { scenarios } = renderScenarios();
    const faster = await waitFor(() => itemOf('Faster'));
    await user.click(within(faster).getByRole('button', { name: 'Make Faster main' }));
    const ask = within(faster).getByRole('group', {
      name: 'Faster’s 1 change becomes the plan’s drafts to apply. Main plan keeps its 1 change as a scenario.',
    });
    await user.click(within(ask).getByRole('button', { name: 'Make Faster main' }));
    await screen.findByText('Faster is now main: its drafts are the ones to apply.');
    await screen.findByRole('heading', { name: /^Faster.*Main$/, level: 3 });
    // Make main is gone from its row: the list's heading holds focus, not the page.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scenarios', level: 2 })).toHaveFocus(),
    );
    const list = await scenarios.list(12);
    expect(list.scenarios.map((s) => [s.name, s.main, s.drafts])).toEqual([
      ['Faster', true, 1],
      ['Main plan', false, 1],
    ]);
    // Applying now takes Faster's drafts; the former main answers that it is not main.
    expect(await scenarios.apply(12, 1, { all: true })).toMatchObject({
      ok: false,
      code: 'not_main',
    });
  });

  it('[PLN-003] gives focus back to Make main when making it main is refused', async () => {
    const user = userEvent.setup();
    const { scenarios } = renderScenarios();
    scenarios.promote = async () => ({ ok: false, code: 'apply_in_progress', fields: {} });
    const faster = await waitFor(() => itemOf('Faster'));
    await user.click(within(faster).getByRole('button', { name: 'Make Faster main' }));
    await user.click(
      within(within(faster).getByRole('group')).getByRole('button', { name: 'Make Faster main' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Its drafts are being applied now. Try again once that is done.',
    );
    expect(within(faster).getByRole('button', { name: 'Make Faster main' })).toHaveFocus();
  });

  it('[PLN-003] compares two sides by the plan’s end and each team’s end, in words, as a table', async () => {
    const user = userEvent.setup();
    renderScenarios('#/plans/12/scenarios?a=1&b=2');
    const measures = await screen.findByRole('table', { name: 'The plan compared' });
    const end = within(measures).getByRole('row', { name: /^The plan ends/ });
    expect(
      within(end)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([
      'Nov 25, 2026; 2 open tickets have no due date',
      'Nov 18, 2026; 2 open tickets have no due date',
      'Ends 7 days earlier in Faster',
    ]);
    expect(screen.getByRole('table', { name: 'Each team’s end, by Team' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '1 ticket differs' })).toBeVisible();
    expect(
      screen.getByText(
        'Main plan: Nov 9, 2026 to Nov 25, 2026. Faster: Nov 9, 2026 to Nov 17, 2026.',
      ),
    ).toBeVisible();
    expect(screen.getByText('The numbers are of the tickets you see.')).toBeVisible();
    // Choosing a side keeps it in the address.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Compare' }),
      'Live (tickets as they are)',
    );
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/scenarios?a=live&b=2'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('row', { name: /^The plan ends/ })).getAllByRole('cell')[2],
      ).toHaveTextContent('Ends 2 days earlier in Faster'),
    );
  });

  it('[PLN-003] never shows one pair’s comparison under another’s names, and reads it again once a scenario changes', async () => {
    const user = userEvent.setup();
    const { scenarios } = renderScenarios('#/plans/12/scenarios?a=1&b=2');
    await screen.findByRole('table', { name: 'The plan compared' });
    const compare = scenarios.compare;
    let calls = 0;
    let answer: (() => void) | undefined;
    scenarios.compare = async (...args) => {
      calls++;
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return compare(...args);
    };
    // Faster against Live: until its answer comes, Main plan's numbers are not shown as Live's.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Compare' }),
      'Live (tickets as they are)',
    );
    expect(await screen.findByText('Loading the report…')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'The plan compared' })).toBeNull();
    await act(async () => answer?.());
    await screen.findByRole('table', { name: 'The plan compared' });
    // Making Faster main changes what it holds: the comparison is read again.
    const before = calls;
    const faster = itemOf('Faster');
    await user.click(within(faster).getByRole('button', { name: 'Make Faster main' }));
    await user.click(
      within(within(faster).getByRole('group')).getByRole('button', { name: 'Make Faster main' }),
    );
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    await act(async () => answer?.());
  });

  it('[PLN-003] compares as a card per measure and per team on a phone', async () => {
    act(() => setViewportWidth(360));
    renderScenarios('#/plans/12/scenarios?a=1&b=2');
    const measures = await screen.findByRole('list', { name: 'The plan compared' });
    expect(screen.queryByRole('table')).toBeNull();
    const end = within(measures).getByRole('heading', { name: 'The plan ends' }).closest('li');
    expect(within(end as HTMLElement).getByText('Ends 7 days earlier in Faster')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Each team’s end, by Team' })).toBeVisible();
  });

  it('[PLN-003] lets someone who may not change scenarios see and compare them only', async () => {
    renderScenarios('#/plans/12/scenarios', { editable: false });
    await screen.findByRole('heading', { name: /^Main plan.*Main$/, level: 3 });
    expect(
      screen.getByText(
        'Only the plan’s owner and site administrators can make, change or apply scenarios.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New scenario' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rename|^Delete|^Make/ })).toBeNull();
    expect(await screen.findByRole('table', { name: 'The plan compared' })).toBeVisible();
  });
});
