import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { ScenarioBar } from './ScenarioBar';
import type { ScenarioList, ScenarioRow } from './scenarioClient';

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
const MAIN = row(1, 'Main plan', true, 3);
const FASTER = { ...row(2, 'Faster', false, 12), notShown: 3 };
const list = (editable = true): ScenarioList => ({
  plan: { id: 12, name: 'Spring launch' },
  editable,
  scenarios: [MAIN, FASTER],
  limits: { scenarios: 20, draftedTickets: 10_000, perRequest: 200, perApply: 100 },
});

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** The scenario a plan's tabs read (ADR-122 stage 6), and what an edit does there. */
const meta = {
  title: 'Plans/ScenarioBar',
  component: ScenarioBar,
  args: {
    list: list(),
    active: null,
    missing: false,
    changesHref: '#/plans/12/changes?scenario=2',
    onChoose: fn(),
    onNew: fn(),
    onAutoSchedule: fn(),
  },
} satisfies Meta<typeof ScenarioBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Live: edits change tickets now. */
export const Live: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'Scenario' })).toHaveAccessibleDescription(
      'Changes you make here change tickets now.',
    );
  },
};

/** An editor drafting in Faster, with drafts on hidden tickets only counted, and Auto-schedule. */
export const Drafting: Story = {
  args: { active: FASTER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Review 12 changes' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Auto-schedule…' })).toBeVisible();
    await expect(
      canvas.getByText(/^Drafting in Faster: 12 changes\. .* 3 more changes are on tickets/),
    ).toBeVisible();
  },
};

/** Someone who sees the plan but may not draft. */
export const Viewing: Story = {
  args: { active: FASTER, list: list(false) },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/^Viewing Faster\. Only the plan’s owner/),
    ).toBeVisible();
    await expect(
      within(canvasElement).queryByRole('button', { name: 'Auto-schedule…' }),
    ).toBeNull();
  },
};

/** A link to a scenario that is gone: the plan live, said. */
export const Missing: Story = {
  args: { missing: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'That scenario no longer exists',
    );
  },
};

/** On a phone's touch screen: the select full width and a finger's height, nothing sideways. */
export const OnAPhone: Story = {
  args: { active: FASTER },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.scenario-bar select',
        '.scenario-bar-review',
        '.scenario-bar-schedule',
      ]),
    ).toEqual([]);
  },
};
