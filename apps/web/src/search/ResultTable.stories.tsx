import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { DEFAULT_COLUMNS } from './columns';
import { fakeSearchClient, TICKETS } from './fixtures';
import { ResultRows, ResultTable } from './ResultTable';

const FIELDS = [
  { id: 40, name: 'Customer', type: 'text' },
  { id: 41, name: 'Points', type: 'number' },
];

const meta = {
  title: 'Search/ResultTable',
  component: ResultTable,
  args: {
    tickets: TICKETS,
    columns: [...DEFAULT_COLUMNS, 'labels', 'cf[40]', 'cf[41]'],
    fields: FIELDS,
    client: fakeSearchClient(),
    onSaved: () => {},
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ResultTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Results in the default columns, labels and two custom fields. */
export const Results: Story = {};

/** A summary being edited in place. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Summary of SHOP-41' }));
    await expect(canvas.getByRole('textbox', { name: 'Edit Summary of SHOP-41' })).toHaveFocus();
  },
};

/** An edit a status lock refused, shown on its cell. */
export const Refused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Summary of OPS-12' }));
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Edit Summary of OPS-12' }),
      '!{Enter}',
    );
    await expect(await canvas.findByRole('alert')).toHaveTextContent('In status Closed');
  },
};

/** The column the rows are sorted by, marked with an arrow and `aria-sort` (PL-11). */
export const Sorted: Story = {
  args: { sort: { column: 'updatedAt', direction: 'descending' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('columnheader', { name: /^Updated/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  },
};

/**
 * The same tickets on a phone (TR-1, PL-1; D1): stacked rows of key, summary, then status,
 * assignee and priority, inside a phone's width with nothing sticking out, the key a finger wide.
 */
export const StackedOnAPhone: Story = {
  beforeEach: asOnATouchScreen,
  render: (args) => (
    <div data-testid="phone-width" style={{ width: 360 }}>
      <ResultRows {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getByRole('list', { name: 'Tickets' });
    await expect(within(rows).getAllByRole('listitem')).toHaveLength(TICKETS.length);
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(tooSmallForAFinger(canvasElement, ['.result-row-key > a'])).toEqual([]);
  },
};
