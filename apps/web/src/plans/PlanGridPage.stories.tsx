import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { gripsTooSmall, onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { BY_STATUS, ESTIMATES, fakeGridClient } from './grid/clientFixtures';
import { PlanGridPage } from './PlanGridPage';

const estimates = () =>
  fakeGridClient({ structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] });
const first = estimates();

/**
 * A plan's Grid (PLN-010; ADR-122 stage 10): the plan's tickets as a tree from a saved structure,
 * with totals of the rows below and a formula column; hidden tickets only counted.
 */
const meta = {
  title: 'Plans/PlanGridPage',
  component: PlanGridPage,
  args: {
    planId: 12,
    view: { filters: {}, group: null },
    scenario: null,
    client: first,
    search: first.search,
  },
} satisfies Meta<typeof PlanGridPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A saved structure: estimates and points totalled, progress by closed tickets, a formula. */
export const Estimates: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole('treegrid', { name: 'Estimates' });
    await expect(within(tree).getByText('2 of 4 closed')).toBeVisible();
    await expect(within(tree).getByText('Not in this plan')).toBeVisible();
    await expect(within(tree).getAllByText('+1 not shown')).toHaveLength(2);
    await expect(await within(tree).findByText('Refunds fail for expired cards')).toBeVisible();
  },
};

/** The unsaved default, for a plan with no structure yet. */
export const Default: Story = {
  args: (() => {
    const client = fakeGridClient();
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('treegrid', { name: 'Default structure' })).toBeVisible();
    await expect(canvas.getByText(/^This is the default structure, not saved/)).toBeVisible();
  },
};

/** Grouped by status: each group names its field and value, "No value" for none. */
export const Grouped: Story = {
  args: (() => {
    const client = fakeGridClient({
      skeleton: 'grouped',
      structures: [{ id: 5, name: 'By status', spec: BY_STATUS }],
    });
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Status: No value')).toBeVisible();
  },
};

/** Collapsed with the keyboard: Left closes a row, Right opens it again. */
export const Keyboard: Story = {
  args: (() => {
    const client = estimates();
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole('treegrid', { name: 'Estimates' });
    const row = within(tree).getAllByRole('row')[1] as HTMLElement;
    row.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{ArrowRight}');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  },
};

/** Inside a scenario: live values, read-only. */
export const InAScenario: Story = {
  args: (() => {
    const client = estimates();
    return {
      client,
      search: client.search,
      view: { filters: {}, group: null, scenario: 4 },
      scenario: { id: 4, name: 'Faster' },
    };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/^The Grid shows tickets as they are, not drafts/),
    ).toBeVisible();
    await canvas.findByText('Refunds fail for expired cards');
    await expect(canvas.queryByRole('button', { name: /^Edit Summary of/ })).toBeNull();
  },
};

/** A read that ran too long: refused, nothing shown in part. */
export const TooLong: Story = {
  args: (() => {
    const client = fakeGridClient({ timeout: true });
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(/took too long/);
    await expect(canvas.queryByRole('treegrid')).toBeNull();
  },
};

/** No rows: what would be here and why. */
export const Empty: Story = {
  args: (() => {
    const client = fakeGridClient({ skeleton: 'empty' });
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No rows in this structure')).toBeVisible();
  },
};

/** 100,000 rows, drawn as a window of a few dozen. */
export const HundredThousandRows: Story = {
  args: (() => {
    const client = fakeGridClient({ skeleton: 100_000 });
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole('treegrid', { name: 'Default structure' });
    await expect(tree).toHaveAttribute('aria-rowcount', '100002');
    await expect(within(tree).getAllByRole('row').length).toBeLessThan(120);
  },
};

/** On a phone's touch screen: cards a finger can open, and nothing sideways. */
export const OnAPhone: Story = {
  args: (() => {
    const client = estimates();
    return { client, search: client.search };
  })(),
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: '9 rows' });
    await expect(canvas.queryByRole('treegrid')).toBeNull();
    const doc = canvasElement.ownerDocument.documentElement;
    await waitFor(() => expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth));
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.plan-grid-card-toggle',
        '.plan-grid-card-open',
        '.plan-grid-actions button',
        '.plan-grid-expand button',
        '.plan-grid-tools select',
      ]),
    ).toEqual([]);
  },
};

/** A desktop on a touch screen: each row's expand button is a finger's size. */
export const OnATouchScreen: Story = {
  args: (() => {
    const client = estimates();
    return { client, search: client.search };
  })(),
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('treegrid');
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.plan-grid-toggle',
        '.plan-grid-actions button',
        '.plan-grid-expand button',
      ]),
    ).toEqual([]);
  },
};

/** Moving a row: its grip's menu, Move under, a parent chosen, then the question before it moves. */
export const MoveUnder: Story = {
  args: (() => {
    const client = estimates();
    return { client, search: client.search };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('treegrid', { name: 'Estimates' });
    await canvas.findByText('Dark mode for receipts');
    await userEvent.click(canvas.getByRole('button', { name: 'Move SHOP-70' }));
    await userEvent.click(await body.findByRole('menuitem', { name: 'Move under…' }));
    const dialog = await body.findByRole('dialog', { name: 'Move SHOP-70 under…' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^SHOP-2/ }));
    await expect(within(dialog).getByText('Move SHOP-70 under SHOP-2?')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await expect(await canvas.findByText('SHOP-70 moved under SHOP-2.')).toBeVisible();
    await waitFor(() =>
      expect(canvas.getByRole('rowheader', { name: /SHOP-70/ }).parentElement).toHaveAttribute(
        'aria-level',
        '2',
      ),
    );
  },
};

/** A desktop on a touch screen: each row's grip is a finger's size. */
export const GripsOnATouchScreen: Story = {
  args: (() => {
    const client = estimates();
    return { client, search: client.search };
  })(),
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('treegrid');
    await expect(await gripsTooSmall(canvasElement, ['.plan-grid-grip .move-grip-handle'])).toEqual(
      [],
    );
  },
};
