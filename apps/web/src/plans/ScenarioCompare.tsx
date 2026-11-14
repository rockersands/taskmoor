import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import type { PlanFilters } from './client';
import type { ComparedEnd, Comparison, ScenarioClient, ScenarioRow } from './scenarioClient';

export interface ScenarioCompareProps {
  planId: number;
  client: ScenarioClient;
  scenarios: readonly ScenarioRow[];
  filters: PlanFilters;
  /** The two sides in the address, `live` or a scenario's id; chosen here when not given. */
  a?: string | undefined;
  b?: string | undefined;
  onChange: (sides: { a: string; b: string }) => void;
  /** The phone's layout whatever the width (stories, whose browser is not a phone). */
  phone?: boolean;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/**
 * Two sides of a plan side by side (T-089e; PLN-003; ADR-122 stage 6), each the tickets as they
 * are (Live) or a scenario: the plan's end (the latest due day of open tickets, never without how
 * many have none), each plan team's end, the draft changes each holds, how many tickets end later
 * or earlier, and the tickets that differ. Each difference is said in words ("Ends 8 days later in
 * Faster"). The numbers are of the tickets the viewer sees. On a desktop the measures are tables;
 * on a phone each measure and each team is a card.
 */
export function ScenarioCompare({
  planId,
  client,
  scenarios,
  filters,
  a: askedA,
  b: askedB,
  onChange,
  phone = false,
}: ScenarioCompareProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY) || phone;
  const fallbackB = String(scenarios.find((s) => s.main)?.id ?? scenarios[0]?.id ?? 'live');
  const a = askedA ?? 'live';
  const b = askedB ?? fallbackB;
  const [data, setData] = useState<Comparison | null>(null);
  const [failed, setFailed] = useState(false);
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  useEffect(() => {
    let live = true;
    setFailed(false);
    client.compare(planId, a, b, filters).then(
      (c) => live && setData(c),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, planId, a, b, filterKey]);

  const sideName = (side: string) =>
    side === 'live'
      ? t('scenario.compare.live')
      : (scenarios.find((s) => String(s.id) === side)?.name ?? t('scenario.compare.gone'));
  const day = (text: string | null) =>
    text === null
      ? t('scenario.compare.noEnd')
      : intl.formatDate(new Date(`${text}T00:00:00Z`), {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        });
  const endText = (end: ComparedEnd) =>
    end.undated > 0
      ? t('scenario.compare.endUndated', { end: day(end.due), count: end.undated })
      : day(end.due);
  /** The difference of B from A in words. */
  const difference = (x: ComparedEnd, y: ComparedEnd) => {
    const name = sideName(b);
    if (x.due === null && y.due === null) return t('scenario.compare.neither');
    if (y.due === null) return t('scenario.compare.noEndIn', { name });
    if (x.due === null) return t('scenario.compare.onlyIn', { name });
    const days = dayNumber(y.due) - dayNumber(x.due);
    if (days === 0) return t('scenario.compare.same');
    return days > 0
      ? t('scenario.compare.later', { count: days, name })
      : t('scenario.compare.earlier', { count: -days, name });
  };

  const choose = (which: 'a' | 'b', value: string) =>
    onChange(which === 'a' ? { a: value, b } : { a, b: value });
  const options = [
    { value: 'live', label: t('scenario.compare.live') },
    ...scenarios.map((s) => ({
      value: String(s.id),
      label: s.main ? t('scenario.bar.mainOption', { name: s.name }) : s.name,
    })),
  ];

  const measures = data
    ? [
        {
          key: 'end',
          name: t('scenario.compare.planEnd'),
          a: endText(data.a.end),
          b: endText(data.b.end),
          diff: difference(data.a.end, data.b.end),
        },
        {
          key: 'drafts',
          name: t('scenario.compare.drafts'),
          a: draftsText(data.a.scenario),
          b: draftsText(data.b.scenario),
          diff: '',
        },
        {
          key: 'moved',
          name: t('scenario.compare.moved'),
          a: '',
          b: '',
          diff: t('scenario.compare.movedWords', {
            later: data.later,
            earlier: data.earlier,
            name: sideName(b),
          }),
        },
      ]
    : [];
  function draftsText(s: Comparison['a']['scenario']) {
    if (!s) return t('scenario.compare.noDrafts');
    return s.notShown > 0
      ? t('scenario.compare.draftsHidden', { count: s.drafts, hidden: s.notShown })
      : t('scenario.compare.draftsCount', { count: s.drafts });
  }
  const teams = data
    ? data.a.teams.map((ta, i) => {
        const tb = data.b.teams[i] ?? { team: ta.team, due: null, ticket: null, undated: 0 };
        return {
          key: String(ta.team?.id ?? 'none'),
          name: ta.team?.name ?? t('scenario.compare.otherTeam'),
          a: endText(ta),
          b: endText(tb),
          diff: difference(ta, tb),
        };
      })
    : [];

  const teamNames = new Map(
    (data?.a.teams ?? []).flatMap((x) => (x.team ? [[x.team.id, x.team.name] as const] : [])),
  );
  /** A ticket's days on one side, and its team where the sides differ in it. */
  const sideDays = (
    side: { start: string | null; due: string | null; team: number | null },
    withTeam: boolean,
  ) =>
    withTeam
      ? t('scenario.compare.daysTeam', {
          start: day(side.start),
          due: day(side.due),
          team:
            side.team === null
              ? t('scenario.value.none')
              : (teamNames.get(side.team) ?? t('scenario.compare.otherTeam')),
        })
      : t('scenario.compare.days', { start: day(side.start), due: day(side.due) });
  const nameA = sideName(a);
  const nameB = sideName(b);
  const table = (caption: string, first: string, rows: typeof measures) => (
    <div className="glass-card glass-scroller scenario-table-scroll">
      <table className="scenario-table scenario-compare-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col">{nameA}</th>
            <th scope="col">{nameB}</th>
            <th scope="col">{t('scenario.compare.difference')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.name}</th>
              <td>{r.a}</td>
              <td>{r.b}</td>
              <td>{r.diff}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const cards = (label: string, rows: typeof measures) => (
    <ul className="scenario-compare-cards" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="glass-card">
          <h4>{r.name}</h4>
          <dl>
            {r.a !== '' && (
              <div>
                <dt>{nameA}</dt>
                <dd>{r.a}</dd>
              </div>
            )}
            {r.b !== '' && (
              <div>
                <dt>{nameB}</dt>
                <dd>{r.b}</dd>
              </div>
            )}
          </dl>
          {r.diff !== '' && <p className="scenario-compare-diff">{r.diff}</p>}
        </li>
      ))}
    </ul>
  );

  return (
    <section className="scenario-compare" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('scenario.compare.title')}</h3>
      <form className="scenario-compare-sides" onSubmit={(event) => event.preventDefault()}>
        <label className="form-field" htmlFor={`${id}-a`}>
          <span className="form-label">{t('scenario.compare.a')}</span>
          <select id={`${id}-a`} value={a} onChange={(event) => choose('a', event.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field" htmlFor={`${id}-b`}>
          <span className="form-label">{t('scenario.compare.b')}</span>
          <select id={`${id}-b`} value={b} onChange={(event) => choose('b', event.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </form>
      <p className="board-hint">{t('scenario.compare.yours')}</p>
      {failed ? (
        <p className="board-problem" role="alert">
          {t('scenario.compare.failed')}
        </p>
      ) : !data ? (
        <p className="report-loading">{t('reports.loading')}</p>
      ) : (
        <>
          {compact
            ? cards(t('scenario.compare.measures'), measures)
            : table(t('scenario.compare.measures'), t('scenario.compare.measure'), measures)}
          {data.teamField === null ? (
            <p className="board-hint">{t('scenario.compare.noTeamField')}</p>
          ) : compact ? (
            cards(t('scenario.compare.teams', { field: data.teamField.name }), teams)
          ) : (
            table(
              t('scenario.compare.teams', { field: data.teamField.name }),
              t('scenario.compare.team'),
              teams,
            )
          )}
          <h4>{t('scenario.compare.differing', { count: data.differing.count })}</h4>
          {data.differing.tickets.length > 0 && (
            <ul className="scenario-differing">
              {data.differing.tickets.map((d) => (
                <li key={d.id}>
                  <a href={routeHref(`#/tickets/${encodeURIComponent(d.key)}`)}>
                    <span className="scenario-key">{d.key}</span> {d.summary}
                  </a>
                  <span className="scenario-meta">
                    {t('scenario.compare.ticketSides', {
                      a: nameA,
                      aDays: sideDays(d.a, d.a.team !== d.b.team),
                      b: nameB,
                      bDays: sideDays(d.b, d.a.team !== d.b.team),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.differing.count > data.differing.tickets.length && (
            <p className="board-hint">
              {t('scenario.compare.firstOf', {
                shown: data.differing.tickets.length,
                count: data.differing.count,
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
