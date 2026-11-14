import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { useTimeZone } from '../test/timeZone';
import { localDay, type Timeline } from './client';
import { fakeTimelineClient, manyItems } from './fixtures';
import { TimelineView } from './TimelineView';

const ROW = 44;

function view(data: Timeline, now = () => new Date('2026-11-04T09:00:00Z')) {
  return (
    <I18nProvider locale="en">
      <TimelineView
        data={data}
        reschedule={async () => ({ ok: true })}
        reload={() => {}}
        now={now}
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

describe('a ticket whose team alone is drafted (PLN-002)', () => {
  it('[PLN-002] names its bar by its days alone, says its team is drafted and offers to undo it', () => {
    const data = manyItems(3);
    const second = data.items[1] as (typeof data.items)[number];
    data.items[1] = { ...second, draft: { fields: { '5': { now: 7 } }, stale: false } };
    render(
      <I18nProvider locale="en">
        <TimelineView
          data={data}
          reschedule={async () => ({ ok: true })}
          reload={() => {}}
          now={() => new Date('2026-11-04T09:00:00Z')}
          truncatedText="cut"
          draft={{ scenario: 'Faster', undo: async () => ({ ok: true }) }}
        />
      </I18nProvider>,
    );
    const bar = screen.getByRole('button', { name: new RegExp(`^${second.key}: `) });
    expect(bar).toHaveClass('is-draft');
    fireEvent.click(bar);
    const panel = screen.getByRole('complementary', { name: `Days of ${second.key}` });
    expect(
      within(panel).getByText('Its days are as they are now; its team is drafted.'),
    ).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Undo this draft' })).toBeVisible();
  });
});

describe('a ticket the auto-scheduler drafted (PLN-004)', () => {
  it('[PLN-004] [PLN-002] tags it "Draft, auto-scheduled" in words, and moving it makes it the person’s draft', async () => {
    const data = manyItems(3);
    const second = data.items[1] as (typeof data.items)[number];
    const third = data.items[2] as (typeof data.items)[number];
    data.items[1] = {
      ...second,
      draft: {
        startDate: { now: null },
        dueDate: { now: null },
        stale: false,
        origin: 'scheduler',
      },
    };
    data.items[2] = {
      ...third,
      draft: { dueDate: { now: null }, stale: false, origin: 'person' },
    };
    const reschedule = vi.fn(async () => ({ ok: true }) as const);
    render(
      <I18nProvider locale="en">
        <TimelineView
          data={data}
          reschedule={reschedule}
          reload={() => {}}
          now={() => new Date('2026-11-04T09:00:00Z')}
          truncatedText="cut"
          draft={{ scenario: 'Faster', undo: async () => ({ ok: true }) }}
        />
      </I18nProvider>,
    );
    // The tag is text beside the dashed edge, never the edge alone; a person's draft says Draft.
    const row = (key: string) =>
      screen.getByRole('link', { name: key }).closest('li') as HTMLElement;
    expect(within(row(second.key)).getByText('Draft, auto-scheduled')).toBeVisible();
    expect(within(row(third.key)).getByText('Draft')).toBeVisible();
    expect(within(row(third.key)).queryByText('Draft, auto-scheduled')).toBeNull();
    const bar = screen.getByRole('button', {
      name: new RegExp(`^${second.key}, draft, auto-scheduled: `),
    });
    expect(bar).toHaveClass('is-draft');
    expect(
      screen.getByRole('button', { name: new RegExp(`^${third.key}, draft: `) }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(bar, { key: 'ArrowRight', altKey: true });
    });
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nothing changed yet. Your draft now: a re-run will plan around it.',
    );
  });
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
    // In LCH-2's row, at the left edge of the lanes in view (sticky CSS holds it there).
    expect(earlier.closest('li')).toHaveAttribute('data-row', 'i:2');
    expect(earlier).toHaveClass('is-before');
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

  it('[PLN-012] draws the timeline again only when a bar crosses an edge, not on every scroll', () => {
    // `now` is read once each time the timeline is drawn.
    const now = vi.fn(() => new Date('2026-11-04T09:00:00Z'));
    render(view(fakeTimelineClient().data(), now));
    const chart = screen.getByRole('region', { name: 'Tickets by date' });
    layOut(chart, { width: 600, height: 400, content: 400 });
    chart.scrollLeft = 2000;
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(screen.getByRole('button', { name: /^Earlier: LCH-2 / })).toBeInTheDocument();
    const drawn = now.mock.calls.length;
    // Further along, with every bar still before the days in view: nothing to draw again.
    for (const left of [2010, 2040, 2100]) {
      chart.scrollLeft = left;
      act(() => {
        fireEvent.scroll(chart);
      });
    }
    expect(now.mock.calls.length).toBe(drawn);
  });

  it('[PLN-012] gives the focus to the bar a marker shows, not to the page', () => {
    render(view(fakeTimelineClient().data()));
    const chart = screen.getByRole('region', { name: 'Tickets by date' });
    layOut(chart, { width: 600, height: 400, content: 400 });
    chart.scrollLeft = 0;
    act(() => {
      fireEvent.scroll(chart);
    });
    const later = screen.getByRole('button', { name: /^Later: LCH-4 / });
    act(() => later.focus());
    act(() => later.click());
    // The scroll lands, the bar is in view and its marker goes.
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(screen.queryByRole('button', { name: /^Later: LCH-4 / })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^LCH-4: / }));
  });

  it('[PLN-012] measures the chart again when it narrows without the window, as a panel opens', () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          observed.push(this.callback);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    render(view(fakeTimelineClient().data()));
    const chart = screen.getByRole('region', { name: 'Tickets by date' });
    // From the range's start, wide enough for every bar.
    layOut(chart, { width: 5000, height: 400, content: 400 });
    chart.scrollLeft = 0;
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(screen.queryByRole('button', { name: /^Later: / })).toBeNull();
    // Narrowed, with no scroll and no window resize: only the card's own size says so.
    layOut(chart, { width: 600, height: 400, content: 400 });
    act(() => {
      for (const callback of observed) callback();
    });
    expect(screen.getByRole('button', { name: /^Later: LCH-4 / })).toBeInTheDocument();
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
    expect(chart.querySelector('.timeline-fade')).not.toBeNull();
    Object.defineProperty(chart, 'scrollTop', { configurable: true, value: 400 });
    act(() => {
      fireEvent.scroll(chart);
    });
    expect(chart).not.toHaveClass('has-more-below');
    expect(chart.querySelector('.timeline-fade')).toBeNull();
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
      // The chips' own words (S3-PL-11): one name for a ticket without dates.
      'No dates',
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

/**
 * Start and due dates are calendar days, and today is the person's own day: at 8 pm in Mexico
 * City (UTC−6) it is already tomorrow in UTC, and the today line must not move a day ahead.
 */
describe('today on the person’s own clock (AGL-015)', () => {
  useTimeZone('America/Mexico_City');
  // 8 pm on Wednesday 4 November in Mexico City: 02:00 on Thursday 5 November in UTC.
  const evening = () => new Date('2026-11-05T02:00:00Z');

  it('[AGL-015] names the local day, not UTC’s, in the evening west of UTC', () => {
    expect(localDay(evening())).toBe('2026-11-04');
    expect(localDay(new Date('2026-11-04T06:00:00Z'))).toBe('2026-11-04');
    expect(localDay(new Date('2026-11-04T05:59:00Z'))).toBe('2026-11-03');
  });

  it('[AGL-015] draws the today line through the local day in the evening', () => {
    render(view(fakeTimelineClient().data(), evening));
    // LCH-2 starts on 2 November; at 28px a day the line runs through the middle of the 4th.
    const bar = screen.getByRole('button', { name: 'LCH-2: Nov 2, 2026 to Nov 10, 2026' });
    const line = document.querySelector('.timeline-today') as HTMLElement;
    expect(Number.parseFloat(line.style.left) - Number.parseFloat(bar.style.left)).toBe(
      2 * 28 + 14,
    );
  });
});

/**
 * The critical path on a timeline (PLN-011; ADR-122 stage 9), with the fixture plan's path:
 * SHOP-2 (two days late against SHOP-3) and SHOP-3 on it, OPS-4 with two days of slack.
 */
describe('the critical path on a timeline (PLN-011)', () => {
  const pathView = async (critical?: Parameters<typeof TimelineView>[0]['critical']) => {
    const { fakePlanClient } = await import('../plans/fixtures');
    const data = await fakePlanClient().timeline(12, {});
    return (
      <I18nProvider locale="en">
        <TimelineView
          data={data}
          reschedule={async () => ({ ok: true })}
          reload={() => {}}
          now={() => new Date('2026-11-04T09:00:00Z')}
          truncatedText="cut"
          {...(critical ? { critical } : {})}
        />
      </I18nProvider>
    );
  };

  it('[PLN-011] offers a Critical path toggle among the tools, pressed while it is on', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(await pathView({ on: false, onToggle, slack: null }));
    const toggle = screen.getByRole('button', { name: 'Critical path', pressed: false });
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(document.querySelector('.is-critical')).toBeNull();
    rerender(await pathView({ on: true, onToggle, slack: null }));
    expect(screen.getByRole('button', { name: 'Critical path', pressed: true })).toBeVisible();
    // Without the page's path, no toggle at all.
    rerender(await pathView());
    expect(screen.queryByRole('button', { name: 'Critical path' })).toBeNull();
  });

  it('[PLN-011] outlines and marks the bars on the path, says slack in each description and draws tight links heavier', async () => {
    const slack = new Map([
      [2, -2],
      [3, 0],
      [4, 2],
    ]);
    render(await pathView({ on: true, onToggle: () => {}, slack }));
    const last = screen.getByRole('button', {
      name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026',
      description: /On the critical path$/,
    });
    expect(last).toHaveClass('is-critical');
    // A shape as well as the outline: never colour alone.
    expect(last.querySelector('.timeline-critical-mark')).not.toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'SHOP-2: Nov 2, 2026 to Nov 10, 2026',
        description: /On the critical path$/,
      }),
    ).toHaveClass('is-critical');
    const side = screen.getByRole('button', {
      name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026',
      description: /2 days of slack$/,
    });
    expect(side).not.toHaveClass('is-critical');
    // SHOP-2 to SHOP-3 is tight; SHOP-2 to OPS-4 is not.
    expect(document.querySelectorAll('.timeline-link.is-critical')).toHaveLength(1);
    const legend = screen.getByRole('list', { name: 'What the bars mean' });
    expect(within(legend).getByText('On the critical path (heavy outline and ▲)')).toBeVisible();
  });

  it('[PLN-011] marks nothing while the toggle is off, whatever slack it was given', async () => {
    render(await pathView({ on: false, onToggle: () => {}, slack: new Map([[3, 0]]) }));
    expect(document.querySelector('.timeline-bar.is-critical')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026' }),
    ).not.toHaveAccessibleDescription(/critical/);
    expect(screen.queryByText('On the critical path (heavy outline and ▲)')).toBeNull();
  });
});
