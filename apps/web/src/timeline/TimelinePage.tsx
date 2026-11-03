import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import {
  dayNumber,
  isoDay,
  type Timeline,
  type TimelineClient,
  type TimelineItem,
  timelineClient,
} from './client';

export interface TimelinePageProps {
  trackKey: string;
  client?: TimelineClient;
  /** Today, for the today line and the default range. */
  now?: () => Date;
}

type Zoom = 'weeks' | 'months' | 'quarters';
/** Pixels per day at each zoom. */
const SCALE: Record<Zoom, number> = { weeks: 28, months: 8, quarters: 3 };
const ZOOMS: { id: Zoom; label: MessageId }[] = [
  { id: 'weeks', label: 'timeline.zoom.weeks' },
  { id: 'months', label: 'timeline.zoom.months' },
  { id: 'quarters', label: 'timeline.zoom.quarters' },
];
/** Every row's height, so dependency lines know where rows are (44px: a touch target). */
const ROW = 44;

interface Row {
  item: TimelineItem;
  depth: number;
  hasChildren: boolean;
}

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

/** A ticket's bar: its own (or its sprint's) days, or the span rolled up from its children. */
function barOf(item: TimelineItem): { start: number; due: number; kind: 'own' | 'rollup' } | null {
  if (item.start !== null || item.due !== null) {
    const start = dayNumber(item.start ?? (item.due as string));
    const due = dayNumber(item.due ?? (item.start as string));
    return { start, due: Math.max(start, due), kind: 'own' };
  }
  const r = item.rollup;
  if (r && (r.start !== null || r.due !== null)) {
    const start = dayNumber(r.start ?? (r.due as string));
    return { start, due: Math.max(start, dayNumber(r.due ?? (r.start as string))), kind: 'rollup' };
  }
  return null;
}

/**
 * A track's timeline (M1-048; AGL-015): its tickets as bars over the calendar, parents above
 * their children (collapsible), zoomed by weeks, months or quarters. A parent without dates of
 * its own shows the span rolled up from its children, and every parent says how many of them are
 * closed. Tickets in a sprint without dates show the sprint's. Lines join a blocking ticket to
 * those it blocks; sprints are bands and releases lines, with today marked.
 *
 * Rescheduling: drag a bar to move it, or its ends to change its start or due day; Alt with
 * the left or right arrow moves a focused bar a day (with Shift, a week); choosing a bar opens a
 * side panel with both days, its dependencies and where its dates come from. Every change is
 * the ticket's own (`PATCH /tickets/:key`), so its permission and history apply.
 */
export function TimelinePage({
  trackKey,
  client = timelineClient,
  now = () => new Date(),
}: TimelinePageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [data, setData] = useState<Timeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<Zoom>('weeks');
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Set when a drag ends, so the click that follows does not open the panel. */
  const justDragged = useRef(false);

  const load = useCallback(() => {
    client.timeline(trackKey).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, trackKey]);
  useEffect(load, [load]);
  useTicketChanges(load);

  const today = dayNumber(now().toISOString().slice(0, 10));
  const px = SCALE[zoom];

  const rows = useMemo(() => {
    if (!data) return [];
    const listed = new Set(data.items.map((i) => i.id));
    const children = new Map<number, TimelineItem[]>();
    for (const i of data.items) {
      if (i.parentId !== null && listed.has(i.parentId)) {
        children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
      }
    }
    const out: Row[] = [];
    const visit = (item: TimelineItem, depth: number) => {
      const kids = children.get(item.id) ?? [];
      out.push({ item, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(item.id)) for (const k of kids) visit(k, depth + 1);
    };
    for (const i of data.items) {
      if (i.parentId === null || !listed.has(i.parentId)) visit(i, 0);
    }
    return out;
  }, [data, collapsed]);

  // The calendar shown: every bar and marker, today, and some room on both sides.
  const range = useMemo(() => {
    const days = [today];
    for (const i of data?.items ?? []) {
      const bar = barOf(i);
      if (bar) days.push(bar.start, bar.due);
    }
    for (const s of data?.markers.sprints ?? []) days.push(dayNumber(s.start), dayNumber(s.end));
    for (const r of data?.markers.releases ?? []) days.push(dayNumber(r.date));
    const first = Math.min(...days) - 14;
    const last = Math.max(...days) + 28;
    // From a Monday (1970-01-01, day 0, was a Thursday).
    const from = first - ((first + 3) % 7);
    return { from, days: last - from + 1 };
  }, [data, today]);

  const scrollToToday = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // Today a quarter of the way into the lanes in view, so the days ahead show, even on phones.
    const label = el.querySelector<HTMLElement>('.timeline-corner')?.offsetWidth ?? 0;
    el.scrollLeft = Math.max(0, (today - range.from) * px - (el.clientWidth - label) / 4);
  }, [today, range.from, px]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the timeline first arrives
  useEffect(() => {
    if (data) scrollToToday();
  }, [data === null, zoom]);

  if (failed) {
    return (
      <section className="timeline-page">
        <p className="board-problem" role="alert">
          {t('timeline.notFound')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-empty">{t('reports.loading')}</p>;

  const dayText = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const x = (day: number) => (day - range.from) * px;
  const width = range.days * px;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const rowOf = new Map(rows.map((r, i) => [r.item.id, i]));

  /** Saves new days for a ticket; the timeline is read again either way. */
  const save = async (item: TimelineItem, start: string | null, due: string | null) => {
    setProblem(null);
    const outcome = await client.reschedule(item.key, { startDate: start, dueDate: due });
    if (outcome.ok) {
      setNotice(
        t('timeline.rescheduled', {
          key: item.key,
          start: start ? dayText(dayNumber(start)) : t('timeline.noDate'),
          due: due ? dayText(dayNumber(due)) : t('timeline.noDate'),
        }),
      );
    } else {
      setProblem(t('timeline.rescheduleFailed', { key: item.key }));
    }
    load();
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
    if (!bar || bar.kind !== 'own' || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    const edge = Math.min(10, rect.width / 3);
    const mode = offset < edge ? 'start' : offset > rect.width - edge ? 'end' : 'move';
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
    if (!d || !d.moved || d.shift === 0) return;
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
    if (!bar || bar.kind !== 'own') return;
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

  return (
    <section className="timeline-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {t('timeline.title', { name: data.track.name })}
        </h1>
        <a href={routeHref(`#/tracks/${encodeURIComponent(data.track.key)}`)}>
          {t('releases.toSummary')}
        </a>
      </div>
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
      </div>
      <p className="board-hint" id={`${id}-hint`}>
        {t('timeline.hint')}
      </p>
      <p className="board-hint" role="status">
        {notice}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="timeline-body">
        <div className="timeline-scroll" ref={scroller}>
          <div className="timeline-head" aria-hidden="true">
            <div className="timeline-corner">{t('timeline.ticket')}</div>
            <div className="timeline-scale" style={{ width }}>
              {months.map((m) => (
                <span key={`m${m.day}`} className="timeline-month" style={{ left: x(m.day) }}>
                  {m.label}
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
              {data.markers.releases.map((r) => (
                <span
                  key={`r${r.id}`}
                  className="timeline-release-label"
                  style={{ left: x(dayNumber(r.date)) }}
                  title={r.name}
                >
                  ◆ {r.name}
                </span>
              ))}
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
              {data.markers.releases.map((r) => (
                <span
                  key={`rl${r.id}`}
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
                  const a = from ? barOf(from) : null;
                  const b = to ? barOf(to) : null;
                  const ra = rowOf.get(l.from);
                  const rb = rowOf.get(l.to);
                  if (!a || !b || ra === undefined || rb === undefined) return null;
                  const x1 = x(a.due + 1);
                  const y1 = ra * ROW + ROW / 2;
                  const x2 = x(b.start);
                  const y2 = rb * ROW + ROW / 2;
                  const late = b.start <= a.due;
                  return (
                    <path
                      key={`${l.from}-${l.to}`}
                      className={`timeline-link${late ? ' is-late' : ''}`}
                      d={`M ${x1} ${y1} H ${x1 + 8} V ${y2} H ${Math.max(x2, x1 + 8)}`}
                    />
                  );
                })}
              </svg>
            </div>
            <ul className="timeline-rows">
              {rows.map((row) => {
                const { item } = row;
                const live = drag?.id === item.id ? dragged(drag) : null;
                const bar = barOf(item);
                const days = live ?? bar;
                const progress = item.rollup;
                return (
                  <li
                    key={item.id}
                    className={`timeline-row${selected === item.id ? ' is-selected' : ''}`}
                    data-stage={item.status.stage}
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
                          aria-label={t(
                            collapsed.has(item.id) ? 'timeline.expand' : 'timeline.collapse',
                            { key: item.key },
                          )}
                          onClick={() =>
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                        >
                          {collapsed.has(item.id) ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span className="timeline-toggle-space" />
                      )}
                      <a
                        href={routeHref(`#/tickets/${encodeURIComponent(item.key)}`)}
                        className="timeline-key"
                      >
                        {item.key}
                      </a>
                      <span className="timeline-summary">{item.summary}</span>
                      {progress && (
                        <span className="timeline-progress-text">
                          {t('timeline.progress', {
                            closed: progress.closed,
                            count: progress.total,
                          })}
                        </span>
                      )}
                    </div>
                    <div className="timeline-lane" style={{ width }}>
                      {days && bar?.kind === 'own' ? (
                        <button
                          type="button"
                          className={`timeline-bar${item.dated === 'sprint' ? ' is-sprint' : ''}${live ? ' is-dragging' : ''}`}
                          style={{ left: x(days.start), width: (days.due - days.start + 1) * px }}
                          aria-describedby={`${id}-hint`}
                          aria-label={t('timeline.bar', {
                            key: item.key,
                            start: dayText(days.start),
                            due: dayText(days.due),
                          })}
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
                          style={{ left: x(today) }}
                          onClick={() => setSelected(item.id)}
                          aria-label={t('timeline.schedule', { key: item.key })}
                        >
                          {t('timeline.noDates')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        {chosen && (
          <SchedulePanel
            key={chosen.id}
            item={chosen}
            blocks={data.links
              .filter((l) => l.from === chosen.id)
              .map((l) => byId.get(l.to)?.key ?? '')}
            blockedBy={data.links
              .filter((l) => l.to === chosen.id)
              .map((l) => byId.get(l.from)?.key ?? '')}
            onSave={(start, due) => void save(chosen, start, due)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      {data.truncated && <p className="board-hint">{t('timeline.truncated')}</p>}
    </section>
  );
}

/** A ticket's days in a side panel: the keyboard's and the phone's way to reschedule. */
function SchedulePanel({
  item,
  blocks,
  blockedBy,
  onSave,
  onClose,
}: {
  item: TimelineItem;
  blocks: string[];
  blockedBy: string[];
  onSave: (start: string | null, due: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const [start, setStart] = useState(item.start ?? '');
  const [due, setDue] = useState(item.due ?? '');
  const bad = start !== '' && due !== '' && start > due;
  return (
    <aside className="timeline-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('timeline.panel.title', { key: item.key })}</h2>
      <p className="timeline-panel-summary">{item.summary}</p>
      {item.dated === 'sprint' && <p className="board-hint">{t('timeline.panel.sprint')}</p>}
      {item.rollup && (
        <p className="board-hint">
          {item.rollup.start || item.rollup.due
            ? t('timeline.panel.rollup', {
                start: item.rollup.start ?? t('timeline.noDate'),
                due: item.rollup.due ?? t('timeline.noDate'),
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
          <button type="submit" className="button-primary" disabled={bad}>
            {t('timeline.panel.save')}
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
    </aside>
  );
}
