import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { MoveMenu, type MoveMenuItem } from '../shell/MoveMenu';
import { followPointerDrag } from '../shell/pointerDrag';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { dayNumber, isoDay } from '../timeline/client';
import { drawnReleases, releaseMarkerText } from '../timeline/markers';
import { scheduleRefusal } from '../timeline/refusal';
import { useTouchWording } from '../timeline/touch';
import type { CalendarData, CalendarTicket, Moved } from './client';

/** What a calendar draws: a track's, or a Multi-track plan's (ADR-065, ADR-122). */
export type CalendarEntries = Pick<CalendarData, 'tickets' | 'sprints' | 'releases' | 'truncated'>;

/** A ticket on a day: on its due day, or on its start day when that differs. */
interface Entry {
  ticket: CalendarTicket;
  kind: 'due' | 'start';
}

/** How many tickets a day shows before a button for the rest. */
const PER_DAY = 6;

/** Alt with an arrow moves an entry by these days: a day sideways, a week up or down. */
const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

/** The moves an entry's grip offers, as its keys make them (T-162b). */
const GRIP_STEPS = [
  { days: -1, label: 'calendar.grip.dayEarlier' },
  { days: 1, label: 'calendar.grip.dayLater' },
  { days: -7, label: 'calendar.grip.weekEarlier' },
  { days: 7, label: 'calendar.grip.weekLater' },
] as const;

/** An entry's name in the page, the same on whichever day it is drawn. */
const entryId = (entry: Entry) => `${entry.ticket.id}-${entry.kind}`;
/** The day an entry is on. */
const dayOf = (entry: Entry) =>
  dayNumber((entry.kind === 'due' ? entry.ticket.due : entry.ticket.start) as string);
/** The label that follows the pointer, placed by its coordinates (`drag-ghost`, drag.css). */
const ghostAt = (at: { x: number; y: number }) => `translate(${at.x + 12}px, ${at.y + 12}px)`;

/** The first day of the month that `day` is in. */
export const monthOf = (day: number) => {
  const d = new Date(day * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86_400_000;
};
export const addMonths = (month: number, n: number) => {
  const d = new Date(month * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 86_400_000;
};
/** Whole weeks from the Monday on or before the 1st to the Sunday on or after the last day. */
export function monthWeeks(month: number): { first: number; last: number } {
  const first = month - ((month + 3) % 7);
  const end = addMonths(month, 1) - 1;
  return { first, last: end + ((7 - ((end + 4) % 7)) % 7) };
}

export interface CalendarViewProps {
  data: CalendarEntries;
  /** The month shown, as the day number of its first day. */
  month: number;
  onMonth: (month: number) => void;
  /** More controls beside the month's. */
  tools?: ReactNode;
  /** New days for a ticket through the ticket route; only the days given change. */
  move: (
    ticketKey: string,
    days: { startDate?: string | null; dueDate?: string | null },
  ) => Promise<Moved>;
  /** Reads the calendar again, after a change. */
  reload: () => void;
  now: () => Date;
  /** What the note under a cut-off calendar says. */
  truncatedText: string;
}

/**
 * The drawing of a calendar (M1-049; AGL-017; PLN-012): a month of weeks from Monday, each
 * ticket on its due day (and on its start day when that differs, marked as a start), the
 * sprints and releases on their days, today marked. A day lists six tickets and a button for the
 * rest. Drag a ticket to another day to move it (its start moves along, keeping its length;
 * AGL-017 (1)); with the keyboard, Alt and the arrows move it by a day or a week; choosing it
 * opens the ticket over the page. Every move is the ticket's own change, so its permission and
 * history apply; a refusal says why in plain words.
 *
 * Drags use pointer events (T-162b; ADR-114, section 12): a mouse drags an entry from anywhere
 * on it, and a finger or a mouse by its grip, whose press opens a menu of the same moves as the
 * keys; elsewhere a finger scrolls. The day it would land on is outlined, a label follows the
 * pointer, the page says what is in hand, Escape cancels, and near an edge the page scrolls.
 *
 * On a phone (D9) the month is a list of only the days that have something on them, each named
 * by its weekday and date, and the hint speaks of fingers rather than keys (D6).
 */
export function CalendarView({
  data,
  month,
  onMonth,
  tools,
  move: moveTicket,
  reload,
  now,
  truncatedText,
}: CalendarViewProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const today = dayNumber(now().toISOString().slice(0, 10));
  const compact = useMediaQuery(COMPACT_QUERY);
  const touch = useTouchWording();
  const [dragging, setDragging] = useState<Entry | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [inHandNotice, setInHandNotice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const { first, last } = monthWeeks(month);
  /** Stops following the press under way, if any. */
  const stopDrag = useRef<(() => void) | null>(null);
  /** The label in hand and where the pointer is: moved by hand, so a drag draws no day again. */
  const ghost = useRef<HTMLDivElement>(null);
  const pointerAt = useRef({ x: 0, y: 0 });
  /** An entry moved by its keys or its grip's menu, and which of the two had the keyboard. */
  const refocus = useRef<{ entry: string; part: 'chip' | 'grip' } | null>(null);
  const grid = useRef<HTMLUListElement>(null);

  // A page that goes mid-drag stops following the pointer.
  useEffect(() => () => stopDrag.current?.(), []);
  // An entry moved by the keyboard is drawn on its new day: the keyboard goes there with it.
  useEffect(() => {
    const want = refocus.current;
    if (!want || !data) return;
    refocus.current = null;
    const holder = grid.current?.querySelector(`[data-entry="${want.entry}"]`);
    holder
      ?.querySelector<HTMLElement>(want.part === 'grip' ? '[data-handle]' : '.calendar-chip')
      ?.focus();
  }, [data]);

  const dateText = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const entries = new Map<number, Entry[]>();
  const put = (day: number, entry: Entry) => {
    const list = entries.get(day);
    if (list) list.push(entry);
    else entries.set(day, [entry]);
  };
  for (const ticket of data.tickets) {
    if (ticket.due) put(dayNumber(ticket.due), { ticket, kind: 'due' });
    if (ticket.start && ticket.start !== ticket.due)
      put(dayNumber(ticket.start), { ticket, kind: 'start' });
  }

  /**
   * Moves an entry's day by `delta` days: a due day takes its start along, keeping the length.
   * A move by the keyboard says which part of the entry gets the keyboard back on its new day.
   */
  const move = async (entry: Entry, delta: number, focus?: 'chip' | 'grip') => {
    if (delta === 0) return;
    if (focus) refocus.current = { entry: entryId(entry), part: focus };
    const { ticket } = entry;
    const shift = (d: string | null) => (d === null ? null : isoDay(dayNumber(d) + delta));
    let days: { startDate?: string | null; dueDate?: string | null };
    if (entry.kind === 'due') {
      days = ticket.start
        ? { startDate: shift(ticket.start), dueDate: shift(ticket.due) }
        : { dueDate: shift(ticket.due) };
    } else {
      const start = shift(ticket.start) as string;
      days =
        ticket.due && start > ticket.due
          ? { startDate: start, dueDate: shift(ticket.due) }
          : { startDate: start };
    }
    setProblem(null);
    const outcome = await moveTicket(ticket.key, days);
    if (outcome.ok) {
      const day = days[entry.kind === 'due' ? 'dueDate' : 'startDate'] as string;
      setNotice(
        t(entry.kind === 'due' ? 'calendar.movedDue' : 'calendar.movedStart', {
          key: ticket.key,
          date: dateText(dayNumber(day)),
        }),
      );
    } else {
      setProblem(scheduleRefusal(t, ticket.key, outcome));
    }
    reload();
  };

  // A drag outlives the drawing it began in: it moves through the latest one.
  const live = useRef(move);
  live.current = move;

  /** The day under the pointer, as a place a dragged entry may land. */
  const dayAt = (x: number, y: number): number | null => {
    const holder = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-drop-day]');
    return holder ? Number(holder.dataset.dropDay) : null;
  };

  /**
   * A press on an entry that may become a drag (T-162b): by mouse on the entry itself, by
   * anything on its grip. Let go on another day, it moves there as the keys would move it.
   */
  function beginDrag(event: ReactPointerEvent, entry: Entry) {
    if (stopDrag.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const words = { key: entry.ticket.key };
    const endDrag = () => {
      setDragging(null);
      setOver(null);
      setInHandNotice('');
    };
    stopDrag.current = followPointerDrag(event, {
      start: (x, y) => {
        pointerAt.current = { x, y };
        setDragging(entry);
        setInHandNotice(t('calendar.drag.start', words));
      },
      move: (x, y) => {
        pointerAt.current = { x, y };
        if (ghost.current) ghost.current.style.transform = ghostAt(pointerAt.current);
        const day = dayAt(x, y);
        setOver((current) => (current === day ? current : day));
      },
      drop: (x, y) => {
        const day = dayAt(x, y);
        endDrag();
        if (day === null || day === dayOf(entry)) setNotice(t('calendar.drag.cancelled', words));
        else void live.current(entry, day - dayOf(entry));
      },
      cancel: () => {
        endDrag();
        setNotice(t('calendar.drag.cancelled', words));
      },
      end: () => {
        stopDrag.current = null;
      },
    });
  }

  /** Alt with an arrow, on an entry's link or its grip: a day sideways, a week up or down. */
  const onEntryKey = (event: KeyboardEvent, entry: Entry) => {
    if (!event.altKey) return;
    const delta = KEY_STEPS[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const onGrip = (event.target as Element).closest('[data-handle]') !== null;
    void move(entry, delta, onGrip ? 'grip' : 'chip');
  };

  /** An entry's grip menu: every move its keys make, one at a time. */
  const gripItems = (entry: Entry): MoveMenuItem[] =>
    GRIP_STEPS.map((step) => ({
      key: String(step.days),
      label: t(step.label),
      onSelect: () => void move(entry, step.days, 'grip'),
    }));

  const weekdays = Array.from({ length: 7 }, (_, i) =>
    intl.formatDate(new Date((first + i) * 86_400_000), { weekday: 'short', timeZone: 'UTC' }),
  );
  const drawn = drawnReleases(data.releases);
  const thisMonth = new Date(month * 86_400_000).getUTCMonth();
  const inMonth = (day: number) => new Date(day * 86_400_000).getUTCMonth() === thisMonth;
  const everyDay = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  // A phone lists the month's days that hold an entry, a release or a sprint's first day.
  const days = compact
    ? everyDay.filter(
        (day) =>
          inMonth(day) &&
          (entries.has(day) ||
            drawn.some((r) => dayNumber(r.date) === day) ||
            data.sprints.some((s) => dayNumber(s.start) === day)),
      )
    : everyDay;
  const dayName = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  return (
    <>
      {/* The month first, then its buttons together: on a phone it has a line of its own (PL-38). */}
      <div className="calendar-tools">
        <h2 aria-live="polite">
          {intl.formatDate(new Date(month * 86_400_000), {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          })}
        </h2>
        <button
          type="button"
          className="button-secondary"
          onClick={() => onMonth(addMonths(month, -1))}
        >
          {t('calendar.previous')}
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => onMonth(addMonths(month, 1))}
        >
          {t('calendar.next')}
        </button>
        <button type="button" className="button-secondary" onClick={() => onMonth(monthOf(today))}>
          {t('calendar.thisMonth')}
        </button>
        {tools}
      </div>
      <p className="board-hint" id={`${id}-hint`}>
        {t(touch ? 'calendar.hintTouch' : 'calendar.hint')}
      </p>
      <p className="board-hint" role="status">
        {notice}
      </p>
      {/* Said, not shown: a line appearing here would move the page under the finger. */}
      <div className="visually-hidden" aria-live="polite">
        {inHandNotice}
      </div>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {compact && days.length === 0 && <EmptyState compact title={t('calendar.emptyMonth')} />}
      <ul
        ref={grid}
        className={compact ? 'glass-card calendar-grid is-agenda' : 'glass-card calendar-grid'}
        aria-label={t('calendar.days')}
        hidden={compact && days.length === 0}
      >
        {!compact &&
          weekdays.map((w) => (
            <li key={w} className="calendar-weekday" aria-hidden="true">
              {w}
            </li>
          ))}
        {days.map((day) => {
          const list = entries.get(day) ?? [];
          const shown = opened.has(day) ? list : list.slice(0, PER_DAY);
          const date = new Date(day * 86_400_000);
          const sprints = data.sprints.filter(
            (s) => dayNumber(s.start) <= day && day <= dayNumber(s.end),
          );
          const releases = drawn.filter((r) => dayNumber(r.date) === day);
          const outside = date.getUTCMonth() !== thisMonth;
          // Monday to Wednesday open a grip's menu towards the later days, the rest towards the
          // earlier ones, so it stays on the page.
          const early = [1, 2, 3].includes(date.getUTCDay());
          return (
            <li
              key={day}
              className={`calendar-day${outside ? ' is-outside' : ''}${day === today ? ' is-today' : ''}${over === day ? ' is-drop-target' : ''}${early ? ' is-early-week' : ''}`}
              aria-label={t('calendar.day', { date: dateText(day), count: list.length })}
              data-drop-day={day}
            >
              <span className="calendar-date" aria-hidden="true">
                {compact ? dayName(day) : date.getUTCDate()}
              </span>
              {sprints.map((s) =>
                // A band on every day of the sprint, named on its first day and on Mondays; in a
                // phone's list of days, named on each.
                compact || day === dayNumber(s.start) || day === first || date.getUTCDay() === 1 ? (
                  <span key={`s${s.id}`} className="calendar-sprint" title={s.name}>
                    {s.name}
                  </span>
                ) : (
                  <span
                    key={`s${s.id}`}
                    className="calendar-sprint is-continued"
                    aria-hidden="true"
                  />
                ),
              )}
              {releases.map((r) => (
                <span key={r.key} className="calendar-release">
                  {t('calendar.release', { name: releaseMarkerText(t, r) })}
                </span>
              ))}
              {shown.map((entry) => {
                const name = entryId(entry);
                const inHand = dragging !== null && entryId(dragging) === name;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: Alt and an arrow from the entry's link or its grip
                  <div
                    key={name}
                    className={`calendar-entry${inHand ? ' is-dragging' : ''}`}
                    data-entry={name}
                    onKeyDown={(event) => onEntryKey(event, entry)}
                  >
                    <a
                      href={routeHref(`#/tickets/${encodeURIComponent(entry.ticket.key)}`)}
                      // The entry is dragged, not the link's address (the browser's own drag
                      // would end ours).
                      draggable={false}
                      className={`calendar-chip${entry.kind === 'start' ? ' is-start' : ''}`}
                      data-stage={entry.ticket.stage}
                      aria-describedby={`${id}-hint`}
                      // The name begins with the words shown, "Starts:" included (TR-19).
                      aria-label={t(
                        entry.kind === 'due' ? 'calendar.chipDue' : 'calendar.chipStart',
                        { key: entry.ticket.key, summary: entry.ticket.summary },
                      )}
                      onPointerDown={(event) => {
                        // A mouse drags the entry from anywhere on it; a finger, by its grip.
                        if (event.pointerType === 'mouse') beginDrag(event, entry);
                      }}
                    >
                      {entry.kind === 'start' ? `${t('calendar.starts')} ` : ''}
                      {entry.ticket.key} {entry.ticket.summary}
                    </a>
                    <MoveMenu
                      className="calendar-grip"
                      label={t(entry.kind === 'due' ? 'calendar.grip.due' : 'calendar.grip.start', {
                        key: entry.ticket.key,
                      })}
                      handle={name}
                      items={gripItems(entry)}
                      onDragStart={(event) => beginDrag(event, entry)}
                    />
                  </div>
                );
              })}
              {list.length > PER_DAY && (
                <button
                  type="button"
                  className="calendar-more"
                  aria-expanded={opened.has(day)}
                  aria-label={
                    opened.has(day)
                      ? undefined
                      : t('calendar.moreLabel', {
                          count: list.length - PER_DAY,
                          date: dateText(day),
                        })
                  }
                  onClick={() =>
                    setOpened((current) => {
                      const next = new Set(current);
                      if (next.has(day)) next.delete(day);
                      else next.add(day);
                      return next;
                    })
                  }
                >
                  {opened.has(day)
                    ? t('calendar.fewer')
                    : t('calendar.more', { count: list.length - PER_DAY })}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {data.truncated && <p className="board-hint">{truncatedText}</p>}
      {dragging && (
        <div
          ref={ghost}
          className="drag-ghost"
          aria-hidden="true"
          style={{ transform: ghostAt(pointerAt.current) }}
        >
          {`${dragging.ticket.key} ${dragging.ticket.summary}`}
        </div>
      )}
    </>
  );
}
