import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Timeline } from './client';
import { fakeTimelineClient, manyItems } from './fixtures';
import { TimelineView } from './TimelineView';

const ROW = 44;

function view(data: Timeline) {
  return (
    <I18nProvider locale="en">
      <TimelineView
        data={data}
        reschedule={async () => ({ ok: true })}
        reload={() => {}}
        now={() => new Date('2026-11-04T09:00:00Z')}
        truncatedText="cut"
      />
    </I18nProvider>
  );
}

/** jsdom has no layout: the scroll position is whatever the test says it is. */
function scrollTo(top: number) {
  const el = document.querySelector('.timeline-scroll') as HTMLElement;
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
  act(() => {
    fireEvent.scroll(el);
  });
}

beforeEach(() => {
  // Scroll steps land at once.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a long timeline (PLN-012)', () => {
  it('[PLN-012] draws the rows where the list stands when it is windowed again', () => {
    const { rerender } = render(view(manyItems(300)));
    expect(screen.getByRole('link', { name: 'LCH-1' })).toBeInTheDocument();
    scrollTo(150 * ROW);
    expect(screen.queryByRole('link', { name: 'LCH-1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'LCH-151' })).toBeInTheDocument();
    // A filter leaves 150 rows: no windowing, and the browser puts the list back at the top.
    rerender(view(manyItems(150)));
    const el = document.querySelector('.timeline-scroll') as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0 });
    // Cleared: 300 rows again, windowed from the top where the list now stands.
    rerender(view(manyItems(300)));
    expect(screen.getByRole('link', { name: 'LCH-1' })).toBeInTheDocument();
  });

  it('[PLN-012] keeps the focused bar drawn, and focused, while it scrolls out of view', () => {
    render(view(manyItems(300)));
    const bar = screen.getByRole('button', { name: /^LCH-2: / });
    act(() => bar.focus());
    expect(document.activeElement).toBe(bar);
    scrollTo(150 * ROW);
    expect(screen.queryByRole('link', { name: 'LCH-3' })).toBeNull();
    expect(bar).toBeInTheDocument();
    expect(document.activeElement).toBe(bar);
    // It stays at its own place, out of the rows in view.
    expect((bar.closest('li') as HTMLElement).style.top).toBe(`${1 * ROW}px`);
    // Back in view, it is an ordinary row again, still focused.
    scrollTo(0);
    expect(document.activeElement).toBe(bar);
    expect((bar.closest('li') as HTMLElement).style.position).toBe('');
  });
});

/** Gives the chart a box: jsdom has no layout, so the sizes are whatever the test says. */
function layOut(el: HTMLElement, box: { width: number; height: number; content: number }) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: box.width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.height });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.content });
  const corner = el.querySelector('.timeline-corner') as HTMLElement;
  Object.defineProperty(corner, 'offsetWidth', { configurable: true, value: 200 });
}

describe('what the chart shows and where (PLN-012)', () => {
  it('[PLN-012] marks a bar outside the days in view at that edge, and the marker shows it', () => {
    render(view(fakeTimelineClient().data()));
    const chart = screen.getByRole('region', { name: 'Tickets by date' });
    // 400px of lanes in view, scrolled to days after every bar: all of them lie before.
    layOut(chart, { width: 600, height: 400, content: 400 });
    chart.scrollLeft = 2000;
    act(() => {
      fireEvent.scroll(chart);
    });
    const earlier = screen.getByRole('button', {
      name: 'Earlier: LCH-2 ends Nov 10, 2026, before the days shown. Show it',
    });
    expect(earlier).toHaveTextContent(/^Earlier$/);
    // It sits at the left edge of the lanes in view.
    expect(earlier.style.left).toBe('2000px');
    // Back at the start of the range, a bar after the days in view is marked "Later".
    chart.scrollLeft = 0;
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(screen.queryByRole('button', { name: /^Earlier: LCH-2 / })).toBeNull();
    const later = screen.getByRole('button', { name: /^Later: LCH-4 starts Nov 12, 2026/ });
    act(() => later.click());
    // Its start a quarter of the way into the lanes in view.
    expect(chart.scrollLeft).toBeGreaterThan(0);
  });

  it('[PLN-012] fades the card’s lower edge while rows wait below, and is reached by keyboard', () => {
    render(view(fakeTimelineClient().data()));
    const chart = screen.getByRole('region', { name: 'Tickets by date' });
    expect(chart).toHaveAttribute('tabindex', '0');
    layOut(chart, { width: 600, height: 200, content: 600 });
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(chart).toHaveClass('has-more-below');
    Object.defineProperty(chart, 'scrollTop', { configurable: true, value: 400 });
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(chart).not.toHaveClass('has-more-below');
  });

  it('[PLN-012] explains its bar styles in a legend, only those it draws (D29)', () => {
    render(view(fakeTimelineClient().data()));
    const legend = screen.getByRole('list', { name: 'What the bars mean' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'A ticket’s own dates',
      'Dates from its sprint',
      'Rolled up from its children',
      'Share of children closed',
      'No dates yet',
      'Today',
      'Release',
      'Blocks the ticket it leads to',
    ]);
  });

  it('[PLN-012] gives the side panel a column only while it is open', () => {
    render(view(fakeTimelineClient().data()));
    const body = document.querySelector('.timeline-body') as HTMLElement;
    expect(body).not.toHaveClass('has-panel');
    act(() => screen.getByRole('button', { name: /^LCH-2: / }).click());
    expect(body).toHaveClass('has-panel');
  });
});
