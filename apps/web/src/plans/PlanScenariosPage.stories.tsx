import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePlanClient } from './fixtures';
import { PlanScenariosPage } from './PlanScenariosPage';
import type { ScenarioList, ScenarioRow } from './scenarioClient';
import { fakeScenarioClient } from './scenarioFixtures';

const row = (
  id: number,
  name: string,
  main: boolean,
  drafts: number,
  notShown = 0,
): ScenarioRow => ({
  id,
  name,
  main,
  drafts,
  notShown,
  applying: false,
  createdBy: { id: 7, name: 'Ana Ruiz' },
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  version: 1,
});
const LIST: ScenarioList = {
  plan: { id: 12, name: 'Spring launch' },
  editable: true,
  scenarios: [row(1, 'Main plan', true, 1), row(2, 'Faster', false, 1, 2)],
  limits: { scenarios: 20, draftedTickets: 10_000, perRequest: 200, perApply: 100 },
};

/** "Main plan" drafts SHOP-3 due on 25 November; "Faster" on the 17th. */
function client() {
  return fakeScenarioClient(fakePlanClient(), {
    scenarios: [
      { name: 'Main plan', drafts: [{ ticketId: 3, dueDate: '2026-11-25' }] },
      { name: 'Faster', drafts: [{ ticketId: 3, dueDate: '2026-11-17' }] },
    ],
    notShown: { Faster: 2 },
  });
}

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** A plan's scenarios and the comparison of two sides (PLN-003; ADR-122 stage 6). */
const meta = {
  title: 'Plans/PlanScenariosPage',
  component: PlanScenariosPage,
  args: {
    planId: 12,
    list: LIST,
    failed: false,
    client: client(),
    view: { filters: {}, group: null, compare: { a: '1', b: '2' } },
    onChanged: fn(),
    onCompare: fn(),
    onAutoSchedule: fn(),
  },
} satisfies Meta<typeof PlanScenariosPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each scenario, the main one in words; the two compared, the difference said. */
export const Scenarios: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Auto-schedule… beside New scenario, for the plan's editors (ADR-122 stage 7).
    await userEvent.click(canvas.getByRole('button', { name: 'Auto-schedule…' }));
    await expect(args.onAutoSchedule).toHaveBeenCalled();
    await expect(
      canvas.getByRole('heading', { name: /^Main plan.*Main$/, level: 3 }),
    ).toBeVisible();
    await expect(
      canvas.getByText('1 change 2 more changes are on tickets this plan does not show you.'),
    ).toBeVisible();
    const measures = await canvas.findByRole('table', { name: 'The plan compared' });
    await expect(within(measures).getByText('Ends 7 days earlier in Faster')).toBeVisible();
  },
};

/** Delete names what goes, hidden drafts counted. */
export const DeleteAsks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete Faster' }));
    await expect(
      canvas.getByText(
        'Faster and its 1 draft change go, with 2 more on tickets hidden from you. No ticket changes.',
      ),
    ).toBeVisible();
  },
};

/** For someone who may only look. */
export const ReadOnly: Story = {
  args: { list: { ...LIST, editable: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'New scenario' })).toBeNull();
  },
};

/** On a phone's touch screen: cards per scenario, per measure and per team, nothing sideways. */
export const OnAPhone: Story = {
  args: { phone: true },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: 'The plan compared' });
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.plan-scenarios-head button',
        '.scenario-item-actions a',
        '.scenario-item-actions button',
        '.scenario-compare-sides select',
        '.scenario-differing li > a',
      ]),
    ).toEqual([]);
  },
};
