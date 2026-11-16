import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { Level, TicketType } from '../tickettypes/client';
import { fakeSetsClient, SETS_TRACKS } from './fixtures';
import { OwnTypesSection } from './OwnTypesSection';
import type { ScopeTrack } from './trackScope';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

const OPS = SETS_TRACKS.find((t) => t.key === 'OPS') as ScopeTrack;
const LEVELS: Level[] = [
  { id: 3, kind: 'outcome', rank: 1, name: 'Outcome', description: '' },
  { id: 2, kind: 'standard', rank: 0, name: 'Standard', description: '' },
  { id: 1, kind: 'subticket', rank: -1, name: 'Subticket', description: '' },
];
const TYPES: TicketType[] = [
  {
    id: 9,
    name: 'Runbook',
    description: 'What to do when an alarm goes off.',
    icon: 'chore',
    level: { id: 2, rank: 0, name: 'Standard' },
    trackId: 4,
  },
  {
    id: 12,
    name: 'Postmortem',
    description: '',
    icon: null,
    level: { id: 3, rank: 1, name: 'Outcome' },
    trackId: 4,
  },
];

const meta = {
  title: 'Admin/Configuration sets/Its own ticket types',
  component: OwnTypesSection,
  args: {
    client: fakeSetsClient(),
    track: OPS,
    levels: LEVELS,
    types: TYPES,
    offered: new Set([9]),
    said: () => {},
    refused: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof OwnTypesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A track's own types (T-322): one its type set offers, one not yet. */
export const OwnTypes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Standard level · in its type set')).toBeVisible();
    await expect(canvas.getByText('Outcome level · not in its type set yet')).toBeVisible();
  },
};

/** New ticket type: a name, a description, a level and an icon. */
export const NewType: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New ticket type' }));
    const form = canvas.getByRole('form', { name: 'Add a ticket type' });
    await expect(within(form).getByLabelText('Level')).toHaveDisplayValue('Standard');
    await expect(within(form).getByLabelText('Plain hexagon')).toBeChecked();
  },
};

/** A type open, with Delete ticket type. */
export const TypeOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Manage ticket type Runbook' }));
    const panel = canvas.getByRole('form', { name: 'Settings of Runbook' });
    await expect(within(panel).getByLabelText('Chore')).toBeChecked();
    await expect(
      within(panel).getByRole('button', { name: 'Delete ticket type Runbook' }),
    ).toBeVisible();
  },
};

/** No type of its own yet. */
export const NoneYet: Story = {
  args: { types: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('OPS has no ticket type of its own yet.')).toBeVisible();
  },
};

/** The same at a phone's width, a type open: nothing sticks out sideways. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async (context) => {
    await TypeOpen.play?.(context);
    await fitsPhoneWidth(within(context.canvasElement));
  },
};
