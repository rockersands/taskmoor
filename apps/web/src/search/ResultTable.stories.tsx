import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import type { SearchTicket } from './client';
import { DEFAULT_COLUMNS } from './columns';
import { fakeSearchClient, TICKETS } from './fixtures';
import { ResultGrid, ResultRows, ResultTable } from './ResultTable';

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

/**
 * A cell open for editing keeps its row still (QRY-014): the text box always shows focus, so the
 * row shows no icon words while it is open, and a click moving focus from the box to Save cannot
 * shift the columns between press and release.
 */
export const EditingKeepsItsPlace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Labels of SHOP-41' }));
    const box = canvas.getByRole('textbox', { name: 'Edit Labels of SHOP-41' });
    await expect(box).toHaveFocus();
    await expect(box.matches(':focus-visible')).toBe(true);
    const row = box.closest('tr');
    const words = Array.from(row?.querySelectorAll('.ticket-icon-word') ?? []);
    await expect(words.length).toBeGreaterThan(0);
    for (const word of words) await expect(getComputedStyle(word).display).toBe('none');
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
  beforeEach: onARealTouchScreen,
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

/** Tickets with the longest values a track's list shows: a 12:00 PM date, two-word names. */
const LONG: SearchTicket[] = [
  ['MOB-2', 'Home screen widget returns an error 500 at midnight', 'Chen Wei', '2026-08-29T12:00'],
  ['MOB-31', 'Show progress in the sync conflict dialog', 'Dara Kowalski', '2026-09-15T12:00'],
  ['MOB-45', 'Photo upload loses unsaved changes', null, '2026-09-16T00:00'],
].map(([key, summary, assignee, updatedAt], at) => ({
  id: at + 1,
  key: key as string,
  summary: summary as string,
  status: { name: 'In Review', stage: 'active' as const },
  ticketType: { name: 'Bug' },
  assignee: assignee ? { id: at + 1, name: assignee } : null,
  priority: { id: 2, name: 'Medium' },
  labels: [],
  fields: {},
  version: 1,
  updatedAt: updatedAt as string,
}));

/** One subticket under MOB-2, so its key cell carries '0/1 subtickets closed' (PL-31). */
const withProgress = {
  ...fakeSearchClient(),
  subticketProgress: async () => ({ '1': { total: 1, closed: 0 } }),
};

const cellsOf = (table: HTMLElement, column: string) =>
  Array.from(table.querySelectorAll<HTMLElement>(`td[data-column="${column}"]`));

/** Under two lines' height: one line of text, whatever its line height. */
const oneLine = (element: Element) =>
  element.getBoundingClientRect().height <
  1.8 * Number.parseFloat(getComputedStyle(element).fontSize);

/**
 * The default columns at 1280 px (the card is about 955 px wide there; TR-8, PL-10, D1): the
 * table fits with no column cut, the key takes about its own width and the summary the rest,
 * dates and names stay on one line, an unassigned ticket says so, and each pencil keeps a clear
 * gap from the next column.
 */
export const FitsTheCardAt1280: Story = {
  args: { tickets: LONG, columns: DEFAULT_COLUMNS, client: withProgress },
  render: (args) => (
    <div style={{ width: 955 }}>
      <ResultGrid {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Result table' });
    await canvas.findByText('0/1 subtickets closed');
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
    await expect(region).toHaveAttribute('data-more', 'none');
    const table = canvas.getByRole('table');
    const [key] = canvas.getAllByRole('rowheader');
    const [summary] = cellsOf(table, 'summary');
    if (!key || !summary) throw new Error('No first row');
    await expect(key.getBoundingClientRect().width).toBeLessThan(150);
    await expect(summary.getBoundingClientRect().width).toBeGreaterThan(
      2 * key.getBoundingClientRect().width,
    );
    for (const column of ['updatedAt', 'assignee']) {
      for (const cell of cellsOf(table, column)) {
        const value = cell.querySelector('.search-cell-value');
        if (!value) throw new Error(`No value in ${column}`);
        await expect(oneLine(value), `${column}: ${value.textContent}`).toBe(true);
        await expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(
          region.getBoundingClientRect().right,
        );
      }
    }
    await expect(cellsOf(table, 'assignee')[2]).toHaveTextContent('Unassigned');
    // A pencil sits in its own cell with room before the next column's value.
    const pencil = canvas.getByRole('button', { name: 'Edit Assignee of MOB-2' });
    const next = cellsOf(table, 'priority')[0]?.querySelector('.search-cell-value');
    if (!next) throw new Error('No priority value');
    await expect(
      next.getBoundingClientRect().left - pencil.getBoundingClientRect().right,
    ).toBeGreaterThanOrEqual(32);
  },
};

/**
 * Where the columns cannot fit, the table scrolls inside its card and the edge with more beyond it
 * fades (D2), instead of a date being cut at the card's edge with no cue.
 */
export const ScrollsWithAFadeWhenNarrow: Story = {
  args: { tickets: LONG, columns: [...DEFAULT_COLUMNS, 'createdAt'] },
  render: (args) => (
    <div style={{ width: 640 }}>
      <ResultGrid {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole('region', { name: 'Result table' });
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
    await expect(getComputedStyle(region).maskImage).toContain('linear-gradient');
    region.scrollLeft = region.scrollWidth;
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'start'));
  },
};
