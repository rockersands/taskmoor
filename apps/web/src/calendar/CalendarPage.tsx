import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, isoDay } from '../timeline/client';
import {
  type CalendarClient,
  type CalendarData,
  type CalendarTicket,
  calendarClient,
} from './client';

export interface CalendarPageProps {
  trackKey: string;
  client?: CalendarClient;
  /** Today, for the month shown first and the today mark. */
  now?: () => Date;
}

/** A ticket on a day: on its due day, or on its start day when that differs. */
interface Entry {
  ticket: CalendarTicket;
  kind: 'due' | 'start';
}

/** The first day of the month that `day` is in. */
const monthOf = (day: number) => {
  const d = new Date(day * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86_400_000;
};
const addMonths = (month: number, n: number) => {
  const d = new Date(month * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 86_400_000;
};

/**
 * A track's calendar (M1-049; AGL-017): a month of weeks from Monday, each ticket on its due
 * day (and on its start day when that differs, marked as a start), the sprints of the track's
 * boards and its releases on their days, today marked. Drag a ticket to another day to move it
 * (its start moves along, keeping its length; AGL-017 (1)); with the keyboard, Alt and the
 * arrows move it by a day or a week; choosing it opens the ticket over the page, with both days. Every
 * move is the ticket's own change, so its permission and history apply.
 */
export function CalendarPage({
  trackKey,
  client = calendarClient,
  now = () => new Date(),
}: CalendarPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const today = dayNumber(now().toISOString().slice(0, 10));
  const [month, setMonth] = useState(() => monthOf(today));
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState<Entry | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // Whole weeks from the Monday on or before the 1st to the Sunday on or after the last day.
  const first = month - ((month + 3) % 7);
  const last = (() => {
    const end = addMonths(month, 1) - 1;
    return end + ((7 - ((end + 4) % 7)) % 7);
  })();

  const load = useCallback(() => {
    client.calendar(trackKey, isoDay(first), isoDay(last)).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, trackKey, first, last]);
  useEffect(load, [load]);
  // Its days can change in the ticket pop-up.
  useTicketChanges(load);

  if (failed) {
    return (
      <section className="calendar-page">
        <p className="board-problem" role="alert">
          {t('calendar.notFound')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-empty">{t('reports.loading')}</p>;

  const dateText = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const entries = new Map<number, Entry[]>();
  const put = (day: number, entry: Entry) => entries.set(day, [...(entries.get(day) ?? []), entry]);
  for (const ticket of data.tickets) {
    if (ticket.due) put(dayNumber(ticket.due), { ticket, kind: 'due' });
    if (ticket.start && ticket.start !== ticket.due)
      put(dayNumber(ticket.start), { ticket, kind: 'start' });
  }

  /** Moves an entry's day by `delta` days: a due day takes its start along, keeping the length. */
  const move = async (entry: Entry, delta: number) => {
    if (delta === 0) return;
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
    const outcome = await client.move(ticket.key, days);
    if (outcome.ok) {
      const day = days[entry.kind === 'due' ? 'dueDate' : 'startDate'] as string;
      setNotice(
        t(entry.kind === 'due' ? 'calendar.movedDue' : 'calendar.movedStart', {
          key: ticket.key,
          date: dateText(dayNumber(day)),
        }),
      );
    } else {
      setProblem(t('calendar.moveFailed', { key: ticket.key }));
    }
    load();
  };

  const onDrop = (event: DragEvent, day: number) => {
    event.preventDefault();
    const entry = dragging;
    setDragging(null);
    setOver(null);
    if (!entry) return;
    const from = dayNumber(
      (entry.kind === 'due' ? entry.ticket.due : entry.ticket.start) as string,
    );
    void move(entry, day - from);
  };
  const onChipKey = (event: KeyboardEvent, entry: Entry) => {
    if (!event.altKey) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    void move(entry, delta);
  };

  const weekdays = Array.from({ length: 7 }, (_, i) =>
    intl.formatDate(new Date((first + i) * 86_400_000), { weekday: 'short', timeZone: 'UTC' }),
  );
  const days = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const thisMonth = new Date(month * 86_400_000).getUTCMonth();

  return (
    <section className="calendar-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {t('calendar.title', { name: data.track.name })}
        </h1>
        <a href={routeHref(`#/tracks/${encodeURIComponent(data.track.key)}`)}>
          {t('releases.toSummary')}
        </a>
      </div>
      <div className="calendar-tools">
        <button
          type="button"
          className="button-secondary"
          onClick={() => setMonth(addMonths(month, -1))}
        >
          {t('calendar.previous')}
        </button>
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
          onClick={() => setMonth(addMonths(month, 1))}
        >
          {t('calendar.next')}
        </button>
        <button type="button" className="button-secondary" onClick={() => setMonth(monthOf(today))}>
          {t('calendar.thisMonth')}
        </button>
      </div>
      <p className="board-hint" id={`${id}-hint`}>
        {t('calendar.hint')}
      </p>
      <p className="board-hint" role="status">
        {notice}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <ul className="calendar-grid" aria-label={t('calendar.days')}>
        {weekdays.map((w) => (
          <li key={w} className="calendar-weekday" aria-hidden="true">
            {w}
          </li>
        ))}
        {days.map((day) => {
          const list = entries.get(day) ?? [];
          const date = new Date(day * 86_400_000);
          const sprints = data.sprints.filter(
            (s) => dayNumber(s.start) <= day && day <= dayNumber(s.end),
          );
          const releases = data.releases.filter((r) => dayNumber(r.date) === day);
          const outside = date.getUTCMonth() !== thisMonth;
          return (
            <li
              key={day}
              className={`calendar-day${outside ? ' is-outside' : ''}${day === today ? ' is-today' : ''}${over === day ? ' is-drop-target' : ''}`}
              aria-label={t('calendar.day', { date: dateText(day), count: list.length })}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (over !== day) setOver(day);
              }}
              onDragLeave={(event) => {
                if (
                  !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)
                ) {
                  setOver((current) => (current === day ? null : current));
                }
              }}
              onDrop={(event) => onDrop(event, day)}
            >
              <span className="calendar-date" aria-hidden="true">
                {date.getUTCDate()}
              </span>
              {sprints.map((s) =>
                // A band on every day of the sprint, named on its first day and on Mondays.
                day === dayNumber(s.start) || day === first || date.getUTCDay() === 1 ? (
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
                <span key={`r${r.id}`} className="calendar-release">
                  {t('calendar.release', { name: r.name })}
                </span>
              ))}
              {list.map((entry) => (
                <a
                  key={`${entry.ticket.id}-${entry.kind}`}
                  href={routeHref(`#/tickets/${encodeURIComponent(entry.ticket.key)}`)}
                  draggable
                  className={`calendar-chip${entry.kind === 'start' ? ' is-start' : ''}`}
                  data-stage={entry.ticket.stage}
                  aria-describedby={`${id}-hint`}
                  aria-label={t(entry.kind === 'due' ? 'calendar.chipDue' : 'calendar.chipStart', {
                    key: entry.ticket.key,
                    summary: entry.ticket.summary,
                  })}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', entry.ticket.key);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(entry);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onKeyDown={(event) => onChipKey(event, entry)}
                >
                  {entry.kind === 'start' ? `${t('calendar.starts')} ` : ''}
                  {entry.ticket.key} {entry.ticket.summary}
                </a>
              ))}
            </li>
          );
        })}
      </ul>
      {data.truncated && <p className="board-hint">{t('calendar.truncated')}</p>}
    </section>
  );
}
