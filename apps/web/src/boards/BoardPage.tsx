import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { type Lock, useLockText } from '../locks/useLockText';
import { rememberBoard } from '../routing/cameFrom';
import { currentRoute, onRouteChange, replaceRoute, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { BoardsIcon } from '../shell/icons';
import { playMotion } from '../shell/motion';
import { PageHeader } from '../shell/PageHeader';
import { followPointerDrag } from '../shell/pointerDrag';
import { Popover } from '../shell/Popover';
import { CompleteSprintDialog, type SprintCounts } from '../sprints/CompleteSprint';
import { type Sprint, type SprintClient, sprintClient } from '../sprints/client';
import { useSyncEngine } from '../sync/SyncProvider';
import { useSubticketProgress } from '../tickets/tools/Progress';
import type { Transition as TicketTransition } from '../tickets/view/client';
import { FILLABLE_FIELDS, TransitionForm } from '../tickets/view/TransitionForm';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { useTrackSections } from '../tracks/trackSections';
import { refusalMessage } from '../workflow/refusal';
import { BoardCardItem, type CardActions } from './BoardCard';
import { BoardCell, createWindowing, WINDOW_FROM } from './BoardCell';
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
  /** A Scrum board's sprints: which are active, and whether the person may complete them. */
  sprints?: Pick<SprintClient, 'boardSprints' | 'complete'>;
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

const cardText = new WeakMap<BoardCard, string>();
const textOf = (card: BoardCard): string => {
  let text = cardText.get(card);
  if (text === undefined) {
    text = JSON.stringify(card);
    cardText.set(card, text);
  }
  return text;
};

/**
 * A new read of the board with each card that did not change kept as the object already drawn,
 * so a drop or a reload draws again only the cards that changed (T-193).
 */
export function shareCards(previous: readonly BoardCard[] | undefined, next: BoardCard[]) {
  if (!previous || previous.length === 0) return next;
  const before = new Map(previous.map((card) => [card.id, card]));
  return next.map((card) => {
    const old = before.get(card.id);
    return old && textOf(old) === textOf(card) ? old : card;
  });
}

const cellKey = (columnId: string, laneId: string) => `${columnId}\u0000${laneId}`;
const NO_CARDS: BoardCard[] = [];

/** Where a dragged card would land: before a card of a cell, or at the cell's end (null). */
interface DropPlace {
  columnId: string;
  laneId: string;
  before: number | null;
}
const samePlace = (a: DropPlace | null, b: DropPlace | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.columnId === b.columnId &&
    a.laneId === b.laneId &&
    a.before === b.before);

/** A press on these is theirs: a mouse drags a card from anywhere else on it. */
const OWN_PRESS = 'button, input, select, textarea';

/** The label that follows the pointer, placed by its coordinates (`drag-ghost`, drag.css). */
const ghostAt = (at: { x: number; y: number }) => `translate(${at.x + 12}px, ${at.y + 12}px)`;

/** The cards by cell, each card's place in it and the lanes' counts, in one pass (M1-046). */
function groupCards(cards: readonly BoardCard[]) {
  const cells = new Map<string, BoardCard[]>();
  const placeOf = new Map<number, number>();
  const laneCounts = new Map<string, number>();
  for (const card of cards) {
    const key = cellKey(card.columnId, card.laneId);
    const list = cells.get(key);
    placeOf.set(card.id, list?.length ?? 0);
    if (list) list.push(card);
    else cells.set(key, [card]);
    laneCounts.set(card.laneId, (laneCounts.get(card.laneId) ?? 0) + 1);
  }
  return { cells, placeOf, laneCounts };
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

/**
 * A sprint's tickets as the board counts them (AGL-010; spec 01b section 3.2): done in the
 * rightmost column, open in the others or in a status no column takes. Column counts ignore
 * board filters, so a filter never changes them (AGL-003 (2)).
 */
export function sprintCounts(data: Pick<BoardData, 'columns' | 'unmapped'>): SprintCounts {
  const done = data.columns.at(-1)?.count ?? 0;
  const all = data.columns.reduce((sum, c) => sum + c.count, 0) + data.unmapped.count;
  return { done, open: all - done };
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
 * cards; counts stay whole. On a Scrum board, those who manage its sprints complete an active
 * one from here (T-106; AGL-010), after a pop-up that counts its done and open tickets.
 * Each cell is one tab stop whose arrows go from card to card; a board of more than
 * `WINDOW_FROM` cards draws only the cards near the screen, and a drop draws again only the
 * cards that changed (T-193, `BoardCell`, `BoardCard`).
 *
 * Drags use pointer events (T-162b; ADR-114, section 12), as the backlog's do: a mouse drags a
 * card from anywhere but its pencil, and a finger or a mouse by its grip, so a finger elsewhere
 * scrolls the board. The cell and the place are marked, a label follows the pointer, the page
 * says what is in hand, Escape cancels, and near an edge the columns or the page scroll along.
 */
export function BoardPage({
  boardId,
  client = boardClient,
  sprints = sprintClient,
}: BoardPageProps) {
  const t = useT();
  const lockText = useLockText();
  const sections = useTrackSections();
  const titleId = useId();
  const hintId = useId();
  const choiceTitleId = useId();
  const askingTitleId = useId();
  const [board, setBoard] = useState<Board | null>(null);
  const [data, setData] = useState<BoardData | null>(null);
  const progress = useSubticketProgress(data?.cards ?? null, client.subticketProgress);
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
  /** A Scrum board's sprints and whether the person may manage them (the server's answer). */
  const [sprintList, setSprintList] = useState<{ sprints: Sprint[]; mayManage: boolean } | null>(
    null,
  );
  /** The sprint being completed, with what the board counts in it. */
  const [completing, setCompleting] = useState<{
    sprint: Sprint;
    counts: SprintCounts | null;
  } | null>(null);
  const completed = useRef(false);
  const backlogLink = useRef<HTMLAnchorElement>(null);
  const scrollRegion = useRef<HTMLElement>(null);
  /** The card being dragged, and where it would land: before a card, or at the cell's end. */
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<DropPlace | null>(null);
  /** Stops following the press under way, if any (T-162b). */
  const stopDrag = useRef<(() => void) | null>(null);
  /** The label in hand and where the pointer is: moved by hand, so a drag draws no card again. */
  const ghost = useRef<HTMLDivElement>(null);
  const pointerAt = useRef({ x: 0, y: 0 });
  // A large board draws only the cards near the screen (T-193): every cell reads where it is on
  // a scroll through one listener.
  const [windowing] = useState(createWindowing);
  const focusAfter = useRef<number | null>(null);
  /** The card a move is about: drawn wherever it lands, so the focus can follow it there. */
  const [landing, setLanding] = useState<number | null>(null);
  const links = useRef(new Map<number, HTMLAnchorElement>());
  const pencils = useRef(new Map<number, HTMLButtonElement>());
  /** The pencil that gets focus back once its editor has closed. */
  const pencilAfter = useRef<number | null>(null);
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
        setData((current) => ({ ...d, cards: shareCards(current?.cards, d.cards) }));
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

  const loadSprints = useCallback(() => {
    sprints.boardSprints(boardId).then(setSprintList, () => setSprintList(null));
  }, [sprints, boardId]);
  const scrum = board?.kind === 'scrum';
  useEffect(() => {
    if (scrum) loadSprints();
    else setSprintList(null);
  }, [scrum, loadSprints]);

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
  const readCards = useCallback(() => {
    if (moving.current) return;
    // The first read is still on its way and brings the cards with the board; a read here would
    // take its place and leave the page with no board at all.
    if (!boardRef.current) return;
    // Only the cards: the board itself (columns, kind) does not move with a ticket.
    const mine = ++generation.current;
    const kind = boardRef.current?.kind;
    client.data(boardId, filters, kind === 'scrum' ? 'active' : undefined, people).then(
      (d) => {
        if (mine === generation.current) {
          setData((current) => ({ ...d, cards: shareCards(current?.cards, d.cards) }));
        }
      },
      () => {},
    );
  }, [client, boardId, filters, people]);
  useEffect(() => {
    if (!engine) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        readCards();
      }, 100);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, readCards]);
  // An edit in the ticket pop-up over this board shows at once, socket or no socket.
  useTicketChanges(readCards);

  useEffect(() => {
    if (focusAfter.current === null || !data) return;
    const moved = links.current.get(focusAfter.current);
    // Focused where it landed, which may be far down a long column: brought into view.
    moved?.focus({ preventScroll: true });
    const card = moved?.closest('li');
    card?.scrollIntoView?.({ block: 'nearest' });
    // Only the card that has just dropped animates: a board can hold thousands.
    if (card) playMotion(card, 'motion-drop');
    focusAfter.current = null;
    setLanding(null);
  }, [data]);

  useEffect(() => {
    if (choice) firstChoice.current?.focus();
  }, [choice]);

  useEffect(() => {
    if (editing !== null || pencilAfter.current === null) return;
    pencils.current.get(pencilAfter.current)?.focus();
    pencilAfter.current = null;
  }, [editing]);

  // The cards by cell, once per read of the board, not once per drawing (a drag draws often).
  const layout = useMemo(() => groupCards(data?.cards ?? NO_CARDS), [data?.cards]);

  // Every card gets this same object, so a card is drawn again only when its own props change;
  // its methods call the handlers of the latest drawing.
  const handlers = useRef<CardActions | null>(null);
  const [actions] = useState<CardActions>(() => {
    const latest = () => handlers.current as CardActions;
    return {
      grab: (event, card) => latest().grab(event, card),
      keyDown: (event, card) => latest().keyDown(event, card),
      open: (card) => latest().open(card),
      editTitle: (card) => latest().editTitle(card),
      toggleMenu: (card) => latest().toggleMenu(card),
      linkRef: (id, link) => latest().linkRef(id, link),
      pencilRef: (id, pencil) => latest().pencilRef(id, pencil),
    };
  });
  // A drag outlives the drawing it began in: it asks the latest one where it is and what to do.
  const live = useRef<{
    dropAt(x: number, y: number): DropPlace | null;
    dropOn(card: BoardCard, place: DropPlace | null): void;
  } | null>(null);
  // A page that goes mid-drag stops following the pointer.
  useEffect(() => () => stopDrag.current?.(), []);

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
  // A board of thousands of cards renders without searching the list per card (M1-046).
  const { cells, placeOf, laneCounts } = layout;
  const cardsIn = (columnId: string, laneId: string) =>
    cells.get(cellKey(columnId, laneId)) ?? NO_CARDS;
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
    setLanding(card.id);
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
        setLanding(null);
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
        setLanding(null);
        return;
      }
      setAnnouncement(done);
      focusAfter.current = card.id;
      await load(filters, people);
    } catch {
      setProblem(t('boards.refusedOther', { key: card.key }));
      setLanding(null);
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

  /**
   * What is under the pointer, as a place a dragged card may land (T-162b): a cell, and in it
   * before the card under the pointer's upper half, else before the next one or at the end.
   */
  function placeAt(x: number, y: number): DropPlace | null {
    const element = document.elementFromPoint?.(x, y);
    const holder = element?.closest<HTMLElement>('[data-drop-column]');
    if (!element || !holder) return null;
    const columnId = holder.dataset.dropColumn as string;
    const laneId = holder.dataset.dropLane as string;
    const over = element.closest<HTMLElement>('[data-card-id]');
    let before: number | null = null;
    if (over && holder.contains(over)) {
      const id = Number(over.dataset.cardId);
      const rect = over.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) before = id;
      else {
        const cell = cardsIn(columnId, laneId);
        before = cell[cell.findIndex((c) => c.id === id) + 1]?.id ?? null;
      }
    }
    return { columnId, laneId, before };
  }

  /** A drop: the same move as the keyboard's, to the column and the place shown. */
  function dropOn(card: BoardCard, place: DropPlace | null) {
    const column = place ? columns.find((c) => c.id === place.columnId) : undefined;
    const stayed = () => setAnnouncement(t('boards.drag.cancelled', { key: card.key }));
    if (!place || !column || busy || place.before === card.id) return stayed();
    const { before, laneId } = place;
    const rest = cardsIn(column.id, laneId).filter((c) => c.id !== card.id);
    const last = rest[rest.length - 1];
    if (card.columnId === column.id) {
      // Dropped where it already was: nothing to ask of the server.
      const order = cardsIn(column.id, card.laneId).map((c) => c.id);
      const at = before === null ? rest.length : rest.findIndex((c) => c.id === before);
      if (order.indexOf(card.id) === at) return stayed();
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
  live.current = { dropAt: placeAt, dropOn };

  /** Ends a drag on the page: nothing in hand, nothing marked. */
  function endDrag() {
    setDragging(null);
    setDropAt(null);
  }

  /**
   * A press on a card that may become a drag (T-162b): by mouse from anywhere but the card's
   * pencil and editor, by anything from its grip. Not while a move runs or its title is edited.
   */
  function grab(event: ReactPointerEvent, card: BoardCard) {
    const target = event.target as Element;
    const onGrip = target.closest('[data-card-grip]') !== null;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A finger elsewhere on the card scrolls the board; a mouse on a control uses it.
    if (!onGrip && (event.pointerType !== 'mouse' || target.closest(OWN_PRESS))) return;
    if (busy || stopDrag.current || editing?.id === card.id) return;
    const words = { key: card.key };
    stopDrag.current = followPointerDrag(event, {
      start: (x, y) => {
        pointerAt.current = { x, y };
        setDragging(card.id);
        setMenuFor(null);
        setAnnouncement(t('boards.drag.start', words));
      },
      move: (x, y) => {
        pointerAt.current = { x, y };
        if (ghost.current) ghost.current.style.transform = ghostAt(pointerAt.current);
        const to = live.current?.dropAt(x, y) ?? null;
        setDropAt((current) => (samePlace(current, to) ? current : to));
      },
      drop: (x, y) => {
        const to = live.current?.dropAt(x, y) ?? null;
        endDrag();
        live.current?.dropOn(card, to);
      },
      cancel: () => {
        endDrag();
        setAnnouncement(t('boards.drag.cancelled', words));
      },
      end: () => {
        stopDrag.current = null;
      },
    });
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
  const activeSprints =
    board.kind === 'scrum' && sprintList?.mayManage
      ? sprintList.sprints.filter((s) => s.state === 'active')
      : [];
  const futureSprints = sprintList?.sprints.filter((s) => s.state === 'future') ?? [];

  /** Opens the pop-up for a sprint, counted from the board's own data. */
  async function openComplete(sprint: Sprint) {
    if (!data) return;
    completed.current = false;
    if (activeSprints.length === 1) {
      setCompleting({ sprint, counts: sprintCounts(data) });
      return;
    }
    // Several sprints run at once and the board shows them together: count this one alone.
    try {
      setCompleting({ sprint, counts: sprintCounts(await client.data(boardId, [], [sprint.id])) });
    } catch {
      setCompleting({ sprint, counts: null });
    }
  }
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

  handlers.current = {
    grab,
    keyDown: onCardKey,
    open: (card: BoardCard) => {
      rememberBoard(card.key, {
        id: boardId,
        name: board.name,
        ...(people.length > 0 ? { people: people.join(',') } : {}),
      });
    },
    editTitle: (card: BoardCard) => {
      if (busy) return;
      setMenuFor(null);
      setEditing({ id: card.id, version: card.version });
    },
    toggleMenu: (card: BoardCard) => {
      if (!busy) setMenuFor((open) => (open === card.id ? null : card.id));
    },
    linkRef: (id: number, link: HTMLAnchorElement | null) => {
      if (link) links.current.set(id, link);
      else links.current.delete(id);
    },
    pencilRef: (id: number, pencil: HTMLButtonElement | null) => {
      if (pencil) pencils.current.set(id, pencil);
      else pencils.current.delete(id);
    },
  };

  /** A card's Move menu: the other columns, then up and down in its own. */
  const moveMenu = (card: BoardCard) => {
    const column = columnById(card.columnId);
    const at = columns.indexOf(column);
    const cell = cardsIn(card.columnId, card.laneId);
    const position = placeOf.get(card.id) ?? 0;
    return (
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
    );
  };

  const renderCard = (
    card: BoardCard,
    place: number,
    of: number,
    slot: { tabbable: boolean; skipBefore: number },
  ) => (
    <BoardCardItem
      key={card.id}
      card={card}
      place={place}
      of={of}
      hintId={hintId}
      tabbable={slot.tabbable}
      skipBefore={slot.skipBefore}
      dragging={dragging === card.id}
      dropBefore={dropAt?.before === card.id}
      // Only the card on the move says so: the others ignore presses until it is done, and a
      // move draws again none of them (T-193).
      busy={busy && landing === card.id}
      menuOpen={menuFor === card.id}
      editor={
        editing?.id === card.id ? (
          <CardTitleEditor
            ticketKey={card.key}
            title={card.summary}
            onSave={(summary) => saveTitle(card, summary)}
            onCancel={() => closeEditor(card.id)}
          />
        ) : null
      }
      menu={menuFor === card.id ? moveMenu(card) : null}
      progress={progress[card.id]}
      actions={actions}
    />
  );
  // On a large board each cell draws the cards near the screen and these, wherever they are.
  const windowed = data.cards.length > WINDOW_FROM;
  const keep = [dragging, menuFor, editing?.id, landing, choice?.card.id, asking?.card.id];
  // What a drag holds, for the label that follows the pointer.
  const inHand = dragging === null ? undefined : data.cards.find((c) => c.id === dragging);

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
              <a
                ref={backlogLink}
                className="button-quiet"
                href={routeHref(`#/boards/${boardId}/backlog`)}
              >
                {t('sprints.backlog.link')}
              </a>
            )}
            {activeSprints.map((sprint) => (
              <button
                key={sprint.id}
                type="button"
                className="button-quiet"
                onClick={() => void openComplete(sprint)}
              >
                {activeSprints.length === 1
                  ? t('sprints.complete.submit')
                  : t('boards.sprint.complete', { name: sprint.name })}
              </button>
            ))}
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
      <section
        ref={scrollRegion}
        className="board-scroll"
        data-tutorial="board-columns"
        aria-label={t('boards.columns')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached by keyboard to scroll it
        tabIndex={0}
      >
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
                  {columns.map((column) => {
                    const cell = cardsIn(column.id, lane.id);
                    return (
                      <BoardCell
                        key={column.id}
                        cards={cell}
                        className={
                          dropAt?.columnId === column.id && dropAt.laneId === lane.id
                            ? 'board-cell is-drop-target'
                            : 'board-cell'
                        }
                        windowed={windowed}
                        windowing={windowing}
                        keep={keep}
                        columnId={column.id}
                        laneId={lane.id}
                        label={
                          showLanes
                            ? t('boards.cell', { column: column.name, lane: lane.name })
                            : column.name
                        }
                        renderCard={(card, place, slot) =>
                          renderCard(card, place, cell.length, slot)
                        }
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </section>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
      {inHand && (
        <div
          ref={ghost}
          className="drag-ghost"
          aria-hidden="true"
          style={{ transform: ghostAt(pointerAt.current) }}
        >
          {`${inHand.key} ${inHand.summary}`}
        </div>
      )}
      {completing && (
        <CompleteSprintDialog
          sprint={completing.sprint}
          futures={futureSprints}
          counts={completing.counts}
          client={sprints}
          onCompleted={() => {
            completed.current = true;
            setAnnouncement(t('sprints.complete.done', { name: completing.sprint.name }));
            setCompleting(null);
            loadSprints();
            void load(filters, people);
          }}
          onClose={() => {
            setCompleting(null);
            // A refusal may mean the sprint changed elsewhere: the buttons follow.
            loadSprints();
          }}
          restoreFocus={(opener) => {
            // The button of a completed sprint goes: the backlog is where its open tickets went.
            if (completed.current) (backlogLink.current ?? scrollRegion.current)?.focus();
            else opener?.focus();
          }}
        />
      )}
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
