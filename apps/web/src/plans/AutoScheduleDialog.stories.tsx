import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { AutoScheduleDialog } from './AutoScheduleDialog';
import { PLAN_PERIOD } from './capacityFixtures';
import { fakePlanClient } from './fixtures';
import type { ScenarioList, ScenarioRow } from './scenarioClient';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

const row = (id: number, name: string, main: boolean, drafts: number): ScenarioRow => ({
  id,
  name,
  main,
  drafts,
  notShown: 0,
  applying: false,
  createdBy: { id: 7, name: 'Ana Ruiz' },
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  version: 1,
});
const FASTER = row(2, 'Faster', false, 2);
const LIST: ScenarioList = {
  plan: { id: 12, name: 'Spring launch' },
  editable: true,
  scenarios: [row(1, 'Main plan', true, 1), FASTER],
  limits: { scenarios: 20, draftedTickets: 10_000, perRequest: 200, perApply: 100 },
};

/** "Spring launch" with Main plan and Faster, which holds a proposal and a person's draft. */
const client = (options: FakeScenarioOptions = {}) =>
  fakeScenarioClient(fakePlanClient(), {
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

const dialogOf = (canvasElement: HTMLElement) =>
  within(canvasElement.ownerDocument.body).findByRole('dialog', { name: 'Auto-schedule' });

/**
 * Auto-schedule (ADR-122 stage 7): readiness first, where the result goes, what it may move, from
 * when and how far, and Run. A sheet on a phone.
 */
const meta = {
  title: 'Plans/AutoScheduleDialog',
  component: AutoScheduleDialog,
  args: {
    planId: 12,
    client: client(),
    list: LIST,
    active: FASTER,
    period: PLAN_PERIOD,
    today: '2026-11-04',
    capacityHref: '#/plans/12/capacity',
    onDone: fn(),
    onClose: fn(),
  },
  beforeEach: () => {
    try {
      window.localStorage.removeItem('taskmoor.autoSchedule.12');
    } catch {
      // Storage can be blocked; the dialog starts from its defaults then.
    }
  },
} satisfies Meta<typeof AutoScheduleDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ready: Web has capacity, Ops none, said before the run; Run on. */
export const Ready: Story = {
  args: { active: null },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(await within(dialog).findByText(/^Web has capacity\./)).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: 'Run' })).toBeEnabled();
  },
};

/** Not ready: no team has capacity, so Run is off and says why. */
export const NotReady: Story = {
  args: {
    client: client({
      readiness: {
        teams: [
          { id: 3, name: 'Web', withCapacity: false },
          { id: 4, name: 'Ops', withCapacity: false },
        ],
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    const run = within(dialog).getByRole('button', { name: 'Run' });
    await waitFor(() =>
      expect(run).toHaveAccessibleDescription('Run is off: no team has capacity set.'),
    );
    await expect(run).toBeDisabled();
  },
};

/** A re-run in Faster: it replaces only the auto-scheduler's proposals there. */
export const ReRun: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'This scenario: Faster' }));
    await expect(
      await within(dialog).findByText(
        /^Re-running replaces the auto-scheduler’s 1 proposal here\./,
      ),
    ).toBeVisible();
  },
};

/**
 * Running: Run says so and is off (`aria-disabled`, keeping the focus), a status line counts the
 * tickets, and the dialog stays.
 */
export const Running: Story = {
  args: { client: client({ holdSchedule: true }) },
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement);
    await within(dialog).findByText(/^Web has capacity\./);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    const busy = within(dialog).getByRole('button', { name: 'Scheduling…' });
    await expect(busy).toHaveAttribute('aria-disabled', 'true');
    await expect(busy).toHaveFocus();
    await expect(within(dialog).getByRole('status')).toHaveTextContent('Scheduling 4 tickets.');
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

/** On a phone's touch screen: a sheet, every choice a finger's size, nothing sideways. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await within(dialog).findByText(/^Web has capacity\./);
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await expect(
      tooSmallForAFinger(dialog, [
        '.form-field-inline label',
        '.form-actions button',
        'select',
        'input:not([type="checkbox"], [type="radio"])',
      ]),
    ).toEqual([]);
  },
};

/**
 * Even out load (ADR-122 stage 9): the run's mode chosen beside rank order, how many periods are
 * over capacity now, and the keep choices headed as what never moves.
 */
export const EvenOut: Story = {
  args: { active: null, client: client({ readiness: { overCells: 4 } }) },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(
      await within(dialog).findByText('4 periods of teams and people are over capacity now.'),
    ).toBeVisible();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Even out load' }));
    await expect(within(dialog).getByRole('radio', { name: 'Even out load' })).toBeChecked();
    await expect(
      within(dialog).getByRole('group', { name: 'Kept tickets never move (fixed dates)' }),
    ).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: 'Run' })).toBeEnabled();
  },
};

/** Even out load on a phone's touch screen: the mode choice a finger's size, nothing sideways. */
export const EvenOutOnAPhone: Story = {
  args: { client: client({ readiness: { overCells: 4 } }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await within(dialog).findByText(/^Web has capacity\./);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Even out load' }));
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await expect(
      tooSmallForAFinger(dialog, [
        '.form-field-inline label',
        '.form-actions button',
        'select',
        'input:not([type="checkbox"], [type="radio"])',
      ]),
    ).toEqual([]);
  },
};
