import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { CUSTOM_WIDGETS, fakeTrackClient, SHOP_SUMMARY } from './fixtures';
import { TrackSummaryPage } from './TrackSummaryPage';

const CUSTOM = { layout: 'two' as const, version: 1, widgets: CUSTOM_WIDGETS };

const meta = {
  title: 'Tracks/TrackSummaryPage',
  component: TrackSummaryPage,
  args: { trackKey: 'SHOP', client: fakeTrackClient(), checkQuery: async () => true },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrackSummaryPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open, new, closed and due tickets, and the open ones by stage, priority, type and person. */
export const Summary: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Open by assignee' })).toBeVisible();
  },
};

/** Where each of a grid's boxes starts, row by row: the left edges of each row, top to bottom. */
const rows = (boxes: Element[]) => {
  const byTop = new Map<number, number[]>();
  for (const box of boxes) {
    const { top, left } = box.getBoundingClientRect();
    byTop.set(Math.round(top), [...(byTop.get(Math.round(top)) ?? []), Math.round(left)]);
  }
  return [...byTop.values()];
};

/** Where each of a column's boxes sits, column by column: their tops and bottoms, left to right. */
const columnsOf = (boxes: Element[]) => {
  const byLeft = new Map<number, DOMRect[]>();
  for (const box of boxes) {
    const rect = box.getBoundingClientRect();
    byLeft.set(Math.round(rect.left), [...(byLeft.get(Math.round(rect.left)) ?? []), rect]);
  }
  return [...byLeft.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, column]) => column.sort((a, b) => a.top - b.top));
};

/**
 * The numbers line up (TR-30): every tile's number on one line, however its label wraps, and the
 * sections fill both columns, never three beside a lone fourth's empty half, at a laptop's width.
 */
export const RowsThatFill: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 960 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Open by assignee' });
    const numbers = Array.from(canvasElement.querySelectorAll('.report-stats dd'));
    await expect(
      new Set(numbers.map((n) => Math.round(n.getBoundingClientRect().bottom))).size,
    ).toBe(1);
    const columns = columnsOf(Array.from(canvasElement.querySelectorAll('.summary-section')));
    await expect(columns).toHaveLength(2);
    await expect(columns.every((column) => column.length > 0)).toBe(true);
  },
};

/**
 * The third sweep: a short section has the next one right under it in its column, the cards' own
 * gap apart, never a hole as tall as its neighbour's longer list.
 */
export const NoHoleUnderAShortSection: Story = {
  args: {
    // Six priorities beside three stages: the priority list runs far longer.
    client: fakeTrackClient({
      ...SHOP_SUMMARY,
      priorities: ['Urgent', 'High', 'Medium', 'Low', 'Lowest', 'Someday'].map((name, at) => ({
        id: name,
        name,
        query: `track = SHOP AND priority = "${name}"`,
        count: at + 1,
        exact: true,
      })),
    }),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 960 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Open by assignee' });
    const columns = columnsOf(Array.from(canvasElement.querySelectorAll('.summary-section')));
    const gaps = columns.flatMap((column) =>
      column.slice(1).map((box, at) => Math.round(box.top - (column[at] as DOMRect).bottom)),
    );
    await expect(gaps.length).toBeGreaterThan(0);
    await expect(gaps).toEqual(gaps.map(() => 16));
  },
};

/**
 * Each section ends at its content (RPT-006; second sweep): a short list beside a long one leaves
 * no empty card under it, as a plan's Summary does (PL-37).
 */
export const SectionsEndAtTheirContent: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 960 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Open by assignee' });
    const sections = Array.from(canvasElement.querySelectorAll<HTMLElement>('.summary-section'));
    await expect(sections.length).toBeGreaterThan(1);
    const empty = sections.map((section) => {
      const last = section.lastElementChild?.getBoundingClientRect().bottom ?? 0;
      const style = getComputedStyle(section);
      const edge =
        Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
      return Math.round(section.getBoundingClientRect().bottom - edge - last);
    });
    await expect(empty).toEqual(sections.map(() => 0));
  },
};

/** On a phone the tiles go two to a row and the fifth spans the last row, never alone in half. */
export const RowsThatFillOnAPhone: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 340 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Open by assignee' });
    const tiles = Array.from(canvasElement.querySelectorAll('.report-stats > div'));
    await expect(rows(tiles).map((row) => row.length)).toEqual([2, 2, 1]);
    const [first, , , , last] = tiles.map((tile) => tile.getBoundingClientRect());
    await expect(Math.round(last?.width ?? 0)).toBeGreaterThan(
      Math.round((first?.width ?? 0) * 1.5),
    );
  },
};

export const NotFound: Story = { args: { client: fakeTrackClient(null) } };

/** The widgets chosen for the track, as anyone who may only read it sees them. */
export const CustomizedForAViewer: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('article', { name: 'Open bugs' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Customise' })).toBeNull();
  },
};

/** What the track's owner and administrators can change, while they change it. */
export const Customizing: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM, mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Customise' }));
    await expect(await canvas.findByRole('button', { name: 'Save the summary' })).toBeVisible();
  },
};

/** Before anyone customized it, for someone who may. */
export const DefaultForAnAdministrator: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Customise' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Back to the default' })).toBeNull();
  },
};

/** Opens the question before going back to the default (D13, T-273). */
const askToGoBack = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Back to the default' }));
  await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  return canvas;
};
const RESETTABLE = {
  client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM, mayCustomize: true }),
};
const RESET_OUTCOME =
  'The summary of Shop returns to the default for everyone, and the widgets chosen for it are removed. This cannot be undone.';

/**
 * Back to the default removes the track's widgets for everyone, so it asks first (D13, T-273): the
 * button looks like a danger, and the question in its place says what will happen.
 */
export const AskingToGoBackToTheDefault: Story = {
  args: RESETTABLE,
  play: async ({ canvasElement }) => {
    const canvas = await askToGoBack(canvasElement);
    await expect(canvas.getByRole('group', { name: RESET_OUTCOME })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Reset the summary of Shop' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Open bugs' })).toBeVisible();
  },
};

/** The question on a phone: under the title, nothing sideways. */
export const AskingToGoBackOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: RESETTABLE,
  play: async ({ canvasElement }) => {
    await askToGoBack(canvasElement);
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

/** A finger reaches both answers (ADR-033). */
export const AskingToGoBackOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  args: RESETTABLE,
  play: async ({ canvasElement }) => {
    await askToGoBack(canvasElement);
    await expect(tooSmallForAFinger(canvasElement, ['.danger-confirm button'])).toEqual([]);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const PhoneCustomizing: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM, mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Customise' }));
    await expect(await canvas.findByRole('button', { name: 'Save the summary' })).toBeVisible();
  },
};

/** A finger reaches every number, however few its digits (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('listitem');
    await expect(tooSmallForAFinger(canvasElement, ['.report-stats a', '.summary-list a'])).toEqual(
      [],
    );
  },
};

/** The address of a Summary a person filtered for themselves (T-075a). */
const filtered = (filter: string) => () => {
  window.history.replaceState(null, '', `#/tracks/SHOP?${new URLSearchParams({ filter })}`);
  return () => window.history.replaceState(null, '', '#/');
};

/**
 * A member's own filter (RPT-006 "view and filter"; T-075a): every number counts only their
 * tickets, and the page says plainly that no one else sees it.
 */
export const FilteredForThemselves: Story = {
  beforeEach: filtered('assignee = currentUser()'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: '8' })).toBeVisible();
    await expect(
      canvas.getByText('Showing only the tickets that match assignee = currentUser().'),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Clear the filter' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Customise' })).toBeNull();
  },
};

/** A customized Summary, filtered: its widgets narrow too. */
export const CustomizedAndFiltered: Story = {
  beforeEach: filtered('type = Bug'),
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('article', { name: 'Open bugs' })).toBeVisible();
    await expect(canvas.getByText('Showing only the tickets that match type = Bug.')).toBeVisible();
  },
};

/** The filter on a phone: its buttons under the field, nothing sideways. */
export const FilteredOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: filtered('assignee = currentUser()'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: '8' });
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

/** A finger reaches the filter's field and each of its buttons (ADR-033). */
export const FilterOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: async () => {
    const touch = await onARealTouchScreen();
    const address = filtered('assignee = currentUser()')();
    return async () => {
      await touch();
      address();
    };
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: '8' });
    await expect(
      tooSmallForAFinger(canvasElement, ['.summary-filter input', '.summary-filter button']),
    ).toEqual([]);
  },
};
