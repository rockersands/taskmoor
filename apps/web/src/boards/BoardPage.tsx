import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { type Lock, useLockText } from '../locks/useLockText';
import { rememberBoard } from '../routing/cameFrom';
import { currentRoute, onRouteChange, replaceRoute, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { BoardsIcon, ClockIcon, MoreIcon, NobodyIcon, PencilIcon } from '../shell/icons';
import { playMotion } from '../shell/motion';
import { PageHeader } from '../shell/PageHeader';
import { Popover } from '../shell/Popover';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import { useSyncEngine } from '../sync/SyncProvider';
import type { Transition as TicketTransition } from '../tickets/view/client';
import { FILLABLE_FIELDS, TransitionForm } from '../tickets/view/TransitionForm';
import { useTrackSections } from '../tracks/trackSections';
import { refusalMessage } from '../workflow/refusal';
import { BoardPeopleFilter, peopleFromRoute, routeWithPeople } from './BoardPeopleFilter';
import { CardTitleEditor } from './CardTitleEditor';
import {
  type Board,
  type BoardCard,
  type BoardClient,
  type BoardData,
  boardClient,
  type MoveOutcome,
  type MoveRequest,
  type Transition,
} from './client';

export interface BoardPageProps {
  boardId: number;
  client?: BoardClient;
}

type Column = BoardData['columns'][number];

interface Choice {
  move: MoveRequest;
  card: BoardCard;
  column: Column;
  transitions: Transition[];
}

/** A move waiting for what its transition asks for, such as a close reason. */
interface Asking {
  move: MoveRequest;
  card: BoardCard;
  column: Column;
  transition: TicketTransition;
}

/** A person, priority or other named value on a card. */
const nameOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'name' in value
    ? String((value as { name: unknown }).name)
    : null;

/** How many cards of a cell are drawn before the rest: more than a screen holds. */
const FIRST_CELL = 50;

/** What a card says in words, beyond its icons: only the fields someone added. */
function cardMeta(t: Translate, card: BoardCard): string[] {
  const out: string[] = [];
  if (typeof card.fields.dueDate === 'string') {
    out.push(t('boards.card.due', { date: card.fields.dueDate }));
  }
  if (Array.isArray(card.fields.labels) && card.fields.labels.length > 0) {
    out.push(card.fields.labels.join(', '));
  }
  return out;
}

/** Up to two letters for a person's small round mark on a card. */
const initialsOf = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toLocaleUpperCase())
    .join('');

/** The assignee as a small mark, with the name as its accessible name and tooltip (AGL-006). */
function CardPerson({ name, nobody }: { name: string | null; nobody: string }) {
  return (
    <span
      className={name ? 'board-card-person' : 'board-card-person is-nobody'}
      role="img"
      aria-label={name ?? nobody}
      title={name ?? nobody}
    >
      {name ? initialsOf(name) : <NobodyIcon width={20} height={20} />}
    </span>
  );
}

/** The column's count, limits and breach, as its header reads them (AGL-003). */
function ColumnHead({ column, t, at }: { column: Column; t: Translate; at: number }) {
  const hidden = column.count - column.shown;
  return (
    <div
      className="board-column-head"
      data-wip={column.wip ?? undefined}
      // Its place from the first step to the last, for the colour ramp of the top edge.
      style={{ '--flow-at': `${Math.round(at * 100)}%` } as CSSProperties}
    >
      <h2 className="board-column-name">{column.name}</h2>
      <p className="board-column-count">
        {t('boards.column.count', { count: column.count })}
        {column.min !== null && <span>{t('boards.column.min', { min: column.min })}</span>}
        {column.max !== null && <span>{t('boards.column.max', { max: column.max })}</span>}
      </p>
      {column.statusIds.length === 0 && (
        <p className="board-column-wip">{t('boards.column.noStatus')}</p>
      )}
      {column.wip === 'over' && <p className="board-column-wip">{t('boards.column.over')}</p>}
      {column.wip === 'under' && <p className="board-column-wip">{t('boards.column.under')}</p>}
      {hidden > 0 && (
        <p className="board-column-hidden">{t('boards.column.hidden', { count: hidden })}</p>
      )}
    </div>
  );
}

/** The plain reason a move was refused: the server's refusal in the person's words. */
function refusedText(
  t: Translate,
  key: string,
  outcome: Extract<MoveOutcome, { kind: 'refused' }>,
): string {
  if (outcome.refusal) {
    return t('boards.refused', { key, reason: refusalMessage(t, outcome.refusal) });
  }
  switch (outcome.code) {
    case '403':
    case 'forbidden':
    case 'forbidden_in_status':
      return t('boards.refusedForbidden', { key });
    case 'version_conflict':
      return t('boards.refusedStale', { key });
    case 'track_archived':
      return t('boards.refusedArchived', { key });
    default:
      return t('boards.refusedOther', { key });
  }
}

/**
 * "Only my tickets", which boards used to start with, finds the same cards as "Me" in the person
 * filter, and "Me" combines with other people, so a board no longer offers it (AGL-005). A filter
 * someone renamed or wrote, whatever its query, stays.
 */
export function offeredBoardFilters<T extends { id: string; name: string; query: string }>(
  filters: readonly T[],
): T[] {
  return filters.filter(
    (f) =>
      !(f.id === 'mine' && f.name === 'Only my tickets' && f.query === 'assignee = currentUser()'),
  );
}

/**
 * A new board's filter comes from the server in English and stays as it is until someone renames
 * it; shown here in the person's language. A renamed filter shows its own name.
 */
export function boardFilterName(t: Translate, filter: { id: string; name: string }): string {
  if (filter.id === 'recent' && filter.name === 'Recently updated') {
    return t('boards.filter.recent');
  }
  return filter.name;
}

/**
 * A board (M1-043; AGL-002 to AGL-006): its columns with counts and WIP limits, its lanes, and
 * the cards in rank order. The columns scroll sideways inside the board, never the page. A card
 * moves with Alt and the arrow keys (another column left or right, up or down in its column),
 * with its Move menu, or by dragging it to a place in a column (M1-046); a move runs the
 * ticket's transition on the server and asks which one when several lead into the column.
 * Board filters and the person filter (AGL-005 (3), in the address as `?people=`) narrow the
 * cards; counts stay whole.
 */
export function BoardPage({ boardId, client = boardClient }: BoardPageProps) {
  const t = useT();
  const lockText = useLockText();
  const sections = useTrackSections();
  const titleId = useId();
  const hintId = useId();
  const choiceTitleId = useId();
  const askingTitleId = useId();
  const [board, setBoard] = useState<Board | null>(null);
  const [data, setData] = useState<BoardData | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [filters, setFilters] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>(() => peopleFromRoute(currentRoute()));
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  /** The card whose title is being edited, with the version the person read. */
  const [editing, setEditing] = useState<{ id: number; version: number | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The card being dragged, and where it would land: before a card, or at the cell's end. */
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{
    columnId: string;
    laneId: string;
    before: number | null;
  } | null>(null);
  // A cell's first cards are drawn at once and the rest in a transition that yields to input,
  // so a board of thousands is usable at once (05b: 5,000 cards under 1 s to interactive).
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (!data || complete) return;
    const frame = requestAnimationFrame(() => startTransition(() => setComplete(true)));
    return () => cancelAnimationFrame(frame);
  }, [data, complete]);
  const focusAfter = useRef<number | null>(null);
  const links = useRef(new Map<number, HTMLAnchorElement>());
  const pencils = useRef(new Map<number, HTMLButtonElement>());
  /** The pencil that gets focus back once its editor has closed. */
  const pencilAfter = useRef<number | null>(null);
  /** A press that began on a card's button: a drag from there would not be meant. */
  const pressedButton = useRef(false);
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);

  /** After a change of person, the page says how many cards there are once they are here. */
  const sayShown = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (active: readonly string[], chosen: readonly string[]) => {
      const mine = ++generation.current;
      try {
        // A Scrum board shows its active sprints' tickets (M1-044); the rest are in the backlog.
        const b = await client.board(boardId);
        const d = await client.data(
          boardId,
          active,
          b.kind === 'scrum' ? 'active' : undefined,
          chosen,
        );
        if (mine !== generation.current) return;
        setBoard(b);
        setData(d);
        setState('loaded');
        if (sayShown.current) {
          sayShown.current = false;
          setAnnouncement(tRef.current('boards.people.shown', { count: d.cards.length }));
        }
      } catch {
        if (mine === generation.current) setState('failed');
      }
    },
    [client, boardId],
  );

  useEffect(() => {
    void load(filters, people);
  }, [load, filters, people]);

  // A link or the browser's Back can change the address while the page stays: it follows.
  useEffect(
    () =>
      onRouteChange(() => {
        const next = peopleFromRoute(currentRoute());
        setPeople((current) => (current.join() === next.join() ? current : next));
      }),
    [],
  );

  // Changes made elsewhere reach the local copy through the socket (NTF-008 (1): on the board
  // within a second): the board reads its data again, at most once in 100 ms, and
  // not while a card is being moved here.
  const engine = useSyncEngine();
  const moving = useRef(false);
  moving.current = busy || dragging !== null;
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!engine) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (moving.current) return;
        // Only the cards: the board itself (columns, kind) does not move with a ticket.
        const mine = ++generation.current;
        const kind = boardRef.current?.kind;
        client.data(boardId, filters, kind === 'scrum' ? 'active' : undefined, people).then(
          (d) => {
            if (mine === generation.current) setData(d);
          },
          () => {},
        );
      }, 100);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, client, boardId, filters, people]);

  useEffect(() => {
    if (focusAfter.current === null || !data) return;
    const moved = links.current.get(focusAfter.current);
    moved?.focus();
    // Only the card that has just dropped animates: a board can hold thousands.
    const card = moved?.closest('li');
    if (card) playMotion(card, 'motion-drop');
    focusAfter.current = null;
  }, [data]);

  useEffect(() => {
    if (choice) firstChoice.current?.focus();
  }, [choice]);

  useEffect(() => {
    if (editing !== null || pencilAfter.current === null) return;
    pencils.current.get(pencilAfter.current)?.focus();
    pencilAfter.current = null;
  }, [editing]);

  if (state === 'loading' && !data) {
    return (
      <section className="board-page" aria-busy="true">
        <p className="page-note">{t('boards.loading')}</p>
      </section>
    );
  }
  if (state === 'failed' || !board || !data) {
    return (
      <section className="board-page">
        <h1 className="page-title">{t('boards.title')}</h1>
        <p className="page-note" role="alert">
          {t('boards.failed')}
        </p>
      </section>
    );
  }

  const columns = data.columns;
  // The cards by cell, their place in it and the lanes' counts, in one pass: a board of
  // thousands of cards renders without searching the list per card (M1-046).
  const cells = new Map<string, BoardCard[]>();
  const placeOf = new Map<number, number>();
  const laneCounts = new Map<string, number>();
  const cellKey = (columnId: string, laneId: string) => `${columnId}\u0000${laneId}`;
  for (const card of data.cards) {
    const key = cellKey(card.columnId, card.laneId);
    const list = cells.get(key);
    placeOf.set(card.id, list?.length ?? 0);
    if (list) list.push(card);
    else cells.set(key, [card]);
    laneCounts.set(card.laneId, (laneCounts.get(card.laneId) ?? 0) + 1);
  }
  const cardsIn = (columnId: string, laneId: string) => cells.get(cellKey(columnId, laneId)) ?? [];
  const columnById = (id: string) => columns.find((c) => c.id === id) as Column;

  /** The transition whose fields a refused move is waiting for, when a form can ask for them. */
  async function neededForm(
    card: BoardCard,
    request: MoveRequest,
    column: Column,
    outcome: Extract<MoveOutcome, { kind: 'refused' }>,
  ) {
    const missing =
      outcome.refusal?.name === 'field-required' ? outcome.refusal.check?.field : null;
    if (typeof missing !== 'string' || request.fields) return null;
    try {
      const offered = await client.transitions(card.id);
      const leading = offered.filter(
        (o) =>
          column.statusIds.includes(o.to.id) &&
          (request.transitionId === undefined || o.id === request.transitionId),
      );
      return (
        leading.find(
          (o) => o.layout.includes(missing) && o.layout.every((f) => FILLABLE_FIELDS.includes(f)),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  async function move(card: BoardCard, request: MoveRequest, done: string) {
    setBusy(true);
    setProblem(null);
    setMenuFor(null);
    try {
      const outcome = await client.move(boardId, request);
      const column = columnById(request.columnId);
      if (outcome.kind === 'choose') {
        setChoice({ move: request, card, column, transitions: outcome.transitions });
        return;
      }
      setChoice(null);
      setAsking(null);
      if (outcome.kind === 'no_transition') {
        setProblem(
          column.statusIds.length === 0
            ? t('boards.emptyColumn', { column: column.name })
            : t('boards.noTransition', {
                key: card.key,
                column: column.name,
                status: card.status.name,
              }),
        );
        links.current.get(card.id)?.focus();
        return;
      }
      if (outcome.kind === 'refused') {
        // The transition asks for something a form can ask here, as the ticket does (a close
        // reason): ask, and move once it is given.
        const needs = await neededForm(card, request, column, outcome);
        if (needs) {
          setAsking({ card, column, move: request, transition: needs });
          return;
        }
        setProblem(refusedText(t, card.key, outcome));
        links.current.get(card.id)?.focus();
        return;
      }
      setAnnouncement(done);
      focusAfter.current = card.id;
      await load(filters, people);
    } catch {
      setProblem(t('boards.refusedOther', { key: card.key }));
    } finally {
      setBusy(false);
    }
  }

  function toColumn(card: BoardCard, step: -1 | 1) {
    const at = columns.findIndex((c) => c.id === card.columnId);
    const target = columns[at + step];
    if (!target) return;
    void move(
      card,
      { ticket: card.id, columnId: target.id },
      t('boards.moved', { key: card.key, column: target.name }),
    );
  }

  function inColumn(card: BoardCard, step: -1 | 1) {
    const cell = cardsIn(card.columnId, card.laneId);
    const at = cell.findIndex((c) => c.id === card.id);
    const neighbour = cell[at + step];
    if (!neighbour) return;
    const column = columnById(card.columnId);
    void move(
      card,
      step === -1
        ? { ticket: card.id, columnId: card.columnId, before: neighbour.id }
        : { ticket: card.id, columnId: card.columnId, after: neighbour.id },
      t('boards.ranked', {
        key: card.key,
        direction: step === -1 ? 'up' : 'down',
        column: column.name,
      }),
    );
  }

  /** Where a drag over a cell would put the card: before the card under the pointer's half. */
  function overCell(event: DragEvent, columnId: string, laneId: string) {
    if (dragging === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const over = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    let before: number | null = null;
    if (over) {
      const id = Number(over.dataset.cardId);
      const rect = over.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) before = id;
      else {
        const cell = cardsIn(columnId, laneId);
        before = cell[cell.findIndex((c) => c.id === id) + 1]?.id ?? null;
      }
    }
    if (dropAt?.columnId !== columnId || dropAt.laneId !== laneId || dropAt.before !== before) {
      setDropAt({ columnId, laneId, before });
    }
  }

  /** A drop: the same move as the keyboard's, to the column and the place shown. */
  function drop(event: DragEvent, column: Column, laneId: string) {
    event.preventDefault();
    const card = data?.cards.find((c) => c.id === dragging);
    const before = dropAt?.columnId === column.id ? dropAt.before : null;
    setDragging(null);
    setDropAt(null);
    if (!card || busy || before === card.id) return;
    const rest = cardsIn(column.id, laneId).filter((c) => c.id !== card.id);
    const last = rest[rest.length - 1];
    if (card.columnId === column.id) {
      // Dropped where it already was: nothing to do.
      const order = cardsIn(column.id, card.laneId).map((c) => c.id);
      const at = before === null ? rest.length : rest.findIndex((c) => c.id === before);
      if (order.indexOf(card.id) === at) return;
    }
    const request: MoveRequest =
      before !== null
        ? { ticket: card.id, columnId: column.id, before }
        : last
          ? { ticket: card.id, columnId: column.id, after: last.id }
          : { ticket: card.id, columnId: column.id };
    void move(
      card,
      request,
      card.columnId === column.id
        ? t('boards.dropped', { key: card.key, column: column.name })
        : t('boards.moved', { key: card.key, column: column.name }),
    );
  }

  function onCardKey(event: KeyboardEvent, card: BoardCard) {
    if (!event.altKey || busy || editing?.id === card.id) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') toColumn(card, step as -1 | 1);
    else inColumn(card, step as -1 | 1);
  }

  const closeEditor = (cardId: number) => {
    pencilAfter.current = cardId;
    setEditing(null);
  };

  /** Saves a card's title; the refusal in plain words, or null once it is saved. */
  async function saveTitle(card: BoardCard, summary: string): Promise<string | null> {
    try {
      const saved = await client.retitle(card.id, summary, editing?.version);
      setData(
        (current) =>
          current && {
            ...current,
            cards: current.cards.map((c) =>
              c.id === card.id ? { ...c, summary: saved.summary, version: saved.version } : c,
            ),
          },
      );
      setAnnouncement(t('boards.card.titleSaved', { key: card.key }));
      closeEditor(card.id);
      return null;
    } catch (error) {
      if (!(error instanceof ApiError)) return t('boards.card.titleOther');
      const body = error.body as {
        error?: string;
        locks?: Lock[];
        fields?: Record<string, string>;
      } | null;
      const lock = body?.locks?.[0];
      if (error.status === 403) {
        return lock ? lockText(lock, 'edit') : t('boards.card.titleForbidden');
      }
      if (body?.error === 'version_conflict') {
        // They have been told: the next Enter saves over the other person's change.
        setEditing({ id: card.id, version: undefined });
        return t('boards.card.titleStale');
      }
      if (body?.error === 'track_archived') return t('boards.card.titleArchived');
      if (body?.fields?.summary === 'required') return t('boards.card.titleEmpty');
      if (body?.fields?.summary === 'too_long') return t('boards.card.titleTooLong');
      return t('boards.card.titleOther');
    }
  }

  function toggleFilter(id: string) {
    setFilters((current) =>
      current.includes(id) ? current.filter((f) => f !== id) : [...current, id],
    );
  }

  /** Changes who the board shows; the address says so too, so the view can be shared. */
  function choosePeople(next: string[]) {
    sayShown.current = true;
    setPeople(next);
    replaceRoute(routeWithPeople(currentRoute(), next));
  }

  const location =
    board.location.type === 'track'
      ? t('boards.location.track', { track: board.location.track.name ?? '' })
      : t('boards.location.user', { name: board.location.user.name ?? '' });
  const hasBacklog = board.kind === 'scrum' && sections?.backlog !== false;
  const showLanes = data.lanes.length > 1 || data.lanes.some((l) => !l.catchAll);
  const offered = offeredBoardFilters(board.boardFilters);
  const filterButtons = offered.map((f) => (
    <button
      key={f.id}
      type="button"
      className="filter-chip"
      aria-pressed={filters.includes(f.id)}
      title={f.description || f.query}
      onClick={() => toggleFilter(f.id)}
    >
      {boardFilterName(t, f)}
    </button>
  ));

  const renderCard = (card: BoardCard) => {
    const column = columnById(card.columnId);
    const at = columns.indexOf(column);
    const cell = cardsIn(card.columnId, card.laneId);
    const position = placeOf.get(card.id) ?? 0;
    const menuOpen = menuFor === card.id;
    const titleOpen = editing?.id === card.id;
    const priority = card.fields.priority as { name: string; level?: number } | null | undefined;
    return (
      <li
        key={card.id}
        className={`board-card${dragging === card.id ? ' is-dragging' : ''}${dropAt?.before === card.id ? ' is-drop-before' : ''}`}
        data-card-id={card.id}
        draggable={!busy && !titleOpen}
        onPointerDownCapture={() => {
          pressedButton.current = false;
        }}
        onDragStart={(event) => {
          if (pressedButton.current) {
            pressedButton.current = false;
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData('text/plain', card.key);
          event.dataTransfer.effectAllowed = 'move';
          setDragging(card.id);
          setMenuFor(null);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropAt(null);
        }}
        style={card.colour ? ({ '--card-colour': card.colour } as CSSProperties) : undefined}
        onKeyDown={(event) => onCardKey(event, card)}
      >
        {titleOpen ? (
          <CardTitleEditor
            ticketKey={card.key}
            title={card.summary}
            onSave={(summary) => saveTitle(card, summary)}
            onCancel={() => closeEditor(card.id)}
          />
        ) : (
          <a
            className="board-card-link"
            href={routeHref(`#/tickets/${encodeURIComponent(card.key)}`)}
            onClick={() =>
              rememberBoard(card.key, {
                id: boardId,
                name: board.name,
                ...(people.length > 0 ? { people: people.join(',') } : {}),
              })
            }
            aria-describedby={hintId}
            title={`${card.key} ${card.summary}`}
            ref={(el) => {
              if (el) links.current.set(card.id, el);
              else links.current.delete(card.id);
            }}
          >
            {/* The key is for the tooltip and for those who hear the card: the title is the card. */}
            <span className="visually-hidden">{card.key}</span>{' '}
            <span className="board-card-summary">{card.summary}</span>
          </a>
        )}
        <p className="board-card-meta">
          <span className="ticket-icons">
            <TypeIcon name={card.ticketType.name} icon={card.ticketType.icon} />
            {priority && <PriorityIcon name={priority.name} level={priority.level} />}
          </span>
          {typeof card.fields.points === 'number' && (
            <span
              className="board-card-points"
              role="img"
              aria-label={t('boards.card.points', { points: card.fields.points })}
              title={t('boards.card.points', { points: card.fields.points })}
            >
              {card.fields.points}
            </span>
          )}
          {cardMeta(t, card).map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed in order per card
            <span key={i}>{part}</span>
          ))}
          {/* Saying a card just arrived tells nothing on a column of them: only waiting shows. */}
          {card.daysInColumn !== null && card.daysInColumn > 0 && (
            <span
              className="board-card-age"
              role="img"
              aria-label={t('boards.card.days', { days: card.daysInColumn })}
              title={t('boards.card.days', { days: card.daysInColumn })}
            >
              <ClockIcon width={14} height={14} />
              {card.daysInColumn}
            </span>
          )}
          {'assignee' in card.fields && (
            <CardPerson name={nameOf(card.fields.assignee)} nobody={t('boards.card.unassigned')} />
          )}
        </p>
        {!titleOpen && (
          <span className="board-card-actions">
            {card.mayEdit && (
              <button
                type="button"
                className="board-card-move"
                aria-label={t('boards.card.editTitle', { key: card.key })}
                title={t('boards.card.editTitle', { key: card.key })}
                disabled={busy}
                ref={(el) => {
                  if (el) pencils.current.set(card.id, el);
                  else pencils.current.delete(card.id);
                }}
                onPointerDown={() => {
                  pressedButton.current = true;
                }}
                onClick={() => {
                  setMenuFor(null);
                  setEditing({ id: card.id, version: card.version });
                }}
              >
                <PencilIcon width={18} height={18} />
              </button>
            )}
            <button
              type="button"
              className="board-card-move"
              aria-expanded={menuOpen}
              aria-label={t('boards.card.move', { key: card.key })}
              title={t('boards.card.move', { key: card.key })}
              disabled={busy}
              onPointerDown={() => {
                pressedButton.current = true;
              }}
              onClick={() => setMenuFor(menuOpen ? null : card.id)}
            >
              <MoreIcon width={18} height={18} />
            </button>
          </span>
        )}
        {menuOpen && (
          <ul className="board-move-menu">
            {columns.map((target, i) =>
              target.id === card.columnId ? null : (
                <li key={target.id}>
                  <button
                    type="button"
                    onClick={() =>
                      void move(
                        card,
                        { ticket: card.id, columnId: target.id },
                        t('boards.moved', { key: card.key, column: target.name }),
                      )
                    }
                  >
                    {i < at
                      ? t('boards.card.moveBack', { column: target.name })
                      : t('boards.card.moveTo', { column: target.name })}
                  </button>
                </li>
              ),
            )}
            {position > 0 && (
              <li>
                <button type="button" onClick={() => inColumn(card, -1)}>
                  {t('boards.card.moveUp', { column: column.name })}
                </button>
              </li>
            )}
            {position < cell.length - 1 && (
              <li>
                <button type="button" onClick={() => inColumn(card, 1)}>
                  {t('boards.card.moveDown', { column: column.name })}
                </button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const grid = { '--board-columns': columns.length } as CSSProperties;
  return (
    <section className="board-page" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={board.name}
        eyebrow={t('boards.meta', {
          kind: t(board.kind === 'scrum' ? 'boards.kind.scrum' : 'boards.kind.kanban'),
          location,
        })}
        purpose={t('purpose.board')}
        about={t('about.board')}
        actions={
          <>
            {hasBacklog && (
              <a className="button-quiet" href={routeHref(`#/boards/${boardId}/backlog`)}>
                {t('sprints.backlog.link')}
              </a>
            )}
            <a
              className="button-quiet"
              href={routeHref(
                board.location.type === 'track' && board.location.track.key
                  ? `#/tracks/${encodeURIComponent(board.location.track.key)}/statistics`
                  : `#/boards/${boardId}/reports`,
              )}
            >
              {t('reports.link')}
            </a>
            {board.mayConfigure && (
              <a className="button-quiet" href={routeHref(`#/boards/${boardId}/settings`)}>
                {t('boards.settings.link')}
              </a>
            )}
          </>
        }
      />
      <div className="filter-row">
        {offered.length > 0 &&
          (board.boardFilterDisplay === 'dropdown' ? (
            <Popover
              label={t('boards.filters.summary', { count: filters.length })}
              title={t('boards.filters')}
              on={filters.length > 0}
            >
              <fieldset className="filter-chips">
                <legend className="visually-hidden">{t('boards.filters')}</legend>
                {filterButtons}
              </fieldset>
            </Popover>
          ) : (
            <fieldset className="filter-chips">
              <legend className="visually-hidden">{t('boards.filters')}</legend>
              {filterButtons}
            </fieldset>
          ))}
        <BoardPeopleFilter people={data.people} chosen={people} onChange={choosePeople} />
      </div>
      {data.unmapped.count > 0 && (
        <p className="board-unmapped">
          {t('boards.unmapped', {
            count: data.unmapped.count,
            statuses: data.unmapped.statuses.map((s) => `${s.name} (${s.count})`).join(', '),
          })}
        </p>
      )}
      {data.truncated && (
        <p className="board-unmapped">{t('boards.truncated', { count: data.cards.length })}</p>
      )}
      {data.warnings.length > 0 && (
        <p className="board-unmapped">{t('boards.warnings', { list: data.warnings.join('; ') })}</p>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <p id={hintId} className="board-hint">
        {t('boards.keyboardHint')}
      </p>
      {data.cards.length === 0 &&
        (people.length > 0 ? (
          <EmptyState
            icon={BoardsIcon}
            title={t('boards.people.emptyTitle')}
            action={
              <button type="button" className="button-quiet" onClick={() => choosePeople([])}>
                {t('boards.people.clear')}
              </button>
            }
          >
            {t('boards.people.emptyBody')}
          </EmptyState>
        ) : hasBacklog && filters.length === 0 ? (
          <EmptyState
            icon={BoardsIcon}
            title={t('boards.emptyScrumTitle')}
            action={
              <a className="button-quiet" href={routeHref(`#/boards/${boardId}/backlog`)}>
                {t('boards.emptyScrumAction')}
              </a>
            }
          >
            {t('boards.emptyScrumBody')}
          </EmptyState>
        ) : (
          <EmptyState icon={BoardsIcon} title={t('boards.empty')}>
            {t('boards.emptyBody')}
          </EmptyState>
        ))}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached by keyboard to scroll it */}
      <section className="board-scroll" aria-label={t('boards.columns')} tabIndex={0}>
        <div className="board-grid" style={grid}>
          <div className="board-row board-heads">
            {columns.map((column, i) => (
              <ColumnHead
                key={column.id}
                column={column}
                t={t}
                at={columns.length > 1 ? i / (columns.length - 1) : 0}
              />
            ))}
          </div>
          {data.lanes.map((given) => {
            // The unassigned lane is named here, in the reader's language.
            const lane =
              given.assignee === null ? { ...given, name: t('boards.card.unassigned') } : given;
            const count = laneCounts.get(lane.id) ?? 0;
            if (showLanes && lane.catchAll && count === 0 && data.lanes.length > 1) return null;
            return (
              <section
                key={lane.id}
                className="board-lane"
                aria-label={showLanes ? lane.name : t('boards.lane.all')}
              >
                {showLanes && (
                  <h3 className="board-lane-title">
                    {lane.name} <span>{t('boards.lane.count', { count })}</span>
                  </h3>
                )}
                <div className="board-row">
                  {columns.map((column) => (
                    <ul
                      key={column.id}
                      className={
                        dropAt?.columnId === column.id && dropAt.laneId === lane.id
                          ? 'board-cell is-drop-target'
                          : 'board-cell'
                      }
                      onDragOver={(event) => overCell(event, column.id, lane.id)}
                      onDrop={(event) => drop(event, column, lane.id)}
                      aria-label={
                        showLanes
                          ? t('boards.cell', { column: column.name, lane: lane.name })
                          : column.name
                      }
                    >
                      {(complete
                        ? cardsIn(column.id, lane.id)
                        : cardsIn(column.id, lane.id).slice(0, FIRST_CELL)
                      ).map(renderCard)}
                    </ul>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
      {asking && (
        <div
          className="board-choice"
          role="dialog"
          aria-modal="true"
          aria-labelledby={askingTitleId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setAsking(null);
              links.current.get(asking.card.id)?.focus();
            }
          }}
          ref={(el) => {
            if (el && !el.contains(document.activeElement)) {
              el.querySelector<HTMLElement>('select, [role="combobox"]')?.focus();
            }
          }}
        >
          <h2 id={askingTitleId}>
            {t('boards.choose.title', { key: asking.card.key, column: asking.column.name })}
          </h2>
          <p>{t('boards.asking.intro', { name: asking.transition.name })}</p>
          <TransitionForm
            transition={asking.transition}
            client={client}
            onRun={(fields) => {
              void move(
                asking.card,
                { ...asking.move, transitionId: asking.transition.id, fields },
                t('boards.moved', { key: asking.card.key, column: asking.column.name }),
              );
            }}
            onCancel={() => {
              setAsking(null);
              links.current.get(asking.card.id)?.focus();
            }}
          />
        </div>
      )}
      {choice && (
        <div
          className="board-choice"
          role="dialog"
          aria-modal="true"
          aria-labelledby={choiceTitleId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setChoice(null);
              links.current.get(choice.card.id)?.focus();
            }
          }}
        >
          <h2 id={choiceTitleId}>
            {t('boards.choose.title', { key: choice.card.key, column: choice.column.name })}
          </h2>
          <p>{t('boards.choose.intro')}</p>
          <ul>
            {choice.transitions.map((transition, i) => (
              <li key={transition.id}>
                <button
                  type="button"
                  className="button-primary"
                  ref={i === 0 ? firstChoice : undefined}
                  onClick={() =>
                    void move(
                      choice.card,
                      { ...choice.move, transitionId: transition.id },
                      t('boards.moved', { key: choice.card.key, column: choice.column.name }),
                    )
                  }
                >
                  {t('boards.choose.option', { name: transition.name, status: transition.to.name })}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setChoice(null);
              links.current.get(choice.card.id)?.focus();
            }}
          >
            {t('boards.choose.cancel')}
          </button>
        </div>
      )}
    </section>
  );
}
