import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { currentRoute, onRouteChange, replaceRoute } from '../routing/router';
import { ColumnPicker } from '../search/ColumnPicker';
import {
  type SearchClient,
  type SearchField,
  type SearchTicket,
  searchClient,
} from '../search/client';
import { DEFAULT_COLUMNS } from '../search/columns';
import type { RowFormat, Tone } from '../search/ResultTable';
import { useColumnName } from '../search/useColumnName';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { Popover } from '../shell/Popover';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import {
  type FormatRule,
  GROUP_FIELDS,
  type GroupField,
  type GroupValue,
  groupClause,
  type ListClient,
  listClient,
  loadListColumns,
  loadRules,
  type RuleMatches,
  saveListColumns,
  saveRules,
} from './client';
import { GroupSection } from './GroupSection';
import { type ListSort, nextSort, orderBy, routeWithSort, sortOfRoute, usableSort } from './order';
import { SortMenu } from './SortMenu';

export interface ListPageProps {
  trackKey: string;
  client?: ListClient;
  search?: SearchClient;
}

const GROUP_LABELS: Record<GroupField | 'none', MessageId> = {
  none: 'list.group.none',
  status: 'list.group.status',
  assignee: 'list.group.assignee',
  priority: 'list.group.priority',
  type: 'list.group.type',
  targetRelease: 'list.group.targetRelease',
  labels: 'list.group.labels',
};
/** The track's List's own address, which holds its order: `#/tracks/SHOP/list?sort=key`. */
const NO_FIELDS: SearchField[] = [];
const isListRoute = (route: string, trackKey: string) =>
  new RegExp(`^#/tracks/${trackKey}/list/?(?:[?]|$)`).test(route);

/**
 * A group's heading: the value's name, with a type or a priority the workspace started with in
 * the person's language, as the search filters name them (NFR-006). Its query keeps the id.
 */
function groupName(t: Translate, field: GroupField, value: GroupValue): string {
  const name = value.name ?? value.id ?? '';
  if (field === 'type') return typeName(t, name);
  if (field === 'priority') return priorityName(t, name);
  return name;
}

const TONES: { id: Tone; label: MessageId }[] = [
  { id: 'red', label: 'list.tone.red' },
  { id: 'amber', label: 'list.tone.amber' },
  { id: 'green', label: 'list.tone.green' },
  { id: 'blue', label: 'list.tone.blue' },
];

/**
 * A track's list (M1-049; AGL-016): its tickets as a table in the person's columns (stacked rows
 * on a phone), filtered by a condition, sorted (by the menu or a column's heading, the order held in
 * the address; T-330), and grouped by a field with each group's count; cells edit in place
 * through the ticket route (as in search results), and tickets are made at the bottom.
 * Format rules colour rows or cells: each is a condition the server checks against the tickets
 * shown, as the person, and the rule's name stands beside the key so colour is never the only
 * sign. Columns and rules are kept per person and track in this browser; both open as the shared
 * pop-over (T-216). Titled "List" under the track's name (D26), with no link that repeats a tab (D7).
 */
export function ListPage({ trackKey, client = listClient, search = searchClient }: ListPageProps) {
  const t = useT();
  const id = useId();
  const [track, setTrack] = useState<{ id: number; key: string; name: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // The custom fields this person sees: null while they load.
  const [loadedFields, setFields] = useState<SearchField[] | null>(null);
  const fields = loadedFields ?? NO_FIELDS;
  const [group, setGroup] = useState<GroupField | 'none'>('none');
  // The address holds the order (T-330); replacing it tells no one, so the page keeps it as well.
  const [held, setSortHere] = useState<ListSort>(() => sortOfRoute(currentRoute()));
  // An address may order by a field this person cannot see: the default instead (T-330).
  const sort = usableSort(held, loadedFields);
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState('');
  const [columns, setColumns] = useState<string[]>(
    () => loadListColumns(trackKey) ?? [...DEFAULT_COLUMNS],
  );
  const [rules, setRules] = useState<FormatRule[]>(() => loadRules(trackKey));
  const [groups, setGroups] = useState<GroupValue[] | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [shown, setShown] = useState<Record<string, number[]>>({});
  const [matched, setMatched] = useState<RuleMatches>({ matches: {}, errors: {} });
  /** Bumped to read every section again (after a ticket is made). */
  const [version, setVersion] = useState(0);
  const nameOf = useColumnName(fields);

  useEffect(
    () =>
      onRouteChange(() => {
        const route = currentRoute();
        if (isListRoute(route, trackKey)) setSortHere(sortOfRoute(route));
      }),
    [trackKey],
  );
  const setSort = (next: ListSort) => {
    setSortHere(next);
    const route = currentRoute();
    if (isListRoute(route, trackKey)) replaceRoute(routeWithSort(route, next));
  };

  useEffect(() => {
    let live = true;
    client.track(trackKey).then(
      (found) => live && setTrack(found),
      () => live && setFailed(true),
    );
    search.fields().then(
      (f) => live && setFields(f),
      () => live && setFields([]),
    );
    return () => {
      live = false;
    };
  }, [client, search, trackKey]);

  const base = track
    ? `track = ${track.key}${filter.trim() ? ` AND (${filter.trim()})` : ''}`
    : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: counted again after a ticket is made
  useEffect(() => {
    if (!base || group === 'none') {
      setGroups(null);
      return;
    }
    let live = true;
    setGroups(null);
    setGroupsFailed(false);
    client.groups(base, group).then(
      (values) => live && setGroups(values),
      () => live && setGroupsFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, base, group, version]);

  // The tickets every section shows, for the rules to be checked against.
  const ids = useMemo(
    () => [...new Set(Object.values(shown).flat())].sort((a, b) => a - b),
    [shown],
  );
  const ruleKey = JSON.stringify(rules.map((r) => [r.id, r.query]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: rules change by their ids and queries
  useEffect(() => {
    if (rules.length === 0 || ids.length === 0) {
      setMatched({ matches: {}, errors: {} });
      return;
    }
    let live = true;
    client
      .formatRules(
        ids.slice(0, 500),
        rules.map((r) => ({ id: r.id, query: r.query })),
      )
      .then(
        (m) => live && setMatched(m),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [client, ids.join(','), ruleKey]);

  const format = useCallback(
    (ticket: SearchTicket): RowFormat | null => {
      const hit = rules.filter((r) => matched.matches[r.id]?.includes(ticket.id));
      if (hit.length === 0) return null;
      const row = hit.find((r) => r.target === 'row')?.tone ?? null;
      const cells: Record<string, Tone> = {};
      for (const r of hit) if (r.target !== 'row' && !(r.target in cells)) cells[r.target] = r.tone;
      return { row, cells, names: hit.map((r) => r.name) };
    },
    [rules, matched],
  );

  const onTickets = useCallback((key: string, tickets: SearchTicket[]) => {
    setShown((current) => ({ ...current, [key]: tickets.map((x) => x.id) }));
  }, []);

  const changeColumns = (next: string[]) => {
    setColumns(next);
    saveListColumns(trackKey, next);
  };
  const changeRules = (next: FormatRule[]) => {
    setRules(next);
    saveRules(trackKey, next);
  };

  if (failed) {
    return (
      <section className="page list-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('track.section.list')}
          purpose={t('purpose.list')}
        />
        <p className="board-problem" role="alert">
          {t('list.notFound')}
        </p>
      </section>
    );
  }
  if (!track || !base || !sort) return <p className="report-loading">{t('reports.loading')}</p>;

  const query = (clause: string | null) =>
    `${base}${clause ? ` AND ${clause}` : ''} ORDER BY ${orderBy(sort)}`;
  const section = (
    key: string,
    title: string | null,
    count: number | null,
    clause: string | null,
    other = false,
  ) => (
    <GroupSection
      // Not the order: a new order reads the rows again in the same table, so the heading clicked
      // keeps the focus (T-330).
      key={`${key}-${version}-${base}`}
      sectionKey={key}
      title={title}
      count={count}
      other={other}
      query={query(clause)}
      search={search}
      columns={columns}
      fields={fields}
      format={rules.length > 0 ? format : undefined}
      onTickets={onTickets}
      onSort={(column) => setSort(nextSort(sort, column))}
      momentsAsDays
    />
  );

  return (
    <section className="page list-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('track.section.list')}
        eyebrow={track.name}
        purpose={t('purpose.list')}
        about={t('about.list')}
      />
      <div className="list-tools">
        <label className="form-field">
          <span className="form-label">{t('list.groupBy')}</span>
          <select
            value={group}
            onChange={(event) => {
              setShown({});
              setGroup(event.target.value as GroupField | 'none');
            }}
          >
            {(['none', ...GROUP_FIELDS] as const).map((g) => (
              <option key={g} value={g}>
                {t(GROUP_LABELS[g])}
              </option>
            ))}
          </select>
        </label>
        <SortMenu sort={sort} nameOf={nameOf} onChange={setSort} />
        <form
          className="list-filter"
          onSubmit={(event) => {
            event.preventDefault();
            setShown({});
            setFilter(filterText);
          }}
        >
          <label className="form-field">
            <span className="form-label">{t('list.filter')}</span>
            <input
              type="text"
              value={filterText}
              placeholder={t('list.filterPlaceholder')}
              onChange={(event) => setFilterText(event.target.value)}
            />
          </label>
          <button type="submit" className="button-secondary">
            {t('list.filterApply')}
          </button>
        </form>
      </div>
      <div className="list-panels">
        <ColumnPicker columns={columns} fields={fields} onChange={changeColumns} />
        <Popover
          label={t('list.rules', { count: rules.length })}
          title={t('list.rules', { count: rules.length })}
          on={rules.length > 0}
        >
          <RulesPanel
            rules={rules}
            columns={columns}
            nameOf={nameOf}
            errors={matched.errors}
            onChange={changeRules}
          />
        </Popover>
      </div>
      {group === 'none' ? (
        section('all', null, null, null)
      ) : groupsFailed ? (
        <p className="board-problem" role="alert">
          {t('list.groupsFailed')}
        </p>
      ) : groups === null ? (
        <p className="report-loading">{t('reports.loading')}</p>
      ) : groups.length === 0 ? (
        <EmptyState title={t('list.empty')}>{t('empty.list.body')}</EmptyState>
      ) : (
        groups.map((g) =>
          section(
            `${group}:${g.kind}:${g.id ?? ''}`,
            g.kind === 'none'
              ? t('list.group.noValue')
              : g.kind === 'other'
                ? t('list.group.other')
                : groupName(t, group, g),
            g.total,
            groupClause(group, g),
            g.kind === 'other',
          ),
        )
      )}
      <AddTicket
        trackName={track.name}
        onAdd={async (summary) => {
          await client.createTicket(track.key, summary);
          setShown({});
          setVersion((v) => v + 1);
        }}
      />
    </section>
  );
}

/** The person's format rules for this track: add, change the tone, remove. */
function RulesPanel({
  rules,
  columns,
  nameOf,
  errors,
  onChange,
}: {
  rules: FormatRule[];
  columns: string[];
  nameOf: (column: string) => string;
  errors: Record<string, string>;
  onChange: (rules: FormatRule[]) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState('row');
  const [tone, setTone] = useState<Tone>('red');
  const toneName = (x: Tone) => t(TONES.find((o) => o.id === x)?.label ?? 'list.tone.red');
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click that removes its own rule is still inside, so it must not reach the page and close the pop-over; the keys are the controls' own
    <div className="list-rules" onClick={(event) => event.stopPropagation()}>
      <p className="board-hint">{t('list.rulesHint')}</p>
      {rules.length > 0 && (
        <ul className="list-rule-items">
          {rules.map((r) => (
            <li key={r.id} data-tone={r.tone}>
              <span className="format-mark">{r.name}</span>
              <code>{r.query}</code>
              <span className="board-meta">
                {t('list.ruleApplies', {
                  target: r.target === 'row' ? t('list.target.row') : nameOf(r.target),
                  tone: toneName(r.tone),
                })}
              </span>
              {errors[r.id] && (
                <span className="form-error" role="alert">
                  {t('list.ruleInvalid', { message: errors[r.id] ?? '' })}
                </span>
              )}
              <button
                type="button"
                className="button-secondary"
                aria-label={t('list.ruleRemove', { name: r.name })}
                onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
              >
                {t('list.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="list-rule-form"
        aria-label={t('list.ruleAdd')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !query.trim()) return;
          onChange([
            ...rules,
            {
              id: `r${Date.now().toString(36)}`,
              name: name.trim(),
              query: query.trim(),
              target,
              tone,
            },
          ]);
          setName('');
          setQuery('');
        }}
      >
        <label className="form-field">
          <span className="form-label">{t('list.ruleName')}</span>
          <input
            type="text"
            value={name}
            maxLength={40}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-field list-rule-query">
          <span className="form-label">{t('list.ruleQuery')}</span>
          <input
            type="text"
            value={query}
            required
            // i18n-ignore: an example in the query language, which is not translated.
            placeholder="due < now() AND stage != closed"
            aria-describedby={`${id}-query-hint`}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span className="form-label">{t('list.ruleTarget')}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="row">{t('list.target.row')}</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {nameOf(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span className="form-label">{t('list.ruleTone')}</span>
          <select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
            {TONES.map((o) => (
              <option key={o.id} value={o.id}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </label>
        <p id={`${id}-query-hint`} className="form-hint">
          {t('list.ruleQueryHint')}
        </p>
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {t('list.ruleAdd')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A ticket made at the end of the list from its summary (AGL-016 inline create). */
function AddTicket({
  trackName,
  onAdd,
}: {
  trackName: string;
  onAdd: (summary: string) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="backlog-create"
      onSubmit={(event) => {
        event.preventDefault();
        const text = summary.trim();
        if (!text) return;
        setBusy(true);
        setProblem(null);
        onAdd(text).then(
          () => {
            setBusy(false);
            setSummary('');
          },
          () => {
            setBusy(false);
            setProblem(t('sprints.create.ticketFailed'));
          },
        );
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        {t('list.addLabel', { name: trackName })}
      </label>
      <input
        id={id}
        type="text"
        value={summary}
        maxLength={255}
        placeholder={t('sprints.create.placeholder')}
        onChange={(event) => setSummary(event.target.value)}
      />
      <button type="submit" className="button-secondary" disabled={busy || !summary.trim()}>
        {t('sprints.create.ticket')}
      </button>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
