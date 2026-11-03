import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactElement, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { BasicFilters } from './BasicFilters';
import type { BasicQuery } from './basic';
import { fakeSearchClient } from './fixtures';

const TRACKS = [
  { key: 'SHOP', name: 'Shop' },
  { key: 'OPS', name: 'Operations' },
];

/** Holds the choices, as the search page does. */
function Live({ start }: { start: BasicQuery }) {
  const [basic, setBasic] = useState(start);
  return (
    <form aria-label="Filters" className="search-basic glass-card">
      <BasicFilters basic={basic} tracks={TRACKS} client={fakeSearchClient()} onChange={setBasic} />
    </form>
  );
}

const EMPTY: BasicQuery = { tracks: [], stages: [], assignee: 'any', text: '' };

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

const meta = {
  title: 'Search/BasicFilters',
  component: Live,
  args: { start: EMPTY },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Live>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing added: only the control that adds a filter. */
export const NoFilters: Story = {};

/** Each date filter's forms: on a day, before one, after one and between two. */
export const Dates: Story = {
  args: {
    start: {
      ...EMPTY,
      dates: [
        { field: 'created', op: 'on', from: '2026-10-31' },
        { field: 'updated', op: 'after', from: '2026-10-01' },
        { field: 'due', op: 'between', from: '2026-10-01', to: '2026-10-31' },
        { field: 'start', op: 'between', from: '2026-11-01', to: '2026-10-01' },
        { field: 'closed', op: 'before', from: '' },
      ],
    },
  },
};

/** Values of fields: check boxes for short lists, a box with suggestions for the rest. */
export const Values: Story = {
  args: {
    start: {
      ...EMPTY,
      tracks: ['SHOP'],
      choices: {
        type: ['Bug'],
        priority: [],
        labels: ['refunds', 'needs "review"'],
        requester: ['currentUser()', 'Rin Okafor'],
        targetRelease: ['1.0'],
        area: [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox', { name: 'Bug' })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove refunds from Labels' }));
    await expect(canvas.queryByRole('button', { name: 'Remove refunds from Labels' })).toBeNull();
  },
};

/** Every kind of filter at the width of a small phone (ADR-033): rows wrap, nothing sticks out. */
export const PhoneWidth: Story = {
  args: {
    start: {
      ...EMPTY,
      tracks: ['SHOP'],
      choices: {
        type: ['Bug'],
        labels: ['a-very-long-label-that-has-no-spaces-to-break-at-anywhere-in-it'],
        requester: ['currentUser()'],
        area: [],
      },
      dates: [
        { field: 'created', op: 'between', from: '2026-10-01', to: '2026-10-31' },
        { field: 'due', op: 'on', from: '' },
      ],
    },
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'Bug' });
    await fitsPhoneWidth(canvas);
  },
};
