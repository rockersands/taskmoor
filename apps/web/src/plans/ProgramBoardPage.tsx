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
import { type PlanView, planHref } from './address';
import type { PlanFilters } from './client';
import type { ViewScenario } from './PlanSummaryPage';
import {
  type BoardCell,
  type CardChange,
  type CardMoved,
  cardChange,
  type Place,
  type ProgramBoard,
  type ProgramBoardCard,
  type ProgramBoardClient,
  programBoardClient,
} from './programBoardClient';
import { draftRefusalCode, type ScenarioClient } from './scenarioClient';

export interface ProgramBoardPageProps {
  planId: number;
  boardId: number;
  filters: PlanFilters;
  /** The plan's view in the address, carried back to the list of boards. */
  view?: PlanView;
  client?: ProgramBoardClient;
  /** Today, for the period marked "Now". */
  now?: () => Date;
  /**
   * The scenario the board reads (ADR-122 stage 6): cards stand where its drafts put them, and a
   * move is a draft in it, never the ticket's own change.
   */
  scenario?: ViewScenario;
  scenarios?: ScenarioClient;
  /** A draft was written: the scenario's counts are read again. */
  onDrafted?: () => void;
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
  // A draft in a scenario (ADR-122 stage 6).
  start_after_due: 'programBoard.refused.order',
  too_many_drafts: 'programBoard.refused.tooManyDrafts',
  not_a_team_field: 'programBoard.refused.invalid',
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

/**
 * The board with one card moved at once, before the server answers: taken from wherever it now
 * stands (someone else may have moved it since the Move dialog opened) and put in its new cell, if
 * the board still lists it.
 */
function movedLocally(board: ProgramBoard, id: number, to: Place): ProgramBoard {
  const listed = board.cards.some((c) => c.id === id);
  const take = (cell: BoardCell): BoardCell =>
    cell.cards.includes(id)
      ? { ...cell, count: Math.max(0, cell.count - 1), cards: cell.cards.filter((x) => x !== id) }
      : cell;
  const put = (cell: BoardCell): BoardCell => ({
    ...cell,
    count: cell.count + 1,
    cards: [...cell.cards, id],
  });
  const rows = board.rows.map((row) => {
    const here = listed && (row.team?.id ?? null) === to.team;
    const unscheduled = take(row.unscheduled);
    const cells = row.cells.map(take);
    return {
      ...row,
      unscheduled: here && to.column === 0 ? put(unscheduled) : unscheduled,
      cells: cells.map((c, i) => (here && to.column === i + 1 ? put(c) : c)),
    };
  });
  return { ...board, rows };
}

/** The board with a moved card's version and days as the ticket route answered them. */
function withTicket(
  board: ProgramBoard,
  id: number,
  ticket: { version: number; start?: string | null; due?: string | null },
): ProgramBoard {
  return {
    ...board,
    cards: board.cards.map((c) =>
      c.id === id
        ? {
            ...c,
            version: ticket.version,
            ...(ticket.start !== undefined ? { start: ticket.start } : {}),
            ...(ticket.due !== undefined ? { due: ticket.due } : {}),
          }
        : c,
    ),
  };
}

/**
 * One program board of a plan (T-089d; PLN-008; ADR-122 stage 5): its teams as rows and the plan's
 * periods as columns, after Not scheduled, each cell holding its first 20 cards (outcomes first)
 * and a link to the search for all of them. A card moves by dragging it to a cell, or by its Move
 * button (the keyboard's, a screen reader's and a phone's way); either sends the ticket's own
 * change with the version read, so a card someone else moved meanwhile is refused and shown where
 * it now is. Changes made elsewhere arrive through the local copy (ADR-013): the board reads again
 * within 30 ms of it moving; while a card is held or a move waits it reads once they are done. A
 * read already on its way when a card moves is dropped, so it cannot put the card back. The Move
 * dialog moves the card from where it stood when it opened, with the version read then, so a card
 * moved meanwhile is refused, never moved from somewhere the person did not see. On a phone it shows one
 * team at a time, each period a list. Its dependencies are badges on the cards and a list below,
 * the blockers it does not show only counted.
 */
export function ProgramBoardPage({
  planId,
  boardId,
  filters,
  view,
  client = programBoardClient,
  now = () => new Date(),
  scenario,
  scenarios,
  onDrafted,
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
  // The card in the Move dialog, and where it stood when the dialog opened.
  const [moving, setMoving] = useState<{ card: ProgramBoardCard; from: Place } | null>(null);
  const [phoneRow, setPhoneRow] = useState(0);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const idle = dragging === null && pending.size === 0;
  busy.current = !idle;
  // A read put off while a card was held or a move waited, made once they are done.
  const missed = useRef(false);
  // The card a move from the dialog left focus on, and the one to find again after a read moves it.
  const following = useRef<string | null>(null);
  const refocus = useRef<string | null>(null);
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the filters by their text
  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++generation.current;
      client.read(planId, boardId, filters, scenario?.id).then(
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
    [client, planId, boardId, filterKey, scenario?.id],
  );
  useEffect(() => load(false), [load]);
  // Reads again now, or once nothing holds the board: a read made while a card is held or a move
  // waits would put the card back where the server last had it.
  const readSoon = useCallback(() => {
    if (busy.current) missed.current = true;
    else load(true);
  }, [load]);
  useEffect(() => {
    if (!idle || !missed.current) return;
    missed.current = false;
    load(true);
  }, [idle, load]);

  // Moves made elsewhere reach the local copy through the socket: read again, at most once in
  // 30 ms, and after a held card or a waiting move (whose own answer reads again too).
  const engine = useSyncEngine();
  // Drafts are not in the change log, so in a scenario the board reads again every 15 s while
  // open, to show others' drafts (ADR-122 stage 6).
  const inScenario = scenario !== undefined;
  useEffect(() => {
    if (!inScenario) return;
    const timer = setInterval(readSoon, POLL_MS);
    return () => clearInterval(timer);
  }, [inScenario, readSoon]);
  useEffect(() => {
    if (!engine) {
      if (inScenario) return;
      const timer = setInterval(readSoon, POLL_MS);
      return () => clearInterval(timer);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        readSoon();
      }, SETTLE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, readSoon, inScenario]);
  useTicketChanges(readSoon);

  /** Focus on a card's link where it now stands, or on the board's name when it is not shown. */
  const focusCard = useCallback((key: string) => {
    const shown = [...(page.current?.querySelectorAll<HTMLElement>('li[data-card]') ?? [])].find(
      (li) => li.dataset.card === key,
    );
    (shown?.querySelector<HTMLElement>('a') ?? heading.current)?.focus();
  }, []);
  // A refused move from the dialog: the read puts the card back, in a list of its own, and focus
  // that was on it would fall to the page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each read
  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    if (!document.activeElement || document.activeElement === document.body) focusCard(key);
  }, [data, focusCard]);

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

  const move = async (card: ProgramBoardCard, from: Place, to: Place) => {
    const change = cardChange(card, from, to, board.periods, teamField?.id ?? null);
    if (!change) return;
    // A read already on its way began before this move: its answer would put the card back.
    generation.current++;
    missed.current = true;
    setPending((set) => new Set(set).add(card.id));
    setData((current) => (current ? movedLocally(current, card.id, to) : current));
    setStatus(t('programBoard.moving', { key: card.key }));
    const result: CardMoved =
      scenario && scenarios
        ? await draftMove(card, change)
        : await client
            .move(card.key, change)
            .catch((): Refusal => ({ ok: false, code: 'unreachable' }));
    // The next move of this card sends the version this one made, before the board reads again.
    if (result.ok && result.ticket) {
      const ticket = result.ticket;
      setData((current) => (current ? withTicket(current, card.id, ticket) : current));
    }
    // The board reads again once no other move waits and no card is held (`missed` above).
    missed.current = true;
    if (following.current === card.key) {
      following.current = null;
      if (!result.ok) refocus.current = card.key;
    }
    setPending((set) => {
      const next = new Set(set);
      next.delete(card.id);
      return next;
    });
    setStatus(
      result.ok
        ? scenario
          ? t('programBoard.drafted', {
              key: card.key,
              place: placeText(to),
              scenario: scenario.name,
            })
          : t('programBoard.moved', { key: card.key, place: placeText(to) })
        : t(
            result.code === 'forbidden' && result.locked
              ? 'programBoard.refused.locked'
              : result.code === 'forbidden' && result.permission === 'edit_plan'
                ? 'programBoard.refused.notEditor'
                : (REFUSALS[result.code] ?? 'programBoard.refused.other'),
            { key: card.key, field: teamField?.name ?? '' },
          ),
    );
  };

  /** A move in a scenario: the Team value and days as a draft, without the version (stage 6). */
  const draftMove = async (card: ProgramBoardCard, change: CardChange): Promise<CardMoved> => {
    if (!scenario || !scenarios) return { ok: false, code: 'unreachable' };
    const { version: _read, ...drafted } = change;
    const written = await scenarios
      .draft(planId, scenario.id, [{ ticketId: card.id, ...drafted }])
      .catch(() => null);
    if (!written) return { ok: false, code: 'unreachable' };
    if (!written.ok) {
      return {
        ok: false,
        code: draftRefusalCode(written),
        ...(written.permission ? { permission: written.permission } : {}),
      };
    }
    onDrafted?.();
    return { ok: true };
  };

  // After a move from the dialog its Move button is gone (the card is in another cell and moving),
  // so focus goes to the card where it now stands, or to the board's name when it left the view;
  // after a refusal, to the card where the board's next read puts it.
  const focusAfter = (key: string) => (opener: HTMLElement | null) => {
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    following.current = key;
    focusCard(key);
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
        {card.draft && (
          <p className="program-card-meta">
            <span className="draft-tag">{t('draft.tag')}</span>
            {card.draft.stale && ` ${t('draft.staleShort')}`}
          </p>
        )}
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
            onClick={() => {
              const from = places.get(card.id);
              if (from) setMoving({ card, from });
            }}
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
      {/* A cell a draft moves a card into or out of finds no search: said, not linked. */}
      {cell.drafts ? (
        <p className="program-cell-drafts">
          {cell.count > cell.cards.length
            ? t('programBoard.moreWithDrafts', { count: cell.count - cell.cards.length })
            : t('programBoard.withDrafts')}
        </p>
      ) : (
        cell.count > cell.cards.length &&
        board.query !== null && (
          <a className="program-cell-more" href={searchHref(cellSearch(row, column))}>
            {t('programBoard.more', { count: cell.count - cell.cards.length })}
          </a>
        )
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
        const from = card ? places.get(card.id) : undefined;
        if (card && from && movable(card)) void move(card, from, to);
      },
    };
  };

  const phone = board.rows[Math.min(phoneRow, board.rows.length - 1)] ?? board.rows[0];

  return (
    <div className="program-board-page" ref={page}>
      <div className="program-board-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {board.board.name}
        </h2>
        <a className="button-secondary" href={routeHref(planHref(planId, 'boards', view))}>
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
                        aria-label={`${rowName(row)}, ${column.label}, ${t('programBoard.count', { count: cell.count })}${cell.drafts ? `, ${t('programBoard.withDrafts')}` : ''}`}
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
          card={moving.card}
          from={moving.from}
          rows={board.rows.map((row) => ({ team: row.team?.id ?? null, name: rowName(row) }))}
          columns={columns.map((c) => c.label)}
          teamMovable={teamField !== null}
          drafting={scenario !== undefined}
          onMove={(to) => {
            const { card, from } = moving;
            setMoving(null);
            void move(card, from, to);
          }}
          onClose={() => setMoving(null)}
          restoreFocus={focusAfter(moving.card.key)}
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
  /** In a scenario the move is a draft, and the button says so. */
  drafting?: boolean;
  onMove: (to: Place) => void;
  onClose: () => void;
  /** Where focus goes when the dialog closes; back to its opener by default. */
  restoreFocus?: (opener: HTMLElement | null) => void;
}

/** Moving one card by its team and period: the way for the keyboard, screen readers and phones. */
export function MoveDialog({
  card,
  from,
  rows,
  columns,
  teamMovable,
  drafting = false,
  onMove,
  onClose,
  restoreFocus,
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
      {...(restoreFocus ? { restoreFocus } : {})}
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
            {t(drafting ? 'programBoard.moveDraft' : 'programBoard.moveSave')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('programBoard.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
