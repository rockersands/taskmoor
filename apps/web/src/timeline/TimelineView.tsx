import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useDayText } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import {
  dayNumber,
  isoDay,
  localDay,
  type Rescheduled,
  type Timeline,
  type TimelineItem,
} from './client';
import { type Blocked, barOf, blockerCount, dependencyState } from './dependencies';
import { drawnReleases, releaseMarkerText } from './markers';
import { scheduleRefusal } from './refusal';
import { type TimelineRow as Row, type TimelineGroup, timelineRows } from './rows';
import { useTouchWording } from './touch';

export type { TimelineGroup } from './rows';

/** What a timeline draws: a track's, or a Multi-track plan's (ADR-064, ADR-122). */
export type TimelineData = Omit<Timeline, 'track'>;

export interface TimelineViewProps {
  data: TimelineData;
  /** New start and due days for a ticket (null clears one), through the ticket route. */
  reschedule: (
    ticketKey: string,
    dates: { startDate: string | null; dueDate: string | null },
  ) => Promise<Rescheduled>;
  /** Reads the timeline again, after a change. */
  reload: () => void;
  /** Today, for the today line and the range shown first. */
  now: () => Date;
  /** Groups rows under headings, parents above their children inside each; none keeps one tree. */
  groupOf?: (item: TimelineItem) => TimelineGroup;
  /** What the note under a cut-off timeline says. */
  truncatedText: string;
  /**
   * Each blocked ticket's blockers (`dependenciesOf`): with it, a badge beside each blocked bar
   * says how many there are, and turns red with a word when one is late (PLN-006).
   */
  dependencies?: ReadonlyMap<number, Blocked>;
  /** More controls beside the zoom. */
  tools?: ReactNode;
  /** The zoom, when the page keeps it (a plan's, in its address); else this view does. */
  zoom?: Zoom;
  onZoom?: (zoom: Zoom) => void;
  /**
   * A plan read in a scenario (ADR-122 stage 6): a change is a draft in it and is said so, drafted
   * bars carry a Draft tag in words and a dashed edge, and `undo` sets a ticket's drafted days
   * back to their live ones.
   */
  draft?: { scenario: string; undo: (item: TimelineItem) => Promise<Rescheduled> };
}

export type Zoom = 'weeks' | 'months' | 'quarters';
/** Pixels per day at each zoom. */
const SCALE: Record<Zoom, number> = { weeks: 28, months: 8, quarters: 3 };
const ZOOMS: { id: Zoom; label: MessageId }[] = [
  { id: 'weeks', label: 'timeline.zoom.weeks' },
  { id: 'months', label: 'timeline.zoom.months' },
  { id: 'quarters', label: 'timeline.zoom.quarters' },
];
/** Every row's height, so dependency lines know where rows are (44px: a touch target). */
const ROW = 44;
/** The space between today's line and a "No dates" chip, so the line never runs along its edge. */
const UNSCHEDULED_GAP = 4;
/** Beyond this many rows only those in view are drawn, with some to spare on either side. */
const WINDOW_AFTER = 200;
const OVERSCAN = 20;
/** Scrolling moves the drawn rows in steps of this many, not on every pixel. */
const STEP = 10;

/** A bar being dragged: what moves, from where, and the days it shows now. */
interface Drag {
  id: number;
  mode: 'move' | 'start' | 'end';
  x: number;
  start: number;
  due: number;
  shift: number;
  moved: boolean;
}

/**
 * What the lanes in view leave out: the tickets whose bars lie wholly before them or after them
 * (none before the first measure, and in a test without layout), and `below` while rows wait under
 * the card's edge. It changes only when a bar crosses an edge, never on every scrolled pixel, so
 * scrolling sideways draws the timeline again only then.
 */
interface Seen {
  before: ReadonlySet<number>;
  after: ReadonlySet<number>;
  below: boolean;
}

const NONE: ReadonlySet<number> = new Set();
/** Whether a set holds exactly these ids. */
const holdsExactly = (set: ReadonlySet<number>, ids: readonly number[]) =>
  set.size === ids.length && ids.every((i) => set.has(i));

/**
 * The drawing of a timeline (M1-048; AGL-015; PLN-012): tickets as bars over the calendar,
 * parents above their children (collapsible), zoomed by weeks, months or quarters, optionally
 * grouped under headings. A parent without dates of its own shows the span rolled up from its
 * children, and every parent says how many of them are closed. Tickets in a sprint without dates
 * show the sprint's. Lines join a blocking ticket to those it blocks, dashed and red when late
 * (`dependencyState`); with `dependencies`, a badge beside each blocked bar counts its blockers,
 * listed or not, and says "late" in words. Sprints are bands and releases lines, with today
 * marked. Past `WINDOW_AFTER` rows, only the rows in view are drawn (every row is 44px), so a
 * plan's 10,000 tickets scroll as smoothly as a track's few.
 *
 * Rescheduling: drag a bar to move it, or its ends to change its start or due day; Alt with
 * the left or right arrow moves a focused bar a day (with Shift, a week); choosing a bar opens a
 * side panel with both days, its dependencies and where its dates come from. Every change is
 * the ticket's own (`PATCH /tickets/:key`), so its permission and history apply; a refusal says
 * why in plain words.
 */
export function TimelineView({
  data,
  reschedule,
  reload,
  now,
  groupOf,
  truncatedText,
  dependencies,
  tools,
  zoom: zoomKept,
  onZoom,
  draft,
}: TimelineViewProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [zoomHere, setZoomHere] = useState<Zoom>('weeks');
  const zoom = zoomKept ?? zoomHere;
  const setZoom = onZoom ?? setZoomHere;
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  /** On a phone or a touch screen the hint speaks of fingers, not keys (D6). */
  const touch = useTouchWording();
  /** The lanes in view, in their own coordinates, and whether rows wait below the card's edge. */
  const [seen, setSeen] = useState<Seen>({ before: NONE, after: NONE, below: false });
  /** Set when a drag ends, so the click that follows does not open the panel. */
  const justDragged = useRef(false);

  const today = dayNumber(localDay(now()));
  const px = SCALE[zoom];

  const rows = useMemo(
    () => timelineRows(data.items, groupOf, collapsed, closedGroups),
    [data, collapsed, closedGroups, groupOf],
  );

  // The calendar shown: every bar and marker, today, and some room on both sides.
  const range = useMemo(() => {
    let first = today;
    let last = today;
    const see = (day: number) => {
      if (day < first) first = day;
      if (day > last) last = day;
    };
    for (const i of data.items) {
      const bar = barOf(i);
      if (bar) {
        see(bar.start);
        see(bar.due);
      }
    }
    for (const s of data.markers.sprints) {
      see(dayNumber(s.start));
      see(dayNumber(s.end));
    }
    for (const r of data.markers.releases) see(dayNumber(r.date));
    first -= 14;
    last += 28;
    // From a Monday (1970-01-01, day 0, was a Thursday).
    const from = first - ((first + 3) % 7);
    return { from, days: last - from + 1 };
  }, [data, today]);

  /** A day a quarter of the way into the lanes in view, so the days after it show, even on phones. */
  const scrollToDay = useCallback(
    (day: number) => {
      const el = scroller.current;
      if (!el) return;
      const label = el.querySelector<HTMLElement>('.timeline-corner')?.offsetWidth ?? 0;
      el.scrollLeft = Math.max(0, (day - range.from) * px - (el.clientWidth - label) / 4);
    },
    [range.from, px],
  );
  const scrollToToday = useCallback(() => scrollToDay(today), [scrollToDay, today]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when it is first drawn and at each zoom
  useEffect(() => {
    scrollToToday();
  }, [zoom]);

  const windowed = rows.length > WINDOW_AFTER;
  // Before the first paint with windowing on: the rows drawn come from where the list stands now,
  // not from where it stood the last time it was windowed.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !windowed) return;
    setStep(Math.floor(el.scrollTop / (ROW * STEP)));
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setStep(Math.floor(el.scrollTop / (ROW * STEP))));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, [windowed]);
  /** Each dated bar's days, to tell which lie outside the days in view. */
  const spans = useMemo(
    () =>
      data.items.flatMap((item) => {
        const bar = barOf(item);
        return bar ? [{ id: item.id, start: bar.start, due: bar.due }] : [];
      }),
    [data],
  );
  // What is in view, for the markers of bars outside it and the cue that rows wait below (PL-6, PL-7).
  // The scroll offset itself stays out of state: only the bars past each edge, and the cue, are kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the rows change too
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const label = el.querySelector<HTMLElement>('.timeline-corner')?.offsetWidth ?? 0;
      const left = Math.round(el.scrollLeft);
      const shown = Math.max(0, el.clientWidth - label);
      const before: number[] = [];
      const after: number[] = [];
      if (shown > 0) {
        for (const span of spans) {
          if ((span.due + 1 - range.from) * px <= left) before.push(span.id);
          else if ((span.start - range.from) * px >= left + shown) after.push(span.id);
        }
      }
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setSeen((was) =>
        holdsExactly(was.before, before) && holdsExactly(was.after, after) && was.below === below
          ? was
          : { before: new Set(before), after: new Set(after), below },
      );
    };
    measure();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    // The card narrows without the window: a side panel opens beside it, or the page's column moves.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    resized?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
      resized?.disconnect();
    };
  }, [spans, range.from, px, rows.length]);
  const viewHeight = Math.max(scroller.current?.clientHeight ?? 0, ROW * 20);
  const top = Math.max(0, step * STEP * ROW - (head.current?.offsetHeight ?? 0));
  const firstRow = windowed ? Math.max(0, Math.floor(top / ROW) - OVERSCAN) : 0;
  const lastRow = windowed
    ? Math.min(rows.length, Math.ceil((top + viewHeight) / ROW) + STEP + OVERSCAN)
    : rows.length;
  const rowKey = (row: Row) => (row.kind === 'group' ? `g:${row.id}` : `i:${row.item.id}`);
  // The row holding focus, and the chosen one, stay drawn while scrolled out of view, so keyboard
  // focus never drops to the page.
  const pinned = windowed
    ? rows.flatMap((row, index) =>
        (index < firstRow || index >= lastRow) &&
        (rowKey(row) === focusKey || (row.kind === 'item' && row.item.id === selected))
          ? [{ row, index }]
          : [],
      )
    : [];

  const dayText = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const x = (day: number) => (day - range.from) * px;
  /** Whether a ticket's days are drafted: a draft of its Team value alone leaves them live. */
  const daysDrafted = (item: TimelineItem) => Boolean(item.draft?.startDate || item.draft?.dueDate);
  /** A drafted ticket's days now, live, in words: a day not drafted is the same in both. */
  const nowWords = (item: TimelineItem) => {
    const word = (day: string | null) => (day ? dayText(dayNumber(day)) : t('timeline.noDate'));
    return {
      nowStart: word(item.draft?.startDate ? item.draft.startDate.now : item.start),
      nowDue: word(item.draft?.dueDate ? item.draft.dueDate.now : item.due),
    };
  };
  const width = range.days * px;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const rowOf = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === 'item') rowOf.set(r.item.id, i);
  });

  /** Saves new days for a ticket; the timeline is read again either way. */
  const save = async (item: TimelineItem, start: string | null, due: string | null) => {
    setProblem(null);
    const outcome = await reschedule(item.key, { startDate: start, dueDate: due });
    if (outcome.ok) {
      const words = {
        key: item.key,
        start: start ? dayText(dayNumber(start)) : t('timeline.noDate'),
        due: due ? dayText(dayNumber(due)) : t('timeline.noDate'),
      };
      setNotice(
        draft
          ? t('timeline.drafted', { ...words, scenario: draft.scenario })
          : t('timeline.rescheduled', words),
      );
    } else {
      setProblem(scheduleRefusal(t, item.key, outcome));
    }
    reload();
  };

  /** Sets a ticket's drafted days back to their live ones; the timeline is read again. */
  const undo = async (item: TimelineItem) => {
    if (!draft) return;
    setProblem(null);
    const outcome = await draft.undo(item);
    if (outcome.ok) setNotice(t('timeline.undone', { key: item.key, scenario: draft.scenario }));
    else setProblem(scheduleRefusal(t, item.key, outcome));
    reload();
  };

  /** Shifts a bar's days: the days it has (both for a sprint's), by `days`. */
  const shifted = (item: TimelineItem, startDay: number, dueDay: number) => {
    if (item.dated === 'own') {
      return {
        start: item.start === null ? null : isoDay(startDay),
        due: item.due === null ? null : isoDay(dueDay),
      };
    }
    return { start: isoDay(startDay), due: isoDay(dueDay) };
  };

  const onBarDown = (event: PointerEvent<HTMLButtonElement>, item: TimelineItem) => {
    const bar = barOf(item);
    if (bar?.kind !== 'own' || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    const edge = Math.min(10, rect.width / 3);
    // A press past a narrow bar's ends, in the room a finger is given (TR-21), moves it whole.
    const mode =
      offset < 0 || offset > rect.width
        ? 'move'
        : offset < edge
          ? 'start'
          : offset > rect.width - edge
            ? 'end'
            : 'move';
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      id: item.id,
      mode,
      x: event.clientX,
      start: bar.start,
      due: bar.due,
      shift: 0,
      moved: false,
    });
  };
  const onBarMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const shift = Math.round((event.clientX - drag.x) / px);
    if (shift !== drag.shift) setDrag({ ...drag, shift, moved: drag.moved || shift !== 0 });
  };
  const dragged = (d: Drag) => {
    if (d.mode === 'move') return { start: d.start + d.shift, due: d.due + d.shift };
    if (d.mode === 'start') return { start: Math.min(d.start + d.shift, d.due), due: d.due };
    return { start: d.start, due: Math.max(d.due + d.shift, d.start) };
  };
  const onBarUp = (item: TimelineItem) => {
    const d = drag;
    setDrag(null);
    if (!d?.moved || d.shift === 0) return;
    justDragged.current = true;
    const days = dragged(d);
    const next =
      d.mode === 'move'
        ? shifted(item, days.start, days.due)
        : d.mode === 'start'
          ? { start: isoDay(days.start), due: item.due ?? isoDay(days.due) }
          : { start: item.start ?? isoDay(days.start), due: isoDay(days.due) };
    void save(item, next.start, next.due);
  };
  const onBarKey = (event: KeyboardEvent, item: TimelineItem) => {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    const bar = barOf(item);
    if (bar?.kind !== 'own') return;
    event.preventDefault();
    const days = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1);
    const next = shifted(item, bar.start + days, bar.due + days);
    void save(item, next.start, next.due);
  };

  const ticks: { day: number; label: string; major: boolean }[] = [];
  for (let day = range.from; day < range.from + range.days; day++) {
    const date = new Date(day * 86_400_000);
    const first = date.getUTCDate() === 1;
    if (zoom === 'weeks' && (day - range.from) % 7 === 0) {
      ticks.push({ day, label: String(date.getUTCDate()), major: false });
    } else if (zoom !== 'weeks' && (first || day === range.from)) {
      // Each month or quarter, and the one the range starts in.
      const quarterStart = date.getUTCMonth() % 3 === 0 || day === range.from;
      if (zoom === 'months') {
        ticks.push({
          day,
          label: intl.formatDate(date, { month: 'short', timeZone: 'UTC' }),
          major: date.getUTCMonth() === 0,
        });
      } else if (quarterStart) {
        ticks.push({
          day,
          label: t('timeline.quarter', {
            quarter: Math.floor(date.getUTCMonth() / 3) + 1,
            year: date.getUTCFullYear(),
          }),
          major: date.getUTCMonth() === 0,
        });
      }
    }
  }
  const months: { day: number; label: string }[] = [];
  for (let day = range.from; day < range.from + range.days; day++) {
    const date = new Date(day * 86_400_000);
    if (day === range.from || date.getUTCDate() === 1) {
      if (zoom === 'weeks' || date.getUTCMonth() === 0 || day === range.from) {
        months.push({
          day,
          label: intl.formatDate(
            date,
            zoom === 'weeks'
              ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
              : { year: 'numeric', timeZone: 'UTC' },
          ),
        });
      }
    }
  }

  const chosen = selected === null ? null : (byId.get(selected) ?? null);
  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  /** Where a pinned row is drawn: at its own place, outside the slice of rows in view. */
  const placed = (index: number | undefined): CSSProperties | undefined =>
    index === undefined ? undefined : { position: 'absolute', top: index * ROW, left: 0 };

  const itemRow = (row: Extract<Row, { kind: 'item' }>, at?: number) => {
    const { item } = row;
    const live = drag?.id === item.id ? dragged(drag) : null;
    const bar = barOf(item);
    const days = live ?? bar;
    const progress = item.rollup;
    const blocked = dependencies?.get(item.id);
    const badgeId = blocked ? `${id}-dep-${item.id}` : undefined;
    const badgeText = blocked
      ? blocked.sameSprint > 0
        ? t('timeline.badge.withSprint', {
            count: blockerCount(blocked),
            late: blocked.late,
            sprint: blocked.sameSprint,
          })
        : t('timeline.badge', { count: blockerCount(blocked), late: blocked.late })
      : '';
    // A bar wholly outside the days in view gets a marker at that edge, so no row looks empty.
    const edge =
      !days || live
        ? null
        : seen.before.has(item.id)
          ? 'before'
          : seen.after.has(item.id)
            ? 'after'
            : null;
    return (
      <li
        key={`i:${item.id}`}
        data-row={`i:${item.id}`}
        className={`timeline-row${selected === item.id ? ' is-selected' : ''}`}
        data-stage={item.status.stage}
        style={placed(at)}
      >
        <div
          className="timeline-label"
          style={{
            paddingInlineStart: `calc(var(--space-2) + ${row.depth} * var(--timeline-indent))`,
          }}
        >
          {row.hasChildren ? (
            <button
              type="button"
              className="timeline-toggle"
              aria-expanded={!collapsed.has(item.id)}
              aria-label={t(collapsed.has(item.id) ? 'timeline.expand' : 'timeline.collapse', {
                key: item.key,
              })}
              onClick={() => setCollapsed((c) => toggle(c, item.id))}
            >
              {collapsed.has(item.id) ? '▸' : '▾'}
            </button>
          ) : (
            <span className="timeline-toggle-space" />
          )}
          {/* The key is never cut; the summary takes what is left, beside it or under it on a phone. */}
          <span className="timeline-name">
            <a
              href={routeHref(`#/tickets/${encodeURIComponent(item.key)}`)}
              className="timeline-key"
            >
              {item.key}
            </a>
            <span className="timeline-summary">{item.summary}</span>
          </span>
          {item.draft && <span className="draft-tag">{t('draft.tag')}</span>}
          {progress && (
            <span className="timeline-progress-text">
              {t('timeline.progress', { closed: progress.closed, count: progress.total })}
            </span>
          )}
        </div>
        <div className="timeline-lane" style={{ width }}>
          {days && bar?.kind === 'own' ? (
            <button
              type="button"
              className={`timeline-bar${item.dated === 'sprint' ? ' is-sprint' : ''}${live ? ' is-dragging' : ''}${item.draft ? ' is-draft' : ''}`}
              style={{ left: x(days.start), width: (days.due - days.start + 1) * px }}
              aria-describedby={badgeId ? `${id}-hint ${badgeId}` : `${id}-hint`}
              aria-label={
                item.draft && daysDrafted(item)
                  ? t(item.draft.stale ? 'timeline.bar.draftStale' : 'timeline.bar.draft', {
                      key: item.key,
                      start: dayText(days.start),
                      due: dayText(days.due),
                      ...nowWords(item),
                    })
                  : t('timeline.bar', {
                      key: item.key,
                      start: dayText(days.start),
                      due: dayText(days.due),
                    })
              }
              onPointerDown={(event) => onBarDown(event, item)}
              onPointerMove={onBarMove}
              onPointerUp={() => onBarUp(item)}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(event) => onBarKey(event, item)}
              onClick={() => {
                // A drag ends in a click: only a press without a move opens the panel.
                if (justDragged.current) {
                  justDragged.current = false;
                  return;
                }
                setSelected(item.id);
              }}
            >
              {progress && progress.total > 0 && (
                <span
                  className="timeline-bar-fill"
                  style={{ width: `${(progress.closed / progress.total) * 100}%` }}
                />
              )}
            </button>
          ) : days ? (
            <span
              role="img"
              className="timeline-bar is-rollup"
              style={{ left: x(days.start), width: (days.due - days.start + 1) * px }}
              aria-describedby={badgeId}
              aria-label={t('timeline.rollup', {
                key: item.key,
                start: dayText(days.start),
                due: dayText(days.due),
              })}
            >
              {progress && progress.total > 0 && (
                <span
                  className="timeline-bar-fill"
                  style={{ width: `${(progress.closed / progress.total) * 100}%` }}
                />
              )}
            </span>
          ) : (
            <button
              type="button"
              className="timeline-unscheduled"
              // Past today's line (2 px through the middle of today's column), with a gap.
              style={{ left: x(today) + px / 2 + 2 + UNSCHEDULED_GAP }}
              onClick={() => setSelected(item.id)}
              aria-label={
                item.draft && daysDrafted(item)
                  ? t('timeline.schedule.draft', { key: item.key, ...nowWords(item) })
                  : t('timeline.schedule', { key: item.key })
              }
              aria-describedby={badgeId}
            >
              {t('timeline.noDates')}
            </button>
          )}
          {edge && days && (
            // Held at that edge of the lanes in view by sticky CSS, not by the scroll offset.
            <button
              type="button"
              className={`timeline-edge is-${edge}`}
              aria-label={t(
                edge === 'before' ? 'timeline.edge.beforeLabel' : 'timeline.edge.afterLabel',
                {
                  key: item.key,
                  date: dayText(edge === 'before' ? days.due : days.start),
                },
              )}
              onClick={(event) => {
                const row = event.currentTarget.closest('li');
                scrollToDay(days.start);
                // The marker goes once its bar is in view: the bar takes the focus, or the key
                // where the bar is rolled up and cannot, so the keyboard never drops to the page.
                const next =
                  row?.querySelector<HTMLElement>('button.timeline-bar') ??
                  row?.querySelector<HTMLElement>('.timeline-key');
                next?.focus({ preventScroll: true });
              }}
            >
              {t(edge === 'before' ? 'timeline.edge.before' : 'timeline.edge.after')}
            </button>
          )}
          {blocked && (
            <span
              id={badgeId}
              className={`timeline-badge${blocked.late > 0 ? ' is-late' : ''}${days ? '' : ' is-before'}`}
              style={{ left: days ? x(days.due + 1) + 12 : x(today) }}
              title={badgeText}
            >
              <span aria-hidden="true">
                {blocked.late > 0
                  ? t('timeline.badge.late', { count: blockerCount(blocked) })
                  : blockerCount(blocked)}
                {blocked.sameSprint > 0 && ` · ${t('timeline.badge.sprint')}`}
              </span>
              <span className="visually-hidden">{badgeText}</span>
            </span>
          )}
        </div>
      </li>
    );
  };

  const groupRow = (row: Extract<Row, { kind: 'group' }>, at?: number) => {
    const open = !closedGroups.has(row.id);
    return (
      <li
        key={`g:${row.id}`}
        data-row={`g:${row.id}`}
        className="timeline-row timeline-group"
        style={placed(at)}
      >
        <div className="timeline-label">
          <button
            type="button"
            className="timeline-toggle"
            aria-expanded={open}
            aria-label={t(open ? 'timeline.group.collapse' : 'timeline.group.expand', {
              name: row.label,
            })}
            onClick={() => setClosedGroups((c) => toggle(c, row.id))}
          >
            {open ? '▾' : '▸'}
          </button>
          <span className="timeline-group-name">
            {t('timeline.group.title', { name: row.label, count: row.count })}
          </span>
        </div>
        <div className="timeline-lane" style={{ width }} />
      </li>
    );
  };

  return (
    <>
      <div className="timeline-tools">
        <fieldset className="timeline-zoom">
          <legend className="visually-hidden">{t('timeline.zoom')}</legend>
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              className="filter-chip"
              aria-pressed={zoom === z.id}
              onClick={() => setZoom(z.id)}
            >
              {t(z.label)}
            </button>
          ))}
        </fieldset>
        <button type="button" className="button-secondary" onClick={scrollToToday}>
          {t('timeline.today')}
        </button>
        {tools}
      </div>
      <p className="board-hint" id={`${id}-hint`}>
        {t(touch ? 'timeline.hintTouch' : 'timeline.hint')}
      </p>
      <p className="board-hint" role="status">
        {notice}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {/* The panel takes a column only while it is open, so the card reaches the page's edge (TR-10). */}
      <div className={chosen ? 'timeline-body has-panel' : 'timeline-body'}>
        <section
          className={`glass-card glass-scroller timeline-scroll${seen.below ? ' has-more-below' : ''}`}
          ref={scroller}
          aria-label={t('timeline.chart')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
          tabIndex={0}
        >
          <div className="timeline-head" aria-hidden="true" ref={head}>
            <div className="timeline-corner">{t('timeline.ticket')}</div>
            <div className="timeline-scale" style={{ width }}>
              {/* Each month spans its days; its name stays in view while any of them is (TR-9). */}
              {months.map((m, i) => (
                <span
                  key={`m${m.day}`}
                  className="timeline-month"
                  style={{
                    left: x(m.day),
                    width: x(months[i + 1]?.day ?? range.from + range.days) - x(m.day),
                  }}
                >
                  <span className="timeline-month-name">{m.label}</span>
                </span>
              ))}
              {ticks.map((tick) => (
                <span
                  key={`t${tick.day}`}
                  className={`timeline-tick${tick.major ? ' is-major' : ''}`}
                  style={{ left: x(tick.day) }}
                >
                  {tick.label}
                </span>
              ))}
              {data.markers.sprints.map((s) => (
                <span
                  key={`s${s.id}`}
                  className="timeline-sprint-label"
                  style={{
                    left: x(dayNumber(s.start)),
                    width: (dayNumber(s.end) - dayNumber(s.start) + 1) * px,
                  }}
                  title={s.name}
                >
                  {s.name}
                </span>
              ))}
              {drawnReleases(data.markers.releases).map((r) => {
                const text = releaseMarkerText(t, r);
                return (
                  <span
                    key={r.key}
                    className="timeline-release-label"
                    style={{ left: x(dayNumber(r.date)) }}
                    title={text}
                  >
                    ◆ {text}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="timeline-grid" style={{ height: rows.length * ROW }}>
            <div
              className="timeline-lanes"
              style={{ width, height: rows.length * ROW }}
              aria-hidden="true"
            >
              {ticks.map((tick) => (
                <span
                  key={`g${tick.day}`}
                  className={`timeline-gridline${tick.major ? ' is-major' : ''}`}
                  style={{ left: x(tick.day) }}
                />
              ))}
              {data.markers.sprints.map((s) => (
                <span
                  key={`sb${s.id}`}
                  className="timeline-sprint-band"
                  style={{
                    left: x(dayNumber(s.start)),
                    width: (dayNumber(s.end) - dayNumber(s.start) + 1) * px,
                  }}
                />
              ))}
              {drawnReleases(data.markers.releases).map((r) => (
                <span
                  key={`l${r.key}`}
                  className="timeline-release-line"
                  style={{ left: x(dayNumber(r.date) + 1) }}
                />
              ))}
              <span className="timeline-today" style={{ left: x(today) + px / 2 }} />
              <svg className="timeline-links" width={width} height={rows.length * ROW}>
                <title>{t('timeline.dependencies')}</title>
                {data.links.map((l) => {
                  const from = byId.get(l.from);
                  const to = byId.get(l.to);
                  if (!from || !to) return null;
                  const a = barOf(from);
                  const b = barOf(to);
                  const ra = rowOf.get(l.from);
                  const rb = rowOf.get(l.to);
                  if (!a || !b || ra === undefined || rb === undefined) return null;
                  // Off screen at both ends: not drawn while the rows around it are not.
                  if (windowed && Math.max(ra, rb) < firstRow) return null;
                  if (windowed && Math.min(ra, rb) > lastRow) return null;
                  const x1 = x(a.due + 1);
                  const y1 = ra * ROW + ROW / 2;
                  const x2 = x(b.start);
                  const y2 = rb * ROW + ROW / 2;
                  const late = dependencyState(from, to) === 'late';
                  return (
                    <path
                      key={`${l.from}-${l.to}`}
                      className={`timeline-link${late ? ' is-late' : ''}${l.sameSprint ? ' is-same-sprint' : ''}`}
                      d={`M ${x1} ${y1} H ${x1 + 8} V ${y2} H ${Math.max(x2, x1 + 8)}`}
                    />
                  );
                })}
              </svg>
            </div>
            <ul
              className="timeline-rows"
              style={windowed ? { paddingTop: firstRow * ROW } : undefined}
              onFocus={(event) => {
                const li = (event.target as HTMLElement).closest('li[data-row]');
                setFocusKey(li?.getAttribute('data-row') ?? null);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setFocusKey(null);
                }
              }}
            >
              {/* One list in row order, so React never remounts or moves a drawn row: focus stays. */}
              {[
                ...pinned.filter((p) => p.index < firstRow),
                ...rows.slice(firstRow, lastRow).map((row) => ({ row, index: undefined })),
                ...pinned.filter((p) => p.index >= lastRow),
              ].map(({ row, index }) =>
                row.kind === 'group' ? groupRow(row, index) : itemRow(row, index),
              )}
            </ul>
          </div>
          {/* Over the rows in view, not on the card: a mask there would fade its scrollbar too. */}
          {seen.below && <div className="timeline-fade" aria-hidden="true" />}
        </section>
        {chosen && (
          <SchedulePanel
            // Kept while its ticket is chosen, so focus stays in it; its fields follow the days.
            key={chosen.id}
            item={chosen}
            blocks={data.links
              .filter((l) => l.from === chosen.id)
              .map((l) => byId.get(l.to)?.key ?? '')}
            blockedBy={data.links
              .filter((l) => l.to === chosen.id)
              .map((l) => byId.get(l.from)?.key ?? '')}
            blocked={dependencies?.get(chosen.id)}
            onSave={(start, due) => void save(chosen, start, due)}
            onClose={() => setSelected(null)}
            {...(draft
              ? {
                  draft: {
                    scenario: draft.scenario,
                    now: daysDrafted(chosen) ? nowWords(chosen) : null,
                    undo: () => void undo(chosen),
                  },
                }
              : {})}
          />
        )}
      </div>
      <TimelineLegend data={data} />
      {data.truncated && <p className="board-hint">{truncatedText}</p>}
    </>
  );
}

/**
 * What the bar styles mean (D29), only those the timeline draws: a ticket's own days, days from
 * its sprint (hatched), a span rolled up from its children (outlined, the closed share filled),
 * a ticket with no dates, today, releases and late dependencies. Worked out again only when the
 * timeline's data changes, not each time the timeline is drawn.
 */
const TimelineLegend = memo(function TimelineLegend({ data }: { data: TimelineData }) {
  const t = useT();
  const entries = useMemo(() => legendEntries(data), [data]);
  return (
    <ul className="timeline-legend" aria-label={t('timeline.legend')}>
      {entries.map((e) => (
        <li key={e.key}>
          <span className={`timeline-legend-mark is-${e.key}`} aria-hidden="true" />
          {t(e.label)}
        </li>
      ))}
    </ul>
  );
});

/** The legend's entries: the bar styles a timeline's data draws. */
function legendEntries(data: TimelineData): { key: string; label: MessageId }[] {
  const bars = data.items.map((i) => ({ item: i, bar: barOf(i) }));
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const late = data.links.some((l) => {
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    return from && to && dependencyState(from, to) === 'late';
  });
  const shown: [boolean, string, MessageId][] = [
    [
      bars.some((b) => b.bar?.kind === 'own' && b.item.dated !== 'sprint'),
      'own',
      'timeline.legend.own',
    ],
    [bars.some((b) => b.bar && b.item.dated === 'sprint'), 'sprint', 'timeline.legend.sprint'],
    [bars.some((b) => b.bar?.kind === 'rollup'), 'rollup', 'timeline.legend.rollup'],
    [
      bars.some((b) => b.bar && (b.item.rollup?.total ?? 0) > 0),
      'closed',
      'timeline.legend.closed',
    ],
    [bars.some((b) => !b.bar), 'none', 'timeline.legend.none'],
    [true, 'today', 'timeline.legend.today'],
    [data.markers.releases.length > 0, 'release', 'timeline.legend.release'],
    [data.links.length > 0, 'link', 'timeline.legend.link'],
    [late, 'late', 'timeline.legend.late'],
    [data.items.some((i) => i.draft), 'draft', 'timeline.legend.draft'],
  ];
  return shown.flatMap(([on, key, label]) => (on ? [{ key, label }] : []));
}

/** A ticket's days in a side panel: the keyboard's and the phone's way to reschedule. */
function SchedulePanel({
  item,
  blocks,
  blockedBy,
  blocked,
  onSave,
  onClose,
  draft,
}: {
  item: TimelineItem;
  blocks: string[];
  blockedBy: string[];
  /** Its blockers with their state and those not listed, when the page gives dependencies. */
  blocked?: Blocked | undefined;
  onSave: (start: string | null, due: string | null) => void;
  onClose: () => void;
  /** In a scenario: its days now, live, when they are drafted, and how to undo its draft. */
  draft?: {
    scenario: string;
    now: { nowStart: string; nowDue: string } | null;
    undo: () => void;
  };
}) {
  const t = useT();
  const day = useDayText();
  const id = useId();
  const [start, setStart] = useState(item.start ?? '');
  const [due, setDue] = useState(item.due ?? '');
  // Read again after a save or an undo: the fields take the days as they are now.
  useEffect(() => {
    setStart(item.start ?? '');
    setDue(item.due ?? '');
  }, [item.start, item.due]);
  const save = useRef<HTMLButtonElement>(null);
  // Undo takes its own button away with the draft: focus goes to Save, beside it.
  const undone = useRef(false);
  const drafted = Boolean(item.draft);
  useEffect(() => {
    if (drafted || !undone.current) return;
    undone.current = false;
    save.current?.focus();
  }, [drafted]);
  const bad = start !== '' && due !== '' && start > due;
  return (
    <aside className="glass-card timeline-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('timeline.panel.title', { key: item.key })}</h2>
      <p className="timeline-panel-summary">{item.summary}</p>
      {draft && !item.draft && (
        <p className="board-hint">{t('timeline.panel.draftHint', { scenario: draft.scenario })}</p>
      )}
      {draft && item.draft && (
        <div className="timeline-panel-draft">
          <p>
            <span className="draft-tag">{t('draft.tag')}</span>{' '}
            {draft.now
              ? t('timeline.panel.nowLive', { start: draft.now.nowStart, due: draft.now.nowDue })
              : t('timeline.panel.draftOther')}
          </p>
          {item.draft.stale && <p className="board-hint">{t('draft.stale')}</p>}
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              undone.current = true;
              draft.undo();
            }}
          >
            {t('timeline.panel.undoDraft')}
          </button>
        </div>
      )}
      {item.dated === 'sprint' && <p className="board-hint">{t('timeline.panel.sprint')}</p>}
      {item.rollup && (
        <p className="board-hint">
          {item.rollup.start || item.rollup.due
            ? t('timeline.panel.rollup', {
                start: item.rollup.start ? day(item.rollup.start) : t('timeline.noDate'),
                due: item.rollup.due ? day(item.rollup.due) : t('timeline.noDate'),
              })
            : t('timeline.panel.noRollup')}
        </p>
      )}
      <form
        className="timeline-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!bad) onSave(start || null, due || null);
        }}
      >
        <label className="form-field">
          <span className="form-label">{t('timeline.panel.start')}</span>
          <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">{t('timeline.panel.due')}</span>
          <input
            type="date"
            value={due}
            aria-invalid={bad || undefined}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
        {bad && <p className="form-error">{t('timeline.panel.order')}</p>}
        <div className="form-actions">
          <button ref={save} type="submit" className="button-primary" disabled={bad}>
            {t(draft ? 'timeline.panel.saveDraft' : 'timeline.panel.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('timeline.panel.close')}
          </button>
        </div>
      </form>
      {blocks.length > 0 && (
        <p className="board-hint">{t('timeline.panel.blocks', { keys: blocks.join(', ') })}</p>
      )}
      {blockedBy.length > 0 && (
        <p className="board-hint">
          {t('timeline.panel.blockedBy', { keys: blockedBy.join(', ') })}
        </p>
      )}
      {blocked && blocked.late > 0 && (
        <p className="board-hint timeline-panel-late">
          {t('timeline.panel.late', {
            keys: blocked.blockers
              .filter((b) => b.state === 'late')
              .map((b) => b.item.key)
              .join(', '),
          })}
        </p>
      )}
      {blocked && blocked.outside > 0 && (
        <p className="board-hint">{t('dependencies.outside', { count: blocked.outside })}</p>
      )}
      {blocked && blocked.unlisted > 0 && (
        <p className="board-hint">{t('dependencies.unlisted', { count: blocked.unlisted })}</p>
      )}
    </aside>
  );
}
