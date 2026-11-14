import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import {
  type GroupValue,
  groupClause,
  type ListClient,
  loadListColumns,
  saveListColumns,
} from '../list/client';
import { GroupSection } from '../list/GroupSection';
import { ColumnPicker } from '../search/ColumnPicker';
import type { SearchClient, SearchField, SearchTicket } from '../search/client';
import { DEFAULT_COLUMNS } from '../search/columns';
import { EmptyState } from '../shell/EmptyState';
import type { PlanGroup } from './address';
import { DownloadMenu } from './DownloadMenu';
import type { PlanSectionProps } from './PlanSummaryPage';

/** How many rows the List shows of a plan, or of one of its groups (PLN-012). */
const ROWS = 10_000;
const SORTS = {
  created: { order: 'created DESC', label: 'list.sort.created' },
  updated: { order: 'updated DESC', label: 'list.sort.updated' },
  due: { order: 'due ASC', label: 'list.sort.due' },
  priority: { order: 'priority DESC', label: 'list.sort.priority' },
} as const satisfies Record<string, { order: string; label: MessageId }>;
type Sort = keyof typeof SORTS;

/**
 * A plan's List (PLN-012): the search with the plan's query, as the person may see it, in their
 * columns and sorted, grouped by track, assignee, status, type or priority with each group's
 * count; cells edit in place through the ticket route, as in search results. Each group, or the
 * whole list, stops at 10,000 rows and says so. Columns are kept per person and plan in this
 * browser; the order is in the address, so a link holds it. Its file (PLN-014) comes from the
 * server and holds every ticket of the plan the person sees, in these columns and this order.
 */
export function PlanListPage({
  id,
  plan,
  filters,
  client,
  group,
  search,
  list,
  position,
  onPosition,
  scenario,
}: PlanSectionProps & { group: PlanGroup | null; search: SearchClient; list: ListClient }) {
  const t = useT();
  const store = `plan-${id}`;
  const [fields, setFields] = useState<SearchField[]>([]);
  const [sortHere, setSortHere] = useState<Sort>('created');
  const sort = position?.sort ?? sortHere;
  const setSort = (next: Sort) => {
    setSortHere(next);
    onPosition?.({ sort: next === 'created' ? undefined : next });
  };
  const [columns, setColumns] = useState<string[]>(
    () => loadListColumns(store) ?? [...DEFAULT_COLUMNS],
  );
  const [groups, setGroups] = useState<GroupValue[] | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const base = plan.query;

  useEffect(() => {
    let live = true;
    search.fields().then(
      (f) => live && setFields(f),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [search]);

  useEffect(() => {
    if (!base || !group) {
      setGroups(null);
      return;
    }
    let live = true;
    setGroups(null);
    setGroupsFailed(false);
    list.groups(base, group).then(
      (values) => live && setGroups(values),
      () => live && setGroupsFailed(true),
    );
    return () => {
      live = false;
    };
  }, [list, base, group]);

  const onTickets = useCallback((_key: string, _tickets: SearchTicket[]) => {}, []);

  if (!base) return null;

  const query = (clause: string | null) =>
    `${clause ? `(${base}) AND ${clause}` : base} ORDER BY ${SORTS[sort].order}`;
  const cap = { rows: ROWS, text: t('plans.list.capped', { count: ROWS }) };
  const section = (
    key: string,
    title: string | null,
    count: number | null,
    clause: string | null,
    other = false,
  ) => (
    <GroupSection
      key={`${key}-${sort}-${base}`}
      sectionKey={key}
      title={title}
      count={count}
      other={other}
      query={query(clause)}
      search={search}
      columns={columns}
      fields={fields}
      format={undefined}
      onTickets={onTickets}
      cap={cap}
      emptyBody={t('empty.planTickets.body')}
      // In a scenario no edit here may change a ticket (ADR-122 stage 6): the List stays live.
      readOnly={scenario !== undefined}
    />
  );

  return (
    <div className="list-page plan-list">
      {scenario && <p className="board-hint scenario-live-note">{t('plans.list.live')}</p>}
      <div className="list-tools">
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
        <DownloadMenu
          items={[
            {
              key: 'csv',
              label: t('plans.download.csv'),
              href: client.exportHref(id, { filters, columns, sort }),
            },
          ]}
          notes={[t('plans.download.everyTicket')]}
        />
        <ColumnPicker
          columns={columns}
          fields={fields}
          onChange={(next) => {
            setColumns(next);
            saveListColumns(store, next);
          }}
        />
      </div>
      {!group ? (
        section('all', null, null, null)
      ) : groupsFailed ? (
        <p className="board-problem" role="alert">
          {t('list.groupsFailed')}
        </p>
      ) : groups === null ? (
        <p className="report-loading">{t('reports.loading')}</p>
      ) : groups.length === 0 ? (
        <EmptyState title={t('list.empty')}>{t('empty.planTickets.body')}</EmptyState>
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
    </div>
  );
}
