import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { fakePlanClient } from './fixtures';
import { ScenarioCompare } from './ScenarioCompare';
import type { ScenarioRow } from './scenarioClient';
import { fakeScenarioClient } from './scenarioFixtures';

const FASTER: ScenarioRow = {
  id: 1,
  name: 'Faster',
  main: true,
  drafts: 1,
  notShown: 0,
  applying: false,
  createdBy: { id: 7, name: 'Ana Ruiz' },
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  version: 1,
};

/** Faster drafts SHOP-3 due on 30 November, after the plan's live end on the 20th. */
const client = () =>
  fakeScenarioClient(fakePlanClient(), {
    scenarios: [{ name: 'Faster', drafts: [{ ticketId: 3, dueDate: '2026-11-30' }] }],
  });

/** The tickets as they are against a scenario (PLN-003; ADR-122 stage 6). */
const meta = {
  title: 'Plans/ScenarioCompare',
  component: ScenarioCompare,
  args: {
    planId: 12,
    client: client(),
    scenarios: [FASTER],
    filters: {},
    a: 'live',
    b: '1',
    onChange: fn(),
  },
} satisfies Meta<typeof ScenarioCompare>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AsTables: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const measures = await canvas.findByRole('table', { name: 'The plan compared' });
    await expect(within(measures).getByText('Ends 10 days later in Faster')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: '1 ticket differs' })).toBeVisible();
  },
};

/** A card per measure and per team, as on a phone. */
export const AsCards: Story = {
  args: { phone: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const measures = await canvas.findByRole('list', { name: 'The plan compared' });
    await expect(within(measures).getByText('Ends 10 days later in Faster')).toBeVisible();
    await expect(canvas.queryByRole('table')).toBeNull();
  },
};
