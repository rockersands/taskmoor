import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import type { Layout, Widget } from './client';
import { WidgetGrid } from './WidgetEditor';

const note = (id: string, column: number, title: string): Widget => ({
  id,
  kind: 'introduction',
  column,
  title,
  config: { text: '' },
});

/** A dashboard's widgets being arranged, holding the list as the page does. */
function Arranging({ layout, start }: { layout: Layout; start: Widget[] }) {
  const [widgets, setWidgets] = useState(start);
  return (
    <WidgetGrid
      layout={layout}
      widgets={widgets}
      editing
      settingsOf={null}
      onSettingsOf={() => {}}
      onChange={(change) => setWidgets(change)}
      boards={[]}
      checkQuery={async () => true}
      renderWidget={(w) => <p>What {w.title} would show.</p>}
    />
  );
}

/** The pointer this file's drags use: one no other test's clicks share. */
const POINTER = 41;
const centre = (element: Element) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};
const pointer = (type: string, at: { x: number; y: number }) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: POINTER,
    pointerType: 'touch',
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
  });

/** A finger on `from` moved over `to` (its top quarter), laid out by the browser itself. */
function dragOver(from: Element, to: Element) {
  const a = centre(from);
  const box = to.getBoundingClientRect();
  const b = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 4, 24) };
  from.dispatchEvent(pointer('pointerdown', a));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(
      pointer('pointermove', { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }),
    );
  }
  return b;
}

const meta = {
  title: 'Dashboards/WidgetGrid',
  component: Arranging,
  args: {
    layout: 'three',
    start: [note('a', 0, 'Alpha'), note('b', 0, 'Bravo'), note('c', 1, 'Charlie')],
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
  // A drag a story leaves under way ends before the next one starts.
  beforeEach: () => () => {
    window.dispatchEvent(pointer('pointercancel', { x: 0, y: 0 }));
  },
} satisfies Meta<typeof Arranging>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Being arranged: each widget's grip and buttons, the hint, an empty column that takes a drop. */
export const Arranged: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Drag a widget by its grip/)).toBeVisible();
    await expect(canvas.getByText('Column 3 is empty: drop a widget here.')).toBeVisible();
  },
};

/** Alpha in hand over Charlie: the column and the place it would land are marked (T-162). */
export const DropTarget: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas
      .getByRole('article', { name: 'Alpha' })
      .querySelector('.dashboard-widget-grip') as Element;
    dragOver(grip, canvas.getByRole('article', { name: 'Charlie' }));
    await waitFor(() =>
      expect(canvas.getByRole('article', { name: 'Charlie' })).toHaveClass('is-drop-before'),
    );
    await expect(canvasElement.querySelector('[data-drop-column="1"]') as HTMLElement).toHaveClass(
      'is-drop-target',
    );
    await expect(canvas.getByRole('article', { name: 'Alpha' })).toHaveClass('is-dragging');
    await expect(document.querySelector('.drag-ghost')).toHaveTextContent('Alpha');
  },
};

/** Dropped there by a finger: Alpha leads the second column, and the page says so. */
export const Dropped: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas
      .getByRole('article', { name: 'Alpha' })
      .querySelector('.dashboard-widget-grip') as Element;
    const at = dragOver(grip, canvas.getByRole('article', { name: 'Charlie' }));
    window.dispatchEvent(pointer('pointerup', at));
    const second = canvasElement.querySelector('[data-drop-column="1"]') as HTMLElement;
    await waitFor(() =>
      expect(
        within(second)
          .getAllByRole('article')
          .map((x) => x.getAttribute('aria-label')),
      ).toEqual(['Alpha', 'Charlie']),
    );
    await expect(canvasElement.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Alpha is now in column 2, 1 of 2.',
    );
  },
};

/** Into the empty third column. */
export const IntoAnEmptyColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas
      .getByRole('article', { name: 'Bravo' })
      .querySelector('.dashboard-widget-grip') as Element;
    const at = dragOver(grip, canvas.getByText('Column 3 is empty: drop a widget here.'));
    window.dispatchEvent(pointer('pointerup', at));
    const third = canvasElement.querySelector('[data-drop-column="2"]') as HTMLElement;
    await waitFor(() =>
      expect(within(third).getByRole('article', { name: 'Bravo' })).toBeVisible(),
    );
  },
};

/**
 * On a phone the columns stack, nothing sticks out sideways, and a finger still drops a widget
 * into a column below. Laid out by the browser at a phone's width: jsdom lays out nothing.
 */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const columns = [...canvasElement.querySelectorAll<HTMLElement>('[data-drop-column]')];
    await expect(columns).toHaveLength(3);
    // One above the other, from the same edge.
    const boxes = columns.map((column) => column.getBoundingClientRect());
    for (const [i, box] of boxes.entries()) {
      const above = boxes[i - 1];
      if (!above) continue;
      await expect(box.left).toBe(above.left);
      await expect(box.top).toBeGreaterThanOrEqual(above.bottom);
    }
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
    // Charlie, by its grip, into the empty third column under the second.
    const empty = canvas.getByText('Column 3 is empty: drop a widget here.');
    empty.scrollIntoView({ block: 'center' });
    const grip = canvas
      .getByRole('article', { name: 'Charlie' })
      .querySelector('.dashboard-widget-grip') as Element;
    window.dispatchEvent(pointer('pointerup', dragOver(grip, empty)));
    const third = columns[2] as HTMLElement;
    await waitFor(() =>
      expect(within(third).getByRole('article', { name: 'Charlie' })).toBeVisible(),
    );
    await expect(canvasElement.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Charlie is now in column 3, 1 of 1.',
    );
  },
};
