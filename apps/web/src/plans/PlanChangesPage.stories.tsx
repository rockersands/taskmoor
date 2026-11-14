import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { notSized, onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePlanClient } from './fixtures';
import { PlanChangesPage } from './PlanChangesPage';
import type { ScenarioList, ScenarioRow } from './scenarioClient';
import { fakeScenarioClient } from './scenarioFixtures';

const row = (id: number, name: string, main: boolean, drafts: number): ScenarioRow => ({
  id,
  name,
  main,
  drafts,
  notShown: 2,
  applying: false,
  createdBy: { id: 7, name: 'Ana Ruiz' },
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  version: 1,
});
const MAIN = row(1, 'Main plan', true, 3);
const FASTER = row(2, 'Faster', false, 1);
const LIST: ScenarioList = {
  plan: { id: 12, name: 'Spring launch' },
  editable: true,
  scenarios: [MAIN, FASTER],
  limits: { scenarios: 20, draftedTickets: 10_000, perRequest: 200, perApply: 100 },
};

/**
 * "Main plan" drafts SHOP-2, SHOP-3 and OPS-4; SHOP-3 changed live since, OPS-4's track the
 * reader may not schedule, and two more drafts are on tickets hidden from them.
 */
function client() {
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, {
    scenarios: [
      {
        name: 'Main plan',
        drafts: [
          { ticketId: 2, dueDate: '2026-11-11' },
          { ticketId: 3, dueDate: '2026-11-21' },
          { ticketId: 4, startDate: '2026-11-13', dueDate: '2026-11-19' },
        ],
      },
      { name: 'Faster', drafts: [{ ticketId: 2, dueDate: '2026-11-12' }] },
    ],
    notShown: { 'Main plan': 2 },
    cannotApply: ['OPS-4'],
    refuse: {
      'SHOP-2': {
        reason: 'locked',
        locks: [{ by: 'status', statusId: 4, statusName: 'In review', allowed: [] }],
      },
    },
  });
  void plans.reschedule('SHOP-3', { startDate: '2026-11-09', dueDate: '2026-11-23' });
  return scenarios;
}

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** A scenario's change list (PLN-002; ADR-122 stage 6). */
const meta = {
  title: 'Plans/PlanChangesPage',
  component: PlanChangesPage,
  args: {
    planId: 12,
    scenario: MAIN,
    list: LIST,
    client: client(),
    view: { filters: {}, group: null, scenario: 1 },
    onChanged: fn(),
  },
} satisfies Meta<typeof PlanChangesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each change in words: ready, changed since drafted, a permission the reader lacks. */
export const Changes: Story = {
  args: { client: client() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Due: Nov 10, 2026 → Nov 11, 2026')).toBeVisible();
    await expect(canvas.getByText('Changed since drafted: due is now Nov 23, 2026')).toBeVisible();
    await expect(canvas.getByText('You may not schedule tickets in OPS')).toBeVisible();
    await expect(
      canvas.getByText('2 more changes are on tickets this plan does not show you.'),
    ).toBeVisible();
  },
};

/** Applying asks first; a refused ticket says why and stays chosen. */
export const AppliedWithARefusal: Story = {
  args: { client: client() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Select SHOP-2' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Apply 1 change' }));
    const ask = canvas.getByRole('group', { name: /^Change 1 ticket as you/ });
    await userEvent.click(within(ask).getByRole('button', { name: 'Apply 1 change' }));
    const result = await canvas.findByRole('heading', { name: '0 applied, 1 refused' });
    await waitFor(() => expect(result).toHaveFocus());
    await expect(canvas.getByText(/^SHOP-2: it is locked\./)).toBeVisible();
  },
};

/** Another scenario than main: Make main instead of Apply. */
export const NotMain: Story = {
  args: { client: client(), scenario: FASTER, view: { filters: {}, group: null, scenario: 2 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Make Faster main' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Apply/ })).toBeNull();
  },
};

/**
 * On a phone's touch screen: a card per ticket with a finger-sized place for its check box, the
 * actions in a bar at the bottom, nothing sticking out sideways.
 */
export const OnAPhone: Story = {
  args: { client: client(), phone: true },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: 'Draft changes' });
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select SHOP-2' }));
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.scenario-card-check',
        '.scenario-action-bar button',
        '.scenario-tools button',
        '.scenario-only',
        '.scenario-keep',
      ]),
    ).toEqual([]);
    // The check boxes themselves are the shared square, all alike.
    const size = canvas.getByRole('checkbox', { name: 'Select SHOP-2' }).getBoundingClientRect();
    await expect(
      notSized(canvasElement, '.scenario-card input[type="checkbox"]', size.width),
    ).toEqual([]);
  },
};
