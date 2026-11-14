import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import type { TimelineItem } from './client';
import { DependencyList } from './DependencyList';
import { dependenciesOf } from './dependencies';

const item = (id: number, summary: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id,
  key: `LCH-${id}`,
  summary,
  type: 'Feature',
  level: { rank: 0, kind: 'standard' },
  parentId: null,
  status: { name: 'New', stage: 'new' },
  start: null,
  due: null,
  dated: null,
  rollup: null,
  ...extra,
});

const ITEMS = [
  item(1, 'Design the page', { start: '2026-11-02', due: '2026-11-10', dated: 'own' }),
  item(2, 'Build the page', { start: '2026-11-09', due: '2026-11-20', dated: 'own' }),
  item(3, 'Ship it', { start: '2026-11-23', due: '2026-11-25', dated: 'own' }),
  item(4, 'Old research', {
    start: '2026-11-01',
    due: '2026-11-30',
    dated: 'own',
    status: { name: 'Done', stage: 'closed' },
  }),
  item(5, 'Write the notes'),
];
const LINKS = [
  { from: 1, to: 2 },
  { from: 2, to: 3 },
  { from: 4, to: 3 },
  { from: 3, to: 5 },
];

function list(
  links = LINKS,
  elsewhere = [{ id: 3, outside: 2, unlisted: 1 }],
  items: TimelineItem[] = ITEMS,
) {
  return render(
    <I18nProvider locale="en">
      <DependencyList dependencies={dependenciesOf(items, links, elsewhere)} headingId="deps" />
    </I18nProvider>,
  );
}

describe('the dependencies as a list (PLN-006)', () => {
  it('[PLN-006] names each blocked ticket’s blockers and says in words which are late and why', () => {
    list();
    const section = screen.getByRole('region', { name: 'Dependencies' });
    expect(
      within(section).getByText('3 tickets have blockers; 1 dependency is late.'),
    ).toBeVisible();
    const entries = [...section.querySelectorAll<HTMLElement>('.dependency-entry')];
    expect(entries.map((e) => within(e).getAllByRole('link')[0]?.textContent)).toEqual([
      'LCH-2 Build the page',
      'LCH-3 Ship it',
      'LCH-5 Write the notes',
    ]);
    const build = entries[0] as HTMLElement;
    expect(build).toHaveTextContent(
      'LCH-1 Design the page Late: it ends Nov 10, 2026, but LCH-2 starts Nov 9, 2026.',
    );
    const ship = entries[1] as HTMLElement;
    expect(ship).toHaveTextContent(
      'LCH-2 Build the page On time: it ends Nov 20, 2026, before LCH-3 starts Nov 23, 2026.',
    );
    expect(ship).toHaveTextContent('LCH-4 Old research Closed: it no longer holds LCH-3 up.');
    // The others are counted and never named.
    expect(within(ship).getByText('2 tickets outside this plan')).toBeVisible();
    expect(within(ship).getByText('1 ticket of this plan not shown here')).toBeVisible();
    expect(entries[2]).toHaveTextContent(
      'LCH-3 Ship it No dates: one of the two has no dates to compare.',
    );
    // Each ticket is a link to its page.
    expect(within(build).getByRole('link', { name: 'LCH-1 Design the page' })).toHaveAttribute(
      'href',
      expect.stringContaining('/tickets/LCH-1'),
    );
  });

  it('[PLN-006] narrows to the tickets with a late blocker', async () => {
    const user = userEvent.setup();
    list();
    const only = screen.getByRole('button', { name: 'Only late ones' });
    expect(only).toHaveAttribute('aria-pressed', 'false');
    await user.click(only);
    expect(only).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'LCH-2 Build the page' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'LCH-3 Ship it' })).toBeNull();
  });

  it('[PLN-006] lets go of "Only late ones" when nothing is late any more, so the list never stands empty', async () => {
    const user = userEvent.setup();
    const view = (items: TimelineItem[]) => (
      <I18nProvider locale="en">
        <DependencyList dependencies={dependenciesOf(items, LINKS, [])} headingId="deps" />
      </I18nProvider>
    );
    const entries = () => document.querySelectorAll('.dependency-entry').length;
    const { rerender } = render(view(ITEMS));
    await user.click(screen.getByRole('button', { name: 'Only late ones' }));
    expect(entries()).toBe(1);
    // LCH-2 moves to start after LCH-1 ends, and the Timeline reads again: nothing is late.
    const moved = ITEMS.map((i) => (i.id === 2 ? { ...i, start: '2026-11-11' } : i));
    rerender(view(moved));
    expect(screen.getByText('3 tickets have blockers; none is late.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Only late ones' })).toBeNull();
    expect(entries()).toBe(3);
    // Late again: the button comes back, not pressed, over the whole list.
    rerender(view(ITEMS));
    expect(screen.getByRole('button', { name: 'Only late ones' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(entries()).toBe(3);
  });

  it('[PLN-006] says when nothing shown is blocked, and offers no filter without a late one', () => {
    list([], []);
    expect(screen.getByText('No ticket shown here is blocked.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Only late ones' })).toBeNull();
  });

  it('[PLN-006] shows a long list a hundred tickets at a time', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 250 }, (_, k) =>
      item(k + 1, `Step ${k + 1}`, { start: '2026-11-02', due: '2026-11-03', dated: 'own' }),
    );
    const chain = many.slice(1).map((i) => ({ from: i.id - 1, to: i.id }));
    list(chain, [], many);
    const entries = () => document.querySelectorAll('.dependency-entry').length;
    expect(entries()).toBe(100);
    await user.click(screen.getByRole('button', { name: 'Show 100 more' }));
    expect(entries()).toBe(200);
    await user.click(screen.getByRole('button', { name: 'Show 49 more' }));
    expect(entries()).toBe(249);
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  });

  it('[PLN-006] fits a phone without sideways scroll', () => {
    setViewportWidth(375);
    list();
    expect(screen.getByRole('region', { name: 'Dependencies' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[PLN-006] reads the same in Spanish, informally', () => {
    render(
      <I18nProvider locale="es">
        <DependencyList dependencies={dependenciesOf(ITEMS, LINKS, [])} headingId="deps" />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Dependencias' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Solo las que van con retraso' })).toBeVisible();
    expect(screen.getAllByText('Con retraso:')).toHaveLength(1);
  });
  describe('dependency options in the list (PLN-013)', () => {
    it('[PLN-013] says a chosen link type’s phrase and "Same sprint" in words', () => {
      const links = [
        { from: 1, to: 2, linkTypeId: 1, sameSprint: true },
        { from: 5, to: 3, linkTypeId: 7 },
      ];
      render(
        <I18nProvider locale="en">
          <DependencyList
            dependencies={dependenciesOf(ITEMS, links, [])}
            headingId="deps"
            linkTypes={[
              { id: 1, outward: 'blocks' },
              { id: 7, outward: 'precedes' },
            ]}
          />
        </I18nProvider>,
      );
      const section = screen.getByRole('region', { name: 'Dependencies' });
      const build = within(section)
        .getAllByRole('listitem')
        .find((li) => li.getAttribute('data-state') === 'late') as HTMLElement;
      expect(build).toHaveTextContent('LCH-1');
      expect(build).toHaveTextContent('Same sprint');
      // A blocking link says no phrase; a chosen one says its own.
      expect(build).not.toHaveTextContent('(blocks)');
      expect(section).toHaveTextContent('LCH-5 Write the notes (precedes)');
    });

    it('[PLN-013] counts the dependencies within one sprint on the ticket that waits', () => {
      const map = dependenciesOf(ITEMS, [
        { from: 1, to: 2, sameSprint: true },
        { from: 4, to: 2 },
      ]);
      expect(map.get(2)?.sameSprint).toBe(1);
      expect(map.get(2)?.blockers.map((b) => b.sameSprint)).toEqual([true, false]);
    });
  });
});
