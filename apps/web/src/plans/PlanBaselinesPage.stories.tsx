import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeBaselineClient } from './baselineFixtures';
import { PlanBaselinesPage } from './PlanBaselinesPage';

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** A plan's baselines and one compared with the days now (PLN-011; ADR-122 stage 9). */
const meta = {
  title: 'Plans/PlanBaselinesPage',
  component: PlanBaselinesPage,
  args: {
    planId: 12,
    planName: 'Spring launch',
    client: fakeBaselineClient({
      baselines: [
        { id: 2, name: 'Drafted', source: 'scenario', scenarioName: 'Faster' },
        { id: 1 },
      ],
      notShown: 2,
    }),
    view: { filters: {}, group: null, baseline: 1 },
    scenario: null,
    now: () => new Date('2026-11-14T09:00:00Z'),
  },
} satisfies Meta<typeof PlanBaselinesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each baseline with where its days came from; Kick-off compared below. */
export const Baselines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('From Faster · 6 tickets')).toBeVisible();
    await expect(
      await canvas.findByRole('heading', { name: 'Compared with Kick-off', level: 3 }),
    ).toBeVisible();
    await expect(
      await canvas.findByText(/^3 tickets end later than in Kick-off, by up to 14 days/),
    ).toBeVisible();
  },
};

/** Capture baseline… names today and says where the days come from. */
export const Capture: Story = {
  args: { scenario: { id: 1, name: 'Faster' }, view: { filters: {}, group: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Capture baseline…' }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog', {
      name: 'Capture baseline',
    });
    await expect(within(dialog).getByLabelText('Name')).toHaveValue('Baseline Nov 14');
    await expect(
      within(dialog).getByText(/What the Timeline shows now: Faster, drafts not applied$/),
    ).toBeVisible();
  },
};

/** At ten the button is off, with the reason in words. */
export const Full: Story = {
  args: {
    client: fakeBaselineClient({
      baselines: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `B${i + 1}` })),
    }),
    view: { filters: {}, group: null },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Capture baseline…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** For someone who may only look: Compare, nothing else. */
export const ReadOnly: Story = {
  args: { client: fakeBaselineClient({ editable: false }), view: { filters: {}, group: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Compare with Kick-off' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Capture baseline…' })).toBeNull();
  },
};

/** None yet. */
export const Empty: Story = {
  args: { client: fakeBaselineClient({ baselines: [] }), view: { filters: {}, group: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No baselines yet')).toBeVisible();
  },
};

/** On a phone's touch screen: a card per baseline, a list of tickets, nothing sideways. */
export const OnAPhone: Story = {
  tags: ['touch'],
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: 'Tickets: Later (3)' });
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.plan-scenarios-head button',
        '.plan-scenarios-head a',
        '.scenario-item-actions a',
        '.scenario-item-actions button',
        '.filter-chip',
        '.scenario-differing li > a',
      ]),
    ).toEqual([]);
  },
};
