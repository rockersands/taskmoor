import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { localDay } from '../timeline/client';
import {
  BASELINE_SHOWS,
  type BaselineClient,
  type BaselineComparison,
  type BaselineDays,
  type BaselineRow,
  type BaselineShow,
  type BaselineTicket,
} from './baselineClient';
import { baselineCsv } from './baselineExport';
import type { PlanFilters } from './client';
import { csvBlob, fileName, saveBlob } from './download';

export interface BaselineCompareProps {
  planId: number;
  /** The plan's name, for the file's name. */
  planName: string;
  client: BaselineClient;
  baseline: BaselineRow;
  filters: PlanFilters;
  /** The scenario whose days are now (the open one); Live without one. */
  scenario?: number | undefined;
  /** The address that closes the comparison. */
  closeHref: string;
  /** Today, for the file's name. */
  now?: () => Date;
}

const SHOW_LABEL: Record<BaselineShow, MessageId> = {
  slipped: 'baselines.compare.show.slipped',
  earlier: 'baselines.compare.show.earlier',
  added: 'baselines.compare.show.added',
  all: 'baselines.compare.show.all',
};

/** The most pages a file reads: 250 of 200 tickets, a whole plan of 50,000. */
const MAX_FILE_PAGES = 250;

/** A side's end: its due day, else its start day, never before the start (`barOf`'s rule). */
const endOf = (d: BaselineDays | null): string | null => {
  const days = [d?.start, d?.due].filter((x): x is string => typeof x === 'string').sort();
  return days.at(-1) ?? null;
};

/**
 * A baseline set against the days now (T-089a; PLN-011; ADR-122 stage 9), laid out as the
 * Scenarios compare is: first a sentence ("3 tickets end later than in Kick-off, by up to 14 days;
 * 1 earlier; 1 the same. The plan ends 3 days later (4 Dec, was 1 Dec)."), with how many of the
 * baseline's tickets the reader is not shown; then filter buttons (Later, Earlier, Added since,
 * All) and a list, never a table, a ticket a line with its delay in words and "(closed)" where it
 * is. Show more reads the next page; Download CSV holds every page of the filter chosen.
 */
export function BaselineCompare({
  planId,
  planName,
  client,
  baseline,
  filters,
  scenario,
  closeHref,
  now = () => new Date(),
}: BaselineCompareProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The last page read takes Show more away: its first ticket takes focus, at this place.
  const focusAt = useRef<number | null>(null);
  const [show, setShow] = useState<BaselineShow>('slipped');
  const base = JSON.stringify([baseline.id, baseline.version, scenario ?? null, filters]);
  const key = JSON.stringify([base, show]);
  // A list shows only for what it was read for: another filter waits for its own. The sentence and
  // the filter buttons stay while it is read, so the button just pressed keeps focus.
  const [read, setRead] = useState<{
    key: string;
    base: string;
    first: BaselineComparison;
    tickets: BaselineTicket[];
    next: string | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const data = read?.key === key ? read : null;
  const shown = read?.base === base ? read : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the comparison opens
  useEffect(() => heading.current?.focus(), [baseline.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when what it is read for changes, by `key`
  useEffect(() => {
    let live = true;
    setFailed(false);
    client.compare(planId, baseline.id, { filters, scenario, show }).then(
      (c) => live && setRead({ key, base, first: c, tickets: c.tickets, next: c.next }),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, planId, key]);

  const day = (text: string, other?: string | null) =>
    intl.formatDate(new Date(`${text}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      // The year only where the two sides fall in different years.
      ...(other && other.slice(0, 4) !== text.slice(0, 4) ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  /** "due 21 Feb" for a ticket's own due day, else "ends 21 Feb"; "no days" without one. */
  const endText = (d: BaselineDays | null, other: string | null) => {
    const end = endOf(d);
    if (end === null) return t('baselines.compare.noDays');
    return d?.dated === 'own' && d.due === end
      ? t('baselines.compare.due', { day: day(end, other) })
      : t('baselines.compare.ends', { day: day(end, other) });
  };
  const line = (x: BaselineTicket) => {
    const was = endOf(x.was);
    const nowEnd = endOf(x.now);
    let words: string;
    if (x.was === null) {
      words = t('baselines.compare.addedLine', { now: endText(x.now, null) });
    } else if (x.delay !== null && was !== null) {
      const sides = { now: endText(x.now, was), was: day(was, nowEnd) };
      words =
        x.delay > 0
          ? t('baselines.compare.dayLater', { count: x.delay, ...sides })
          : x.delay < 0
            ? t('baselines.compare.dayEarlier', { count: -x.delay, ...sides })
            : t('baselines.compare.sameEnd', { now: endText(x.now, null) });
    } else if (was === null) {
      words = t('baselines.compare.undatedThenLine', { now: endText(x.now, null) });
    } else {
      words = t('baselines.compare.undatedNowLine', { was: endText(x.was, null) });
    }
    return x.closed ? `${words} ${t('baselines.compare.closed')}` : words;
  };

  const more = async () => {
    if (!data?.next || busy) return;
    setBusy(true);
    setProblem(null);
    const page = await client
      .compare(planId, baseline.id, { filters, scenario, show, after: data.next })
      .catch(() => null);
    setBusy(false);
    if (!page) {
      setProblem(t('baselines.compare.failed'));
      return;
    }
    if (page.next === null && page.tickets.length > 0) focusAt.current = data.tickets.length;
    setRead((was) =>
      was?.key === key
        ? { ...was, tickets: [...was.tickets, ...page.tickets], next: page.next }
        : was,
    );
  };
  useEffect(() => {
    const at = focusAt.current;
    if (at === null) return;
    focusAt.current = null;
    listRef.current?.querySelectorAll<HTMLAnchorElement>(':scope > li > a')[at]?.focus();
  });
  const download = async () => {
    if (!data) return;
    setBusy(true);
    setProblem(null);
    try {
      const tickets = [...data.first.tickets];
      let next = data.first.next;
      for (let i = 1; next && i < MAX_FILE_PAGES; i++) {
        const page = await client.compare(planId, baseline.id, {
          filters,
          scenario,
          show,
          after: next,
        });
        tickets.push(...page.tickets);
        next = page.next;
      }
      const text = baselineCsv(t, baseline.name, tickets, data.first.counts.notShown);
      saveBlob(fileName(planName, 'baseline', localDay(now()), 'csv'), csvBlob(text));
    } catch {
      setProblem(t('baselines.compare.downloadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const sentence = (c: BaselineComparison) => {
    const later = t('baselines.compare.later', {
      count: c.counts.slipped,
      name: baseline.name,
      most: Math.max(c.mostLater ?? 0, 0),
    });
    const first = t('baselines.compare.sentence', {
      later,
      earlier: c.counts.earlier,
      same: c.counts.same,
    });
    const { was, now: end, delay } = c.planEnd;
    const plan =
      delay === null || was === null || end === null
        ? t('baselines.compare.planNone')
        : delay > 0
          ? t('baselines.compare.planLater', {
              count: delay,
              now: day(end, was),
              was: day(was, end),
            })
          : delay < 0
            ? t('baselines.compare.planEarlier', {
                count: -delay,
                now: day(end, was),
                was: day(was, end),
              })
            : t('baselines.compare.planSame', { now: day(end) });
    const hidden =
      c.counts.notShown > 0
        ? ` ${t('baselines.compare.notShown', { count: c.counts.notShown })}`
        : '';
    return `${first} ${plan}${hidden}`;
  };
  const countOf = (c: BaselineComparison, s: BaselineShow) =>
    s === 'slipped' ? c.counts.slipped : s === 'earlier' ? c.counts.earlier : c.counts.addedSince;
  const label = (c: BaselineComparison, s: BaselineShow) =>
    s === 'all' ? t(SHOW_LABEL.all) : t(SHOW_LABEL[s], { count: countOf(c, s) });

  return (
    <section className="scenario-compare" aria-labelledby={`${id}-title`}>
      <div className="plan-scenarios-head">
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {t('baselines.compare.title', { name: baseline.name })}
        </h3>
        <div className="scenario-item-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={!data || busy}
            onClick={() => void download()}
          >
            {t('baselines.compare.download')}
          </button>
          <a className="button-secondary" href={routeHref(closeHref)}>
            {t('baselines.compare.close')}
          </a>
        </div>
      </div>
      {failed ? (
        <p className="board-problem" role="alert">
          {t('baselines.compare.failed')}
        </p>
      ) : !shown ? (
        <p className="report-loading">{t('reports.loading')}</p>
      ) : (
        <>
          <p>{sentence(shown.first)}</p>
          <p className="board-hint">
            {shown.first.against === 'live'
              ? t('baselines.compare.againstLive')
              : t('baselines.compare.againstScenario', {
                  name: shown.first.against.scenario.name,
                })}{' '}
            {t('baselines.compare.yours')}
          </p>
          {shown.first.counts.addedSince +
            shown.first.counts.undatedThen +
            shown.first.counts.undatedNow >
            0 && (
            <p className="board-hint">
              {t('baselines.compare.others', {
                added: shown.first.counts.addedSince,
                undatedThen: shown.first.counts.undatedThen,
                undatedNow: shown.first.counts.undatedNow,
              })}
            </p>
          )}
          <fieldset className="filter-chips">
            <legend className="visually-hidden">{t('baselines.compare.show')}</legend>
            {BASELINE_SHOWS.map((s) => (
              <button
                key={s}
                type="button"
                className="filter-chip"
                aria-pressed={show === s}
                onClick={() => setShow(s)}
              >
                {label(shown.first, s)}
              </button>
            ))}
          </fieldset>
          {problem && (
            <p className="board-problem" role="alert">
              {problem}
            </p>
          )}
          {!data ? (
            <p className="report-loading">{t('reports.loading')}</p>
          ) : data.tickets.length === 0 ? (
            <EmptyState compact title={t('baselines.compare.none')} />
          ) : (
            <ul
              ref={listRef}
              className="scenario-differing"
              aria-label={t('baselines.compare.list', { which: label(data.first, show) })}
            >
              {data.tickets.map((x) => (
                <li key={x.id}>
                  <a href={routeHref(`#/tickets/${encodeURIComponent(x.key)}`)}>
                    <span className="scenario-key">{x.key}</span> {x.summary}
                  </a>
                  <span className="scenario-meta">{line(x)}</span>
                </li>
              ))}
            </ul>
          )}
          {data?.next && (
            <div className="scenario-item-actions">
              {/* Busy, yet focusable (`aria-disabled`), so focus stays while a page is read. */}
              <button
                type="button"
                className="button-secondary"
                aria-disabled={busy || undefined}
                onClick={() => void more()}
              >
                {t('baselines.compare.showMore')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
