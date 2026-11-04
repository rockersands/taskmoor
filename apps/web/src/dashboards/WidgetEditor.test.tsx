import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import type { Layout, Widget } from './client';
import { placeWidget, WidgetGrid, widgetPlace } from './WidgetEditor';

const note = (id: string, column: number, title: string): Widget => ({
  id,
  kind: 'introduction',
  column,
  title,
  config: { text: '' },
});
const START = [note('a', 0, 'Alpha'), note('b', 0, 'Bravo'), note('c', 1, 'Charlie')];
const order = (list: Widget[]) => list.map((w) => `${w.id}${w.column}`).join(' ');

/** A dashboard's grid being edited, holding its own list as the page does. */
function Editing({ layout, start, seen }: { layout: Layout; start: Widget[]; seen: Widget[][] }) {
  const [widgets, setWidgets] = useState(start);
  return (
    <WidgetGrid
      layout={layout}
      widgets={widgets}
      editing
      settingsOf={null}
      onSettingsOf={() => {}}
      onChange={(change) =>
        setWidgets((list) => {
          const next = change(list);
          seen.push(next);
          return next;
        })
      }
      boards={[]}
      checkQuery={async () => true}
      renderWidget={(w) => <p>{w.title} content</p>}
    />
  );
}

function edit(layout: Layout = 'two', start: Widget[] = START) {
  const seen: Widget[][] = [];
  const view = render(
    <I18nProvider locale="en">
      <Editing layout={layout} start={start} seen={seen} />
    </I18nProvider>,
  );
  const last = () => seen.at(-1) ?? start;
  return { seen, last, container: view.container };
}

const card = (name: string) => screen.getByRole('article', { name });
const gripOf = (name: string) => card(name).querySelector('.dashboard-widget-grip') as HTMLElement;
const columnOf = (container: HTMLElement, column: number) =>
  container.querySelector(`[data-drop-column="${column}"]`) as HTMLElement;
const said = (container: HTMLElement) =>
  container.querySelector('[aria-live="polite"]')?.textContent ?? '';

/**
 * A drag with pointer events, as a finger or a mouse makes it: down on `from`, across the page,
 * over `to` at height `y`, then up unless the test lets go itself.
 */
function dragTo(
  from: HTMLElement,
  to: Element,
  options: { pointerType?: 'mouse' | 'touch'; y?: number; up?: boolean } = {},
) {
  const { pointerType = 'touch', y = 100, up = true } = options;
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(to);
  const point = { pointerId: 5, pointerType, isPrimary: true };
  fireEvent.pointerDown(from, { ...point, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { ...point, clientX: 60, clientY: y });
  fireEvent.pointerMove(window, { ...point, clientX: 90, clientY: y });
  if (up) fireEvent.pointerUp(window, { ...point, clientX: 90, clientY: y });
}

afterEach(() => vi.restoreAllMocks());

describe('where a dropped widget lands (T-162)', () => {
  it('[RPT-004] goes before the widget it is dropped on, or to the end of the column', () => {
    expect(order(placeWidget(START, 'a', 1, 'c'))).toBe('b0 a1 c1');
    expect(order(placeWidget(START, 'c', 0, null))).toBe('a0 b0 c0');
    expect(order(placeWidget(START, 'a', 2, null))).toBe('b0 c1 a2');
    expect(order(placeWidget(START, 'b', 0, 'a'))).toBe('b0 a0 c1');
    // Dropped on itself: nothing moves.
    expect(placeWidget(START, 'a', 0, 'a')).toBe(START);
    expect(widgetPlace(START, 'b')).toEqual({ column: 1, place: 2, count: 2 });
    expect(widgetPlace(START, 'gone')).toBeNull();
  });
});

describe('arranging widgets by drag and by keys (T-162; ADR-114, section 12)', () => {
  it('[RPT-004] a finger drags a widget by its grip to a place in another column, marked on the way and announced', () => {
    const { last, container } = edit();
    expect(screen.getByText(/Drag a widget by its grip/)).toBeVisible();
    vi.spyOn(card('Charlie'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 80, 300, 100),
    );
    dragTo(gripOf('Alpha'), card('Charlie'), { y: 90, up: false });
    expect(said(container)).toBe('Moving Alpha: drop it on a place in a column. Escape cancels.');
    expect(card('Alpha')).toHaveClass('is-dragging');
    expect(columnOf(container, 1)).toHaveClass('is-drop-target');
    expect(columnOf(container, 0)).not.toHaveClass('is-drop-target');
    expect(card('Charlie')).toHaveClass('is-drop-before');
    expect(container.ownerDocument.querySelector('.drag-ghost')).toHaveTextContent('Alpha');
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'touch', clientX: 90, clientY: 90 });
    expect(order(last())).toBe('b0 a1 c1');
    expect(
      within(columnOf(container, 1))
        .getAllByRole('article')
        .map((a) => a.ariaLabel),
    ).toEqual(['Alpha', 'Charlie']);
    expect(said(container)).toBe('Alpha is now in column 2, 1 of 2.');
    expect(container.ownerDocument.querySelector('.drag-ghost')).toBeNull();
    expect(columnOf(container, 1)).not.toHaveClass('is-drop-target');
  });

  it('[RPT-004] [NFR-005] Escape cancels a drag: nothing moves, and the page says so', () => {
    const { seen, container } = edit();
    dragTo(gripOf('Alpha'), columnOf(container, 1), { up: false });
    expect(columnOf(container, 1)).toHaveClass('is-drop-target');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(columnOf(container, 1)).not.toHaveClass('is-drop-target');
    expect(card('Alpha')).not.toHaveClass('is-dragging');
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'touch', clientX: 90, clientY: 100 });
    expect(seen).toEqual([]);
    expect(said(container)).toBe('Alpha stays where it was.');
  });

  it('[RPT-004] a mouse drags by the title too; a finger on the title leaves the page to scroll', () => {
    const { seen, last, container } = edit('three');
    // An empty column says it takes a drop.
    expect(within(columnOf(container, 2)).getByText('Column 3 is empty: drop a widget here.'));
    dragTo(within(card('Bravo')).getByRole('heading'), columnOf(container, 2), {
      pointerType: 'touch',
    });
    expect(seen).toEqual([]);
    dragTo(within(card('Bravo')).getByRole('heading'), columnOf(container, 2), {
      pointerType: 'mouse',
    });
    expect(order(last())).toBe('a0 c1 b2');
    expect(said(container)).toBe('Bravo is now in column 3, 1 of 1.');
  });

  it('[RPT-004] [NFR-005] Alt and the arrow keys on its buttons move it, keeping the keyboard there', async () => {
    const user = userEvent.setup();
    const { last, container } = edit();
    await user.click(screen.getByRole('button', { name: 'Move Alpha down' }));
    expect(order(last())).toBe('b0 a0 c1');
    expect(said(container)).toBe('Alpha is now in column 1, 2 of 2.');
    expect(screen.getByRole('button', { name: 'Move Alpha down' })).toHaveFocus();
    // At the bottom already: nothing moves, and the page says so.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(said(container)).toBe('Alpha stays where it was.');
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(last().find((w) => w.id === 'a')?.column).toBe(1);
    expect(said(container)).toBe('Alpha is now in column 2, 1 of 2.');
    // The keyboard follows the widget into its new column, on the button of that arrow.
    expect(screen.getByRole('button', { name: 'Move Alpha right' })).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(order(last())).toBe('b0 c1 a1');
    expect(said(container)).toBe('Alpha is now in column 2, 2 of 2.');
    expect(screen.getByRole('button', { name: 'Move Alpha down' })).toHaveFocus();
  });

  it('[RPT-004] a drop that changes no column says the widget stayed, and changes nothing', () => {
    const { seen, container } = edit('two', [note('a', 0, 'Alpha'), note('c', 1, 'Charlie')]);
    // At the end of its own column, where it already is.
    dragTo(gripOf('Alpha'), columnOf(container, 0));
    expect(seen).toEqual([]);
    expect(said(container)).toBe('Alpha stays where it was.');
  });

  it('[RPT-004] a drop on the lower half of the widget’s own card leaves it where it is', () => {
    const { seen, container } = edit();
    // Bravo's card is tall: the grip at its top is let go of below the card's middle.
    vi.spyOn(card('Bravo'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 80, 300, 200),
    );
    dragTo(gripOf('Bravo'), card('Bravo'), { y: 250, up: false });
    // No place above Alpha is marked: the column's first place is not where it would go.
    expect(card('Alpha')).not.toHaveClass('is-drop-before');
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'touch', clientX: 90, clientY: 250 });
    expect(seen).toEqual([]);
    expect(
      within(columnOf(container, 0))
        .getAllByRole('article')
        .map((a) => a.ariaLabel),
    ).toEqual(['Alpha', 'Bravo']);
    expect(said(container)).toBe('Bravo stays where it was.');
  });

  it('[RPT-004] on a phone, the stacked columns still take a finger’s drop, and nothing scrolls sideways', () => {
    setViewportWidth(375);
    const { last, container } = edit('three');
    dragTo(gripOf('Charlie'), columnOf(container, 2));
    expect(order(last())).toBe('a0 b0 c2');
    expect(said(container)).toBe('Charlie is now in column 3, 1 of 1.');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-004] in one column, the hint and the keys speak only of up and down', async () => {
    const user = userEvent.setup();
    const { seen } = edit('one', [note('a', 0, 'Alpha'), note('b', 0, 'Bravo')]);
    expect(screen.getByText(/Its Up and Down buttons/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Move Alpha right' })).toBeNull();
    screen.getByRole('button', { name: 'Move Alpha down' }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(seen).toEqual([]);
  });
});
