import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { ColumnPicker } from '../search/ColumnPicker';
import {
  type SearchClient,
  type SearchField,
  type SearchTicket,
  searchClient,
} from '../search/client';
import { DEFAULT_COLUMNS } from '../search/columns';
import { ResultTable, type RowFormat, type Tone } from '../search/ResultTable';
import { useColumnName } from '../search/useColumnName';
import { readShownPages, useTicketChanges } from '../tickets/view/ticketChanges';
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
const SORTS = {
  created: { order: 'created DESC', label: 'list.sort.created' },
  updated: { order: 'updated DESC', label: 'list.sort.updated' },
  due: { order: 'due ASC', label: 'list.sort.due' },
  priority: { order: 'priority DESC', label: 'list.sort.priority' },
} as const satisfies Record<string, { order: string; label: MessageId }>;
type Sort = keyof typeof SORTS;
const TONES: { id: Tone; label: MessageId }[] = [
  { id: 'red', label: 'list.tone.red' },
  { id: 'amber', label: 'list.tone.amber' },
  { id: 'green', label: 'list.tone.green' },
  { id: 'blue', label: 'list.tone.blue' },
];

/**
 * A track's list (M1-049; AGL-016): its tickets as a table in the person's columns, filtered by
 * a condition, sorted, and grouped by a field with each group's count; cells edit in place
 * through the ticket route (as in search results), and tickets are made at the bottom.
 * Format rules colour rows or cells: each is a condition the server checks against the tickets
 * shown, as the person, and the rule's name stands beside the key so colour is never the only
 * sign. Columns and rules are kept per person and track in this browser.
 */
export function ListPage({ trackKey, client = listClient, search = searchClient }: ListPageProps) {
  const t = useT();
  const id = useId();
  const [track, setTrack] = useState<{ id: number; key: string; name: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [fields, setFields] = useState<SearchField[]>([]);
  const [group, setGroup] = useState<GroupField | 'none'>('none');
  const [sort, setSort] = useState<Sort>('created');
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

  useEffect(() => {
    let live = true;
    client.track(trackKey).then(
      (found) => live && setTrack(found),
      () => live && setFailed(true),
    );
    search.fields().then(
      (f) => live && setFields(f),
      () => {},
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
      <section className="list-page">
        <p className="board-problem" role="alert">
          {t('list.notFound')}
        </p>
      </section>
    );
  }
  if (!track || !base) return <p className="report-empty">{t('reports.loading')}</p>;

  const query = (clause: string | null) =>
    `${base}${clause ? ` AND ${clause}` : ''} ORDER BY ${SORTS[sort].order}`;
  const section = (
    key: string,
    title: string | null,
    count: number | null,
    clause: string | null,
    other = false,
  ) => (
    <GroupSection
      key={`${key}-${version}-${sort}-${base}`}
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
    />
  );

  return (
    <section className="list-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {t('list.title', { name: track.name })}
        </h1>
        <a href={routeHref(`#/tracks/${encodeURIComponent(track.key)}`)}>
          {t('releases.toSummary')}
        </a>
      </div>
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
        <label className="form-field">
          <span className="form-label">{t('list.sortBy')}</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            {(Object.keys(SORTS) as Sort[]).map((s) => (
              <option key={s} value={s}>
                {t(SORTS[s].label)}
              </option>
            ))}
          </select>
        </label>
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
      <details className="list-panel">
        <summary>{t('list.columns')}</summary>
        <ColumnPicker columns={columns} fields={fields} onChange={changeColumns} />
      </details>
      <details className="list-panel" open={rules.length > 0 || undefined}>
        <summary>{t('list.rules', { count: rules.length })}</summary>
        <RulesPanel
          rules={rules}
          columns={columns}
          nameOf={nameOf}
          errors={matched.errors}
          onChange={changeRules}
        />
      </details>
      {group === 'none' ? (
        section('all', null, null, null)
      ) : groupsFailed ? (
        <p className="board-problem" role="alert">
          {t('list.groupsFailed')}
        </p>
      ) : groups === null ? (
        <p className="report-empty">{t('reports.loading')}</p>
      ) : groups.length === 0 ? (
        <p className="report-empty">{t('list.empty')}</p>
      ) : (
        groups.map((g) =>
          section(
            `${group}:${g.kind}:${g.id ?? ''}`,
            g.kind === 'none'
              ? t('list.group.noValue')
              : g.kind === 'other'
                ? t('list.group.other')
                : (g.name ?? g.id ?? ''),
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

/** A group's tickets (or all of them): fifty at a time, in the list's order. */
function GroupSection({
  sectionKey,
  title,
  count,
  other,
  query,
  search,
  columns,
  fields,
  format,
  onTickets,
}: {
  sectionKey: string;
  title: string | null;
  count: number | null;
  /** The rest gathered as other: counted, not listed. */
  other: boolean;
  query: string;
  search: SearchClient;
  columns: string[];
  fields: SearchField[];
  format: ((ticket: SearchTicket) => RowFormat | null) | undefined;
  onTickets: (key: string, tickets: SearchTicket[]) => void;
}) {
  const t = useT();
  const id = useId();
  const [tickets, setTickets] = useState<SearchTicket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'failed'>('loading');

  const load = useCallback(
    (after?: string) => {
      search.search(query, after).then(
        (page) => {
          setTickets((current) => {
            const next = after ? [...current, ...page.tickets] : page.tickets;
            onTickets(sectionKey, next);
            return next;
          });
          setCursor(page.next);
          setState('ready');
        },
        (error) =>
          setState(error instanceof ApiError && error.status === 400 ? 'invalid' : 'failed'),
      );
    },
    [search, query, sectionKey, onTickets],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per query (the key remounts it)
  useEffect(() => {
    if (!other) load();
  }, []);
  // An edit in the ticket pop-up over this list: the rows shown, read again where they stand.
  useTicketChanges(() => {
    if (other) return;
    readShownPages((after) => search.search(query, after), tickets.length).then(
      (page) => {
        setTickets(page.tickets);
        onTickets(sectionKey, page.tickets);
        setCursor(page.next);
      },
      () => {},
    );
  });

  const body =
    state === 'invalid' ? (
      <p className="board-problem" role="alert">
        {t('list.invalidFilter')}
      </p>
    ) : state === 'failed' ? (
      <p className="board-problem" role="alert">
        {t('list.failed')}
      </p>
    ) : state === 'loading' ? (
      <p className="report-empty">{t('reports.loading')}</p>
    ) : tickets.length === 0 ? (
      <p className="report-empty">{t('list.empty')}</p>
    ) : (
      <>
        <ResultTable
          tickets={tickets}
          columns={columns}
          fields={fields}
          client={search}
          {...(format ? { format } : {})}
          onSaved={(saved) =>
            setTickets((current) => current.map((x) => (x.id === saved.id ? saved : x)))
          }
        />
        {cursor && (
          <button type="button" className="button-secondary" onClick={() => load(cursor)}>
            {t('list.more')}
          </button>
        )}
      </>
    );
  if (title === null)
    return (
      <section className="list-group" aria-label={t('list.tickets')}>
        {body}
      </section>
    );
  return (
    <section className="list-group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('list.groupTitle', { name: title, count: count ?? 0 })}</h2>
      {other ? <p className="board-hint">{t('list.otherHint')}</p> : body}
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
    <div className="list-rules">
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
