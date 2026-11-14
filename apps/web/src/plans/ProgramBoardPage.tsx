import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { searchHref } from '../releases/client';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import { NotFoundPage } from '../shell/NotFoundPage';
import { typeName } from '../shell/seededNames';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { useSyncEngine } from '../sync/SyncProvider';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import type { Refusal, TimelineItem } from '../timeline/client';
import { localDay } from '../timeline/client';
import { DependencyList } from '../timeline/DependencyList';
import { type Blocked, blockerCount, dependenciesOf } from '../timeline/dependencies';
import { planHref } from './address';
import type { PlanFilters } from './client';
import {
  type BoardCell,
  cardChange,
  type Place,
  type ProgramBoard,
  type ProgramBoardCard,
  type ProgramBoardClient,
  programBoardClient,
} from './programBoardClient';

export interface ProgramBoardPageProps {
  planId: number;
  boardId: number;
  filters: PlanFilters;
  client?: ProgramBoardClient;
  /** Today, for the period marked "Now". */
  now?: () => Date;
}

/**
 * How long the page waits after the local copy moves before it reads again (ms): enough to take a
 * burst of changes as one read, short enough that another person's move shows within a second.
 */
const SETTLE_MS = 30;
/** Without a local copy (storage refused), how often the board reads again while open (ms). */
const POLL_MS = 15_000;

const REFUSALS: Record<string, MessageId> = {
  forbidden: 'programBoard.refused.forbidden',
  '403': 'programBoard.refused.forbidden',
  track_archived: 'programBoard.refused.archived',
  not_found: 'programBoard.refused.gone',
  '404': 'programBoard.refused.gone',
  invalid_fields: 'programBoard.refused.invalid',
  invalid_request: 'programBoard.refused.invalid',
  version_conflict: 'programBoard.conflict',
  '409': 'programBoard.conflict',
  unreachable: 'programBoard.unreachable',
};

/** A card as the dependency helpers read a ticket: its own days, no roll-up. */
const asItem = (card: ProgramBoardCard): TimelineItem => ({
  id: card.id,
  key: card.key,
  summary: card.summary,
  type: card.type,
  level: card.level,
  parentId: null,
  status: card.status,
  start: card.start,
  due: card.due,
  dated: card.start !== null || card.due !== null ? 'own' : null,
  rollup: null,
});

/** Where each card stands on the board, by its id. */
function placesOf(board: ProgramBoard): Map<number, Place> {
  const out = new Map<number, Place>();
  for (const row of board.rows) {
    const team = row.team?.id ?? null;
    for (const id of row.unscheduled.cards) out.set(id, { team, column: 0 });
    row.cells.forEach((cell, i) => {
      for (const id of cell.cards) out.set(id, { team, column: i + 1 });
    });
  }
  return out;
}

/** The board with one card moved at once, before the server answers. */
function movedLocally(board: ProgramBoard, id: number, from: Place, to: Place): ProgramBoard {
  const cellOf = (row: ProgramBoard['rows'][number], column: number) =>
    column === 0 ? row.unscheduled : (row.cells[column - 1] as BoardCell);
  const rows = board.rows.map((row) => {
    const team = row.team?.id ?? null;
    const copy = {
      ...row,
      unscheduled: { ...row.unscheduled, cards: [...row.unscheduled.cards] },
      cells: row.cells.map((c) => ({ ...c, cards: [...c.cards] })),
    };
    if (team === from.team) {
      const cell = cellOf(copy, from.column);
      cell.cards = cell.cards.filter((x) => x !== id);
      cell.count = Math.max(0, cell.count - 1);
    }
    if (team === to.team) {
      const cell = cellOf(copy, to.column);
      cell.cards.push(id);
      cell.count += 1;
    }
    return copy;
  });
  return { ...board, rows };
}

/**
 * One program board of a plan (T-089d; PLN-008; ADR-122 stage 5): its teams as rows and the plan's
 * periods as columns, after Not scheduled, each cell holding its first 20 cards (outcomes first)
 * and a link to the search for all of them. A card moves by dragging it to a cell, or by its Move
 * button (the keyboard's, a screen reader's and a phone's way); either sends the ticket's own
 * change with the version read, so a card someone else moved meanwhile is refused and shown where
 * it now is. Changes made elsewhere arrive through the local copy (ADR-013): the board reads again
 * within 30 ms of it moving, not while a card is held or a move waits. On a phone it shows one
 * team at a time, each period a list. Its dependencies are badges on the cards and a list below,
 * the blockers it does not show only counted.
 */
export function ProgramBoardPage({
  planId,
  boardId,
  filters,
  client = programBoardClient,
  now = () => new Date(),
}: ProgramBoardPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [data, setData] = useState<ProgramBoard | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<ProgramBoardCard | null>(null);
  const [phoneRow, setPhoneRow] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  busy.current = dragging !== null || pending.size > 0;
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the filters by their text
  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++generation.current;
      client.read(planId, boardId, filters).then(
        (board) => {
          if (mine !== generation.current) return;
          setData(board);
          setState('ready');
        },
        (error: { status?: number }) => {
          if (mine !== generation.current) return;
          if (error?.status === 404) setState('missing');
          else if (!quiet) setState('failed');
        },
      );
    },
    [client, planId, boardId, filterKey],
  );
  useEffect(() => load(false), [load]);

  // Moves made elsewhere reach the local copy through the socket: read again, at most once in
  // 30 ms, and not while a card is held or a move waits (its own answer reads again).
  const engine = useSyncEngine();
  useEffect(() => {
    if (!engine) {
      const timer = setInterval(() => {
        if (!busy.current) load(true);
      }, POLL_MS);
      return () => clearInterval(timer);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!busy.current) load(true);
      }, SETTLE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, load]);
  useTicketChanges(() => {
    if (!busy.current) load(true);
  });

  const cards = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data]);
  const places = useMemo(() => (data ? placesOf(data) : new Map<number, Place>()), [data]);
  const dependencies = useMemo(
    () =>
      data
        ? dependenciesOf(data.cards.map(asItem), data.links, data.blockersElsewhere)
        : new Map<number, Blocked>(),
    [data],
  );

  if (state === 'missing') {
    return (
      <NotFoundPage title={t('notFound.programBoard')}>{t('programBoard.notFound')}</NotFoundPage>
    );
  }
  if (state === 'failed' && !data) {
    return (
      <p className="board-problem" role="alert">
        {t('programBoard.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  const board = data;
  const archived = board.board.archived;
  const teamField = board.board.teamField;
  const today = localDay(now());
  const dayText = (day: string) =>
    intl.formatDate(new Date(`${day}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const columns = [
    { label: t('programBoard.unscheduled'), clause: board.unscheduledClause, current: false },
    ...board.periods.map((p) => ({
      label: t('programBoard.period', { start: dayText(p.start), end: dayText(p.end) }),
      clause: p.clause,
      current: p.start <= today && today <= p.end,
    })),
  ];
  const rowName = (row: ProgramBoard['rows'][number]) =>
    row.team?.name ?? (teamField ? t('programBoard.otherTeam') : t('programBoard.allTeams'));
  const cellSearch = (row: ProgramBoard['rows'][number], column: number) =>
    [`(${board.query})`, board.clause, row.clause, columns[column]?.clause]
      .filter(Boolean)
      .join(' AND ');
  const placeText = (place: Place) => {
    const row = board.rows.find((r) => (r.team?.id ?? null) === place.team);
    return t('programBoard.place', {
      team: row ? rowName(row) : '',
      period: columns[place.column]?.label ?? '',
    });
  };

  const move = async (card: ProgramBoardCard, to: Place) => {
    const from = places.get(card.id);
    if (!from) return;
    const change = cardChange(card, from, to, board.periods, teamField?.id ?? null);
    if (!change) return;
    setPending((set) => new Set(set).add(card.id));
    setData((current) => (current ? movedLocally(current, card.id, from, to) : current));
    setStatus(t('programBoard.moving', { key: card.key }));
    const result = await client
      .move(card.key, change)
      .catch((): Refusal => ({ ok: false, code: 'unreachable' }));
    setPending((set) => {
      const next = new Set(set);
      next.delete(card.id);
      return next;
    });
    setStatus(
      result.ok
        ? t('programBoard.moved', { key: card.key, place: placeText(to) })
        : t(
            result.code === 'forbidden' && result.locked
              ? 'programBoard.refused.locked'
              : (REFUSALS[result.code] ?? 'programBoard.refused.other'),
            { key: card.key, field: teamField?.name ?? '' },
          ),
    );
    load(true);
  };

  const movable = (card: ProgramBoardCard) =>
    !archived && card.status.stage !== 'closed' && !pending.has(card.id);

  const badge = (card: ProgramBoardCard) => {
    const blocked = dependencies.get(card.id);
    if (!blocked) return null;
    const text =
      blocked.sameSprint > 0
        ? t('timeline.badge.withSprint', {
            count: blockerCount(blocked),
            late: blocked.late,
            sprint: blocked.sameSprint,
          })
        : t('timeline.badge', { count: blockerCount(blocked), late: blocked.late });
    return (
      <p
        className={`program-card-badge${blocked.late > 0 ? ' is-late' : ''}${blocked.sameSprint > 0 ? ' is-same-sprint' : ''}`}
      >
        {text}
      </p>
    );
  };

  const cardView = (cardId: number, row: ProgramBoard['rows'][number]) => {
    const card = cards.get(cardId);
    if (!card) return null;
    const closed = card.status.stage === 'closed';
    return (
      <li
        key={card.id}
        className={`program-card${card.level.rank > 0 ? ' is-outcome' : ''}${closed ? ' is-closed' : ''}${pending.has(card.id) ? ' is-pending' : ''}`}
        data-card={card.key}
        draggable={!compact && movable(card)}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', String(card.id));
          event.dataTransfer.effectAllowed = 'move';
          setDragging(card.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
      >
        <p className="program-card-title">
          <a href={routeHref(`#/tickets/${encodeURIComponent(card.key)}`)}>
            <span className="program-card-key">{card.key}</span>{' '}
            <span className="program-card-summary">{card.summary}</span>
          </a>
        </p>
        <p className="program-card-meta">
          {typeName(t, card.type)} · {card.status.name}
          {closed && ` · ${t('programBoard.closed')}`}
        </p>
        {row.team === null && card.team && (
          <p className="program-card-meta">
            {t('programBoard.cardTeam', { name: card.team.name })}
          </p>
        )}
        {badge(card)}
        {pending.has(card.id) && (
          <p className="program-card-meta">{t('programBoard.cardMoving')}</p>
        )}
        {movable(card) && (
          <button
            type="button"
            className="button-secondary program-card-move"
            aria-label={t('programBoard.moveCard', { key: card.key })}
            onClick={() => setMoving(card)}
          >
            {t('programBoard.move')}
          </button>
        )}
      </li>
    );
  };

  const cellBody = (row: ProgramBoard['rows'][number], cell: BoardCell, column: number) => (
    <>
      {cell.cards.length > 0 && (
        <ul className="program-cell-cards">{cell.cards.map((c) => cardView(c, row))}</ul>
      )}
      {cell.count > cell.cards.length && board.query !== null && (
        <a className="program-cell-more" href={searchHref(cellSearch(row, column))}>
          {t('programBoard.more', { count: cell.count - cell.cards.length })}
        </a>
      )}
    </>
  );

  const cellOf = (row: ProgramBoard['rows'][number], column: number) =>
    column === 0 ? row.unscheduled : (row.cells[column - 1] as BoardCell);

  const dropProps = (row: ProgramBoard['rows'][number], column: number) => {
    const key = `${row.team?.id ?? 'none'}:${column}`;
    const to: Place = { team: row.team?.id ?? null, column };
    return {
      'data-cell': key,
      className: `program-cell${over === key ? ' is-drop-target' : ''}${columns[column]?.current ? ' is-current' : ''}`,
      onDragOver: (event: React.DragEvent) => {
        if (dragging === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (over !== key) setOver(key);
      },
      onDragLeave: () => setOver((k) => (k === key ? null : k)),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        const dropped = Number(event.dataTransfer.getData('text/plain')) || dragging;
        setDragging(null);
        setOver(null);
        const card = dropped === null ? undefined : cards.get(dropped);
        if (card && movable(card)) void move(card, to);
      },
    };
  };

  const phone = board.rows[Math.min(phoneRow, board.rows.length - 1)] ?? board.rows[0];

  return (
    <div className="program-board-page">
      <div className="program-board-head">
        <h2 id={`${id}-title`}>{board.board.name}</h2>
        <a className="button-secondary" href={routeHref(planHref(planId, 'boards'))}>
          {t('programBoard.all')}
        </a>
      </div>
      <p className="board-hint">
        {teamField
          ? t('programBoard.facts', {
              field: teamField.name,
              count: board.periods.length,
              from: dayText(board.periods[0]?.start ?? board.board.from),
            })
          : t('programBoard.noField')}
      </p>
      {archived && <p className="plan-notices">{t('programBoard.archivedNote')}</p>}
      {board.query === null && <p className="board-hint">{t('programBoard.nothing')}</p>}
      <p className="board-hint">{compact ? t('programBoard.hintPhone') : t('programBoard.hint')}</p>
      <p className="board-hint program-board-status" role="status">
        {status}
      </p>
      {compact ? (
        <section className="program-board-phone" aria-labelledby={`${id}-title`}>
          {board.rows.length > 1 && (
            <label className="form-field" htmlFor={`${id}-team`}>
              <span className="form-label">{t('programBoard.team')}</span>
              <select
                id={`${id}-team`}
                value={phoneRow}
                onChange={(event) => setPhoneRow(Number(event.target.value))}
              >
                {board.rows.map((row, i) => (
                  <option key={row.team?.id ?? 'none'} value={i}>
                    {rowName(row)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {phone &&
            columns.map((column, i) => {
              const cell = cellOf(phone, i);
              return (
                <section
                  key={column.label}
                  className="glass-card program-phone-period"
                  aria-label={`${rowName(phone)}, ${column.label}`}
                >
                  <h3>
                    {column.label}
                    {column.current && ` · ${t('programBoard.now')}`}{' '}
                    <span className="program-cell-count">
                      {t('programBoard.count', { count: cell.count })}
                    </span>
                  </h3>
                  {cell.count === 0 ? (
                    <EmptyState compact title={t('programBoard.empty')} />
                  ) : (
                    cellBody(phone, cell, i)
                  )}
                </section>
              );
            })}
        </section>
      ) : (
        <div className="program-board-scroll">
          <table className="program-board" aria-labelledby={`${id}-title`}>
            <thead>
              <tr>
                <th scope="col">{t('programBoard.team')}</th>
                {columns.map((column) => (
                  <th
                    key={column.label}
                    scope="col"
                    className={column.current ? 'is-current' : undefined}
                  >
                    {column.label}
                    {column.current && (
                      <span className="program-now"> · {t('programBoard.now')}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row) => (
                <tr key={row.team?.id ?? 'none'}>
                  <th scope="row">{rowName(row)}</th>
                  {columns.map((column, i) => {
                    const cell = cellOf(row, i);
                    return (
                      <td
                        key={column.label}
                        {...dropProps(row, i)}
                        aria-label={`${rowName(row)}, ${column.label}, ${t('programBoard.count', { count: cell.count })}`}
                      >
                        {cellBody(row, cell, i)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DependencyList
        dependencies={dependencies}
        headingId={`${id}-dependencies`}
        linkTypes={board.linkTypes}
      />
      {moving && (
        <MoveDialog
          card={moving}
          from={places.get(moving.id) ?? { team: null, column: 0 }}
          rows={board.rows.map((row) => ({ team: row.team?.id ?? null, name: rowName(row) }))}
          columns={columns.map((c) => c.label)}
          teamMovable={teamField !== null}
          onMove={(to) => {
            const card = moving;
            setMoving(null);
            void move(card, to);
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

export interface MoveDialogProps {
  card: Pick<ProgramBoardCard, 'key' | 'summary'>;
  from: Place;
  rows: { team: number | null; name: string }[];
  columns: string[];
  /** False without a Team field: only the period changes. */
  teamMovable: boolean;
  onMove: (to: Place) => void;
  onClose: () => void;
}

/** Moving one card by its team and period: the way for the keyboard, screen readers and phones. */
export function MoveDialog({
  card,
  from,
  rows,
  columns,
  teamMovable,
  onMove,
  onClose,
}: MoveDialogProps) {
  const t = useT();
  const id = useId();
  const [team, setTeam] = useState(String(from.team ?? 'none'));
  const [column, setColumn] = useState(from.column);
  const to: Place = { team: team === 'none' ? null : Number(team), column };
  const same = to.team === from.team && to.column === from.column;
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('programBoard.cancel')}
      focusFirstField
      className="program-move-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!same) onMove(to);
        }}
      >
        <h2 id={`${id}-title`}>{t('programBoard.moveTitle', { key: card.key })}</h2>
        <p className="board-hint">{card.summary}</p>
        {teamMovable && (
          <label className="form-field" htmlFor={`${id}-team`}>
            <span className="form-label">{t('programBoard.team')}</span>
            <select
              id={`${id}-team`}
              value={team}
              onChange={(event) => setTeam(event.target.value)}
            >
              {rows.map((row) => (
                <option key={row.team ?? 'none'} value={String(row.team ?? 'none')}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="form-field" htmlFor={`${id}-period`}>
          <span className="form-label">{t('programBoard.periodLabel')}</span>
          <select
            id={`${id}-period`}
            value={column}
            onChange={(event) => setColumn(Number(event.target.value))}
          >
            {columns.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="board-hint">{t('programBoard.moveHint')}</p>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={same}>
            {t('programBoard.moveSave')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('programBoard.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
