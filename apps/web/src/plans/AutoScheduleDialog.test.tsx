import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { AutoScheduleDialog, type AutoScheduleDialogProps } from './AutoScheduleDialog';
import { PLAN_PERIOD } from './capacityFixtures';
import { fakePlanClient } from './fixtures';
import type { ScenarioList } from './scenarioClient';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';
import { scheduleRunFixture } from './scheduleResultFixture';

/**
 * Auto-schedule's dialog (T-089f; PLN-004; ADR-122 stage 7) over the fake plan "Spring launch":
 * Web has capacity and Ops none, in points from Story points; four open tickets, one without an
 * estimate or an assignee. "Faster" holds a proposal of the auto-scheduler (OPS-4) and a person's
 * draft (SHOP-3).
 */
async function renderDialog(
  options: FakeScenarioOptions & { open?: 'Faster' | null } = {},
  props: Partial<AutoScheduleDialogProps> = {},
) {
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, {
    scenarios: [
      { name: 'Main plan', drafts: [{ ticketId: 3, dueDate: '2026-11-25' }] },
      {
        name: 'Faster',
        drafts: [{ ticketId: 3, dueDate: '2026-11-17' }],
        proposals: [{ ticketId: 4, startDate: '2026-11-16', dueDate: '2026-11-29' }],
      },
    ],
    ...options,
  });
  const list: ScenarioList = await scenarios.list(12);
  const active =
    options.open === null ? null : (list.scenarios.find((s) => s.name === 'Faster') ?? null);
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nProvider locale="en">
      <AutoScheduleDialog
        planId={12}
        client={scenarios}
        list={list}
        active={active}
        period={PLAN_PERIOD}
        today="2026-11-04"
        capacityHref="#/plans/12/capacity"
        onDone={onDone}
        onClose={onClose}
        {...props}
      />
    </I18nProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Auto-schedule' });
  return { scenarios, dialog, onDone, onClose, list };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  act(() => setViewportWidth(1440));
});

describe('Auto-schedule’s dialog (PLN-004)', () => {
  it('[PLN-004] says before the run which teams have capacity, the unit and what will not be placed', async () => {
    const { dialog } = await renderDialog({ open: null });
    expect(
      await within(dialog).findByText(/^Web has capacity\. Ops has none, so its tickets will not/),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('link', { name: 'Set capacity on the Capacity tab' }),
    ).toHaveAttribute('href', '#/plans/12/capacity');
    expect(
      within(dialog).getByText('Capacity is in points, from the field Story points.'),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        'The plan shows you 4 open tickets. 1 person in its teams has capacity of their own; 2 others limit nothing.',
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        'These will not be placed: 1 without an estimate and 1 with nobody assigned.',
      ),
    ).toBeVisible();
    // The periods it would fill, said in words.
    expect(within(dialog).getByLabelText('Look ahead')).toHaveAccessibleDescription(
      '6 periods of 2 weeks: Nov 2 to Jan 24.',
    );
    expect(within(dialog).getByText('Closed tickets never move.')).toBeVisible();
    expect(
      within(dialog).getByText(
        'It changes no ticket: it writes draft changes you can review, compare and apply.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('[PLN-004] turns Run off with the reason beside it when no team has capacity, or tickets cannot be sized', async () => {
    const { dialog } = await renderDialog({
      readiness: {
        teams: [
          { id: 3, name: 'Web', withCapacity: false },
          { id: 4, name: 'Ops', withCapacity: false },
        ],
      },
    });
    expect(
      await within(dialog).findByText(
        /^None of the plan’s 2 teams has capacity set, so no ticket can be placed\./,
      ),
    ).toBeVisible();
    const run = within(dialog).getByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    expect(run).toHaveAccessibleDescription('Run is off: no team has capacity set.');
  });

  it('[PLN-004] says when no Points field exists, and keeps Run off', async () => {
    const { dialog } = await renderDialog({ readiness: { pointsField: null } });
    expect(
      await within(dialog).findByText(
        'No Points field exists, so tickets cannot be sized. Switch the plan to hours or add a shared number field named Points.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Run' })).toHaveAccessibleDescription(
      'Run is off: tickets cannot be sized in points.',
    );
  });

  it('[PLN-004] sends the choices made, into a new scenario copied from the one open, and remembers them here', async () => {
    const user = userEvent.setup();
    const { dialog, scenarios, onDone } = await renderDialog();
    await within(dialog).findByText(/^Web has capacity/);
    expect(within(dialog).getByRole('radio', { name: 'A new scenario' })).toBeChecked();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Auto-schedule Nov 4');
    expect(within(dialog).getByLabelText('Start from')).toHaveDisplayValue(
      'A copy of Faster (2 changes)',
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Keep tickets in progress' }));
    await user.type(within(dialog).getByLabelText('Also keep tickets matching'), 'priority = High');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Chore' }));
    await user.click(within(dialog).getByRole('checkbox', { name: '2.1 (Dec 1)' }));
    await user.selectOptions(within(dialog).getByLabelText('Look ahead'), '3 periods');
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Look ahead')).toHaveAccessibleDescription(
        '3 periods of 2 weeks: Nov 2 to Dec 13.',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(scenarios.runs).toEqual([
      {
        into: { newScenario: { name: 'Auto-schedule Nov 4', from: 2 } },
        from: '2026-11-04',
        periods: 3,
        leaveOut: { typeIds: [2], releaseIds: [5] },
        keep: { inProgress: false, inActiveSprint: true, query: 'priority = High' },
      },
    ]);
    const [result, asked] = onDone.mock.calls[0] ?? [];
    expect(result.created).toBe(true);
    expect(result.scenario.name).toBe('Auto-schedule Nov 4');
    expect(asked).toMatchObject({ types: ['Chore'], releases: ['2.1'], from: '2026-11-04' });
    // The run's readiness asked about the scenario it copies, with its periods.
    expect(scenarios.readinessAsked.at(-1)).toEqual({
      scenario: 2,
      from: '2026-11-04',
      periods: 3,
    });
  });

  it('[PLN-004] starts from the choices last used for the plan in this browser', async () => {
    window.localStorage.setItem(
      'taskmoor.autoSchedule.12',
      JSON.stringify({ periods: 4, keepInProgress: false, typeIds: [1], leaveQuery: 'label = x' }),
    );
    const { dialog } = await renderDialog();
    expect(within(dialog).getByLabelText('Look ahead')).toHaveDisplayValue('4 periods');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Keep tickets in progress' }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: 'Keep tickets in an active sprint' }),
    ).toBeChecked();
    expect(within(dialog).getByLabelText('Also leave out tickets matching')).toHaveValue(
      'label = x',
    );
    expect(await within(dialog).findByRole('checkbox', { name: 'Feature' })).toBeChecked();
  });

  it('[PLN-004] counts only the remembered choices the plan still offers, and forgets the rest', async () => {
    const user = userEvent.setup();
    // Twenty types remembered from earlier runs, none of which the plan offers any more.
    window.localStorage.setItem(
      'taskmoor.autoSchedule.12',
      JSON.stringify({ typeIds: Array.from({ length: 20 }, (_, i) => 101 + i) }),
    );
    const { dialog, scenarios, onDone } = await renderDialog();
    const chore = await within(dialog).findByRole('checkbox', { name: 'Chore' });
    expect(chore).toBeEnabled();
    expect(within(dialog).queryByText(/^At most 20/)).toBeNull();
    await user.click(chore);
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(scenarios.runs[0]?.leaveOut?.typeIds).toEqual([2]);
    expect(onDone.mock.calls[0]?.[1]).toMatchObject({ typeIds: [2], types: ['Chore'] });
    const kept = JSON.parse(window.localStorage.getItem('taskmoor.autoSchedule.12') ?? '{}');
    expect(kept.typeIds).toEqual([2]);
  });

  it('[PLN-004] [PLN-002] says a re-run in the open scenario replaces only the auto-scheduler’s proposals', async () => {
    const user = userEvent.setup();
    const { dialog, scenarios, onDone } = await renderDialog();
    await user.click(within(dialog).getByRole('radio', { name: 'This scenario: Faster' }));
    expect(
      await within(dialog).findByText(
        'Re-running replaces the auto-scheduler’s 1 proposal here. The 1 draft a person made stays, and it plans around it.',
      ),
    ).toBeVisible();
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(scenarios.runs[0]?.into).toEqual({ scenarioId: 2 });
    const [result] = onDone.mock.calls[0] ?? [];
    // SHOP-3 keeps the person's draft; the earlier proposal on OPS-4 is replaced.
    expect(result.created).toBe(false);
    expect(result.tickets.find((t: { key: string }) => t.key === 'SHOP-3')).toMatchObject({
      outcome: 'kept',
      reason: 'person_draft',
    });
  });

  it('[PLN-004] says it is running, keeps Run off and stays open until the run answers', async () => {
    const user = userEvent.setup();
    const { dialog, onClose } = await renderDialog({ holdSchedule: true });
    await within(dialog).findByText(/^Web has capacity/);
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    // Run is off but keeps the focus, so it stays in the dialog.
    const busy = within(dialog).getByRole('button', { name: 'Scheduling…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveFocus();
    const status = within(dialog).getByRole('status');
    expect(status).toHaveTextContent('Scheduling 4 tickets.');
    // Nothing around the status says busy, which would hold its words back from a screen reader.
    expect(status.closest('[aria-busy="true"]')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Auto-schedule' })).toBeInTheDocument();
  });

  it('[PLN-004] shows a condition that does not read under its own field', async () => {
    const user = userEvent.setup();
    const { dialog, onDone } = await renderDialog();
    await within(dialog).findByText(/^Web has capacity/);
    const field = within(dialog).getByLabelText('Also keep tickets matching');
    await user.type(field, 'nope nope');
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription(
      'This does not read as a query. Check its words and quotes. A query, as in search. Tickets it finds keep their days.',
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('[PLN-004] says a refused run in words, with the limit and the count', async () => {
    const user = userEvent.setup();
    const { dialog } = await renderDialog({
      refuseSchedule: { code: 'too_many_to_schedule', limit: 10_000, count: 12_480 },
    });
    await within(dialog).findByText(/^Web has capacity/);
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This run would place 12,480 tickets, and one run places at most 10,000. Leave some out and run again.',
    );
    expect(within(dialog).getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Run' })).toHaveFocus();
  });

  it('[PLN-004] says a run whose scenario went as it finished, and opens nothing', async () => {
    const user = userEvent.setup();
    const base = fakeScenarioClient(fakePlanClient());
    const gone = scheduleRunFixture().result;
    const { dialog, onDone } = await renderDialog(
      {},
      {
        client: {
          readiness: base.readiness,
          schedule: async () => ({ ok: true, value: { ...gone, scenario: null as never } }),
        },
      },
    );
    await within(dialog).findByText(/^Web has capacity/);
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The plan or the scenario no longer exists.',
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('[PLN-004] keeps Run off while readiness for changed choices is read, and drops the old answer', async () => {
    const user = userEvent.setup();
    const base = fakeScenarioClient(fakePlanClient());
    let calls = 0;
    let answer: (() => void) | undefined;
    const { dialog } = await renderDialog(
      {},
      {
        client: {
          schedule: base.schedule,
          readiness: async (planId, at) => {
            calls++;
            const r = await base.readiness(planId, at);
            if (calls > 1) await new Promise<void>((done) => (answer = done));
            return r;
          },
        },
      },
    );
    await within(dialog).findByText(/^Web has capacity/);
    const run = within(dialog).getByRole('button', { name: 'Run' });
    expect(run).toBeEnabled();
    await user.selectOptions(within(dialog).getByLabelText('Look ahead'), '3 periods');
    await waitFor(() => expect(run).toBeDisabled());
    expect(run).toHaveAccessibleDescription('Run is off until the check of the plan answers.');
    expect(within(dialog).queryByText(/^Web has capacity/)).toBeNull();
    expect(within(dialog).getByText('Checking the plan…')).toBeVisible();
    await act(async () => answer?.());
    await waitFor(() => expect(run).toBeEnabled());
    expect(within(dialog).getByText(/^Web has capacity/)).toBeVisible();
  });

  it('[PLN-004] asks for a name for the new scenario', async () => {
    const user = userEvent.setup();
    const { dialog, scenarios } = await renderDialog();
    await within(dialog).findByText(/^Web has capacity/);
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription(
      'Give the scenario a name.',
    );
    expect(scenarios.runs).toEqual([]);
  });

  it('[PLN-004] offers this scenario only, with the reason, when the plan holds its 20 scenarios', async () => {
    const { dialog } = await renderDialog({
      scenarios: Array.from({ length: 20 }, (_, i) => ({ name: i === 1 ? 'Faster' : `S${i}` })),
    });
    const fresh = within(dialog).getByRole('radio', { name: 'A new scenario' });
    expect(fresh).toBeDisabled();
    expect(fresh).toHaveAccessibleDescription('The plan holds 20 scenarios, the most it can.');
    expect(within(dialog).getByRole('radio', { name: 'This scenario: Faster' })).toBeChecked();
  });

  it('[PLN-004] says the new scenario becomes main in a plan with none', async () => {
    const { dialog } = await renderDialog({ scenarios: [], open: null });
    expect(
      within(dialog).getByText(
        'The plan has no scenario yet, so this one becomes its main scenario.',
      ),
    ).toBeVisible();
    expect(within(dialog).queryByRole('radio', { name: /^This scenario/ })).toBeNull();
  });

  it('[PLN-004] reads as a sheet on a phone, every choice reachable', async () => {
    act(() => setViewportWidth(360));
    const user = userEvent.setup();
    const { dialog, onDone } = await renderDialog();
    await within(dialog).findByText(/^Web has capacity/);
    for (const name of ['A new scenario', 'This scenario: Faster']) {
      expect(within(dialog).getByRole('radio', { name })).toBeVisible();
    }
    expect(within(dialog).getByRole('group', { name: 'When' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe('Auto-schedule’s dialog: evening out load (PLN-011)', () => {
  it('[PLN-011] offers Even out load beside rank order, says how many periods are over now, and sends the mode', async () => {
    const user = userEvent.setup();
    const { dialog, scenarios, onDone } = await renderDialog({ readiness: { overCells: 4 } });
    await within(dialog).findByText(/^Web has capacity/);
    const modes = within(dialog).getByRole('group', { name: 'What the run does' });
    const fill = within(modes).getByRole('radio', { name: 'Place work in rank order' });
    const even = within(modes).getByRole('radio', { name: 'Even out load' });
    expect(fill).toBeChecked();
    expect(even).toHaveAccessibleDescription(
      'Moves only work that puts someone over capacity, later, by as little as it can, keeping each ticket’s length.',
    );
    expect(
      within(dialog).getByText('4 periods of teams and people are over capacity now.'),
    ).toBeVisible();
    // The keep choices are headed as what never moves.
    const kept = within(dialog).getByRole('group', {
      name: 'Kept tickets never move (fixed dates)',
    });
    expect(within(kept).getByRole('checkbox', { name: 'Keep tickets in progress' })).toBeChecked();
    await user.click(even);
    expect(
      within(dialog).getByText(
        'A run that evens out load and one in rank order replace each other’s proposals; both start from the tickets’ days and people’s drafts.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(scenarios.runs.at(-1)).toMatchObject({ mode: 'even_out' });
    const [, asked] = onDone.mock.calls[0] ?? [];
    expect(asked).toMatchObject({ mode: 'even_out' });
    // Remembered here for next time.
    expect(
      JSON.parse(window.localStorage.getItem('taskmoor.autoSchedule.12') ?? '{}'),
    ).toMatchObject({ mode: 'even_out' });
  });

  it('[PLN-011] says evening out would move nothing when no one is over capacity', async () => {
    const user = userEvent.setup();
    const { dialog } = await renderDialog({ readiness: { overCells: 0 } });
    await within(dialog).findByText(/^Web has capacity/);
    const nothing = 'No team or person is over capacity now, so evening out would move nothing.';
    expect(within(dialog).queryByText(nothing)).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Even out load' }));
    expect(within(dialog).getByText(nothing)).toBeVisible();
  });

  it('[PLN-011] starts from the mode last used for the plan, and a run in rank order sends none', async () => {
    window.localStorage.setItem('taskmoor.autoSchedule.12', JSON.stringify({ mode: 'even_out' }));
    const user = userEvent.setup();
    const { dialog, scenarios, onDone } = await renderDialog();
    await within(dialog).findByText(/^Web has capacity/);
    expect(within(dialog).getByRole('radio', { name: 'Even out load' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: 'Place work in rank order' }));
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(scenarios.runs.at(-1)).not.toHaveProperty('mode');
  });
});
