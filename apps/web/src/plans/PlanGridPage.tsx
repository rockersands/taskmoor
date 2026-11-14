import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { navigate, routeHref } from '../routing/router';
import type { SearchClient, SearchField, SearchTicket } from '../search/client';
import { cellEditor, customFieldId, isDateTimeColumn } from '../search/columns';
import { Cell } from '../search/ResultTable';
import { useColumnName } from '../search/useColumnName';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import { MoveMenu, type MoveMenuItem } from '../shell/MoveMenu';
import { OverlayLayer } from '../shell/OverlayLayer';
import { followPointerDrag } from '../shell/pointerDrag';
import { fieldName } from '../shell/seededNames';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { COARSE_QUERY } from '../timeline/touch';
import { GROUP_LABELS, type PlanGroup, type PlanView, planHref } from './address';
import { type GridClient, isTimeout, type LevelName, savedTicketOf } from './grid/client';
import {
  applyEdit,
  applyEdits,
  type ColumnProblem,
  columnProblems,
  computeGrid,
  editOfTicket,
  formulaCell,
  type GridCompute,
  moveRow,
  type TotalCell,
  totalCell,
} from './grid/compute';
import { useRowWindow } from './grid/rowWindow';
import {
  allCollapsible,
  childCount,
  collapsedFromKeys,
  type MoveProblem,
  moveProblem,
  rowKeys,
  setSize,
  visibleRows,
} from './grid/tree';
import {
  type GridAnswer,
  placedByLink,
  type StructureColumn,
  type StructureList,
  type StructureProblem,
  type StructureSummary,
} from './grid/types';
import { STRUCTURE_REFUSED, useRefName } from './grid/words';
import {
  MOVE_PROBLEM,
  type MoveCandidate,
  type MoveParent,
  MoveUnderDialog,
  moveRefusal,
} from './MoveUnderDialog';
import { StructureDialog } from './StructureDialog';

export interface PlanGridPageProps {
  planId: number;
  /** The page's view: its filters, the scenario open and the structure shown. */
  view: PlanView;
  /** The scenario open on the page: the Grid shows live values in it and is read-only. */
  scenario: { id: number; name: string } | null;
  client: GridClient;
  /** Cells edit through the ticket route, as in search results. */
  search: SearchClient;
}

/** Cells are asked for this long after the rows in view settle. */
const CELL_DEBOUNCE = 100;
/** Tickets one rows-in-view read asks for. */
const CELL_BATCH = 500;
/** Tickets the page keeps; the oldest not in view go first. */
const CELL_CACHE = 5_000;
/** A card's height on a phone: key, summary and two columns, with a 44 px expand button. */
const CARD_ROW = 120;
/** A card grows to fit its words up to this height, so nothing can make it grow without end. */
const CARD_MOST = 4 * CARD_ROW;
/** Cards indent a level at a time up to this many; deeper ones name their level in words. */
const CARD_LEVELS = 4;
/** Rows the Move under picker lists at once; typing narrows the rest. */
const MOVE_PAGE = 50;
/** The label that follows the pointer in a drag, placed by its coordinates (`drag-ghost`). */
const ghostAt = (x: number, y: number) => `translate(${x + 12}px, ${y + 12}px)`;

const storageKey = (planId: number, sid: number | 'default') => `taskmoor.grid.${planId}.${sid}`;

function loadCollapsed(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsed(key: string, keys: readonly string[]): void {
  try {
    if (keys.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(keys));
  } catch {
    // Not remembered in this browser; the rows still stay as chosen until the page closes.
  }
}

/** A group's field in words: the plan's own groupings, or a custom field's name. */
function useGroupFieldName(fields: readonly SearchField[]): (field: string) => string {
  const t = useT();
  return (field) => {
    if (field in GROUP_LABELS) return t(GROUP_LABELS[field as PlanGroup]);
    const id = customFieldId(field);
    const found = id === null ? undefined : fields.find((f) => f.id === id);
    return found ? fieldName(t, found.name) : field;
  };
}

/** What the dialog is open for. */
type Editing =
  | { kind: 'new' }
  | { kind: 'edit'; structure: StructureSummary }
  | { kind: 'default' };

/** Where keyboard focus stands in the tree: a skeleton row, and -1 for the row or a cell's index. */
interface Focus {
  row: number;
  col: number;
}

/**
 * A plan's Grid (T-089a; PLN-010; ADR-122 stage 10): the plan's tickets as a tree built from a
 * saved structure, chosen in the address (`structure=`), or the unsaved default when the plan has
 * none. Rows open expanded; collapsed rows are kept per viewer in this browser only. Ticket columns
 * edit in place through the ticket route (`Cell`); totals and formula columns are computed in the
 * browser from the rows shown, so an edit refreshes the totals above it at once, and the cells in
 * view of the rows above are read again, since the server recomputed their stored formula fields.
 * A hidden ticket is never a row: it is only counted ("+N not shown"). Inside a scenario the Grid
 * shows live values and is read-only. A read that runs too long is refused, never shown in part.
 *
 * On a desktop it is a `treegrid` drawn in a window of rows, the header row and the tree column
 * staying in view; on a phone a windowed list of cards, each opening a sheet with every column.
 */
export function PlanGridPage({ planId, view, scenario, client, search }: PlanGridPageProps) {
  const t = useT();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [list, setList] = useState<StructureList | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [answer, setAnswer] = useState<GridAnswer | null>(null);
  // The read the answer shown came from, and the ticket whose row takes focus in it: only the
  // read that follows a move keeps the moved row in focus; any later read starts at the top.
  const [shownRead, setShownRead] = useState<{ read: number; focus: number | null }>({
    read: 0,
    focus: null,
  });
  const [readProblem, setReadProblem] = useState<'timeout' | 'failed' | null>(null);
  const [reads, setReads] = useState(0);
  const [fields, setFields] = useState<SearchField[]>([]);
  const [levels, setLevels] = useState<LevelName[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // The ticket just moved: its row keeps focus when the skeleton read again behind arrives.
  const moveFocus = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after each change, by `listVersion`
  useEffect(() => {
    let live = true;
    client.list(planId).then(
      (l) => {
        if (!live) return;
        setList(l);
        setListFailed(false);
      },
      () => live && setListFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, planId, listVersion]);
  useEffect(() => {
    let live = true;
    search.fields().then(
      (f) => live && setFields(f),
      () => {},
    );
    client.levels().then(
      (l) => live && setLevels(l),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [search, client]);

  // The structure shown: the one the address names, else the plan's first, else the default.
  const asked = view.structure;
  const named = asked === undefined ? undefined : list?.structures.find((s) => s.id === asked);
  const shown: StructureSummary | null = named ?? list?.structures[0] ?? null;
  const sid: number | 'default' | null = list === null ? null : (shown?.id ?? 'default');
  const gone = list !== null && asked !== undefined && named === undefined;
  const filtersKey = JSON.stringify(view.filters);
  const scenarioId = scenario?.id;

  // Each read is numbered here; an answer that comes back after a newer one is dropped. The
  // skeleton's own `generation` is not compared: each server process counts its own, so two
  // processes behind one address give numbers that say nothing of which answer is newer.
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for the filters, the scenario and Refresh
  useEffect(() => {
    if (sid === null) return;
    const ask = ++latest.current;
    const focusFor = moveFocus.current;
    moveFocus.current = null;
    setReadProblem(null);
    client.rows(planId, sid, { filters: view.filters, scenario: scenarioId }).then(
      (a) => {
        if (ask !== latest.current) return;
        setAnswer(a);
        setShownRead({ read: ask, focus: focusFor });
      },
      (error) => {
        if (ask !== latest.current) return;
        setAnswer(null);
        setReadProblem(isTimeout(error) ? 'timeout' : 'failed');
      },
    );
  }, [client, planId, sid, filtersKey, scenarioId, reads]);

  const choose = (next: number | undefined) =>
    navigate(planHref(planId, 'grid', { ...view, structure: next }));
  const refusal = (r: { code: string; limit?: number }) =>
    t(STRUCTURE_REFUSED[r.code] ?? 'grid.refused.other', {
      count: r.limit ?? list?.limits.structures ?? 20,
    });
  const remove = async (s: StructureSummary) => {
    setProblem(null);
    const r = await client.remove(planId, s.id, s.version).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? refusal(r) : t('grid.refused.other'));
      if (r?.code === 'version_conflict') setListVersion((v) => v + 1);
      throw new Error('refused');
    }
    setStatus(t('grid.delete.done', { name: s.name }));
    setListVersion((v) => v + 1);
    choose(undefined);
  };

  if (listFailed && !list) {
    return (
      <p className="board-problem" role="alert">
        {t('grid.listFailed')}
      </p>
    );
  }
  if (!list) return <p className="report-loading">{t('grid.loading')}</p>;
  const full = list.structures.length >= list.limits.structures;
  // Inside a scenario nothing here changes a ticket (question 16); structures are the plan's.
  const readOnly = scenario !== null || answer?.live === true;
  const spec = answer?.structure.spec ?? shown?.spec ?? list.default;

  return (
    <section className="plan-grid" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="visually-hidden">
        {t('plans.section.grid')}
      </h2>
      <div className="plan-grid-tools">
        {list.structures.length > 0 && (
          <label className="form-field" htmlFor={`${id}-structure`}>
            <span className="form-label">{t('grid.structure')}</span>
            <select
              id={`${id}-structure`}
              value={shown?.id ?? ''}
              onChange={(event) => choose(Number(event.target.value))}
            >
              {list.structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.broken ? t('grid.structure.broken', { name: s.name }) : s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="plan-grid-actions">
          <button type="button" className="button-secondary" onClick={() => setReads((r) => r + 1)}>
            {t('grid.refresh')}
          </button>
          {list.editable && (
            <button
              type="button"
              className="button-secondary"
              aria-disabled={full || undefined}
              aria-describedby={full ? `${id}-full` : undefined}
              onClick={() => {
                if (!full) setEditing({ kind: 'new' });
              }}
            >
              {t('grid.new')}
            </button>
          )}
          {list.editable && (
            <button
              type="button"
              className="button-secondary"
              onClick={() =>
                setEditing(shown ? { kind: 'edit', structure: shown } : { kind: 'default' })
              }
            >
              {shown ? t('grid.edit') : t('grid.saveDefault')}
            </button>
          )}
          {list.editable && shown && (
            <DangerAction
              label={t('grid.delete')}
              name={t('grid.delete.label', { name: shown.name })}
              outcome={t('grid.delete.ask', { name: shown.name })}
              confirmLabel={t('grid.delete.label', { name: shown.name })}
              onConfirm={() => remove(shown)}
            />
          )}
        </div>
      </div>
      {full && list.editable && (
        <p id={`${id}-full`} className="board-hint">
          {t('grid.full', { count: list.limits.structures })}
        </p>
      )}
      {!shown && (
        <p className="board-hint">{list.editable ? t('grid.unsaved') : t('grid.unsaved.reader')}</p>
      )}
      {gone && <p className="board-hint">{t('grid.structureGone')}</p>}
      {readOnly && <p className="board-hint scenario-live-note">{t('grid.live')}</p>}
      <p className="board-hint scenario-status" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {readProblem === 'timeout' ? (
        <div className="board-problem" role="alert">
          <p>{t('grid.timeout')}</p>
          <button type="button" className="button-secondary" onClick={() => setReads((r) => r + 1)}>
            {t('grid.tryAgain')}
          </button>
        </div>
      ) : readProblem === 'failed' ? (
        <p className="board-problem" role="alert">
          {t('grid.failed')}
        </p>
      ) : answer === null ? (
        <p className="report-loading">{t('grid.loading')}</p>
      ) : (
        <GridBody
          key={shownRead.read}
          planId={planId}
          answer={answer}
          columns={spec.columns}
          compact={compact}
          readOnly={readOnly}
          client={client}
          search={search}
          fields={fields}
          levels={levels}
          focusTicket={shownRead.focus}
          onStatus={setStatus}
          onMoved={(ticket) => {
            moveFocus.current = ticket;
            setReads((r) => r + 1);
          }}
        />
      )}
      {editing && (
        <StructureDialog
          planId={planId}
          client={client}
          list={list}
          fields={fields}
          structure={editing.kind === 'edit' ? editing.structure : null}
          initial={
            editing.kind === 'edit'
              ? editing.structure.spec
              : editing.kind === 'default'
                ? list.default
                : undefined
          }
          refusal={refusal}
          onDone={(saved, made) => {
            setEditing(null);
            setStatus(
              made
                ? t('grid.saved.made', { name: saved.name })
                : t('grid.saved.changed', { name: saved.name }),
            );
            setListVersion((v) => v + 1);
            if (made) choose(saved.id);
            else setReads((r) => r + 1);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

interface BodyProps {
  planId: number;
  answer: GridAnswer;
  columns: readonly StructureColumn[];
  compact: boolean;
  readOnly: boolean;
  client: GridClient;
  search: SearchClient;
  fields: readonly SearchField[];
  levels: readonly LevelName[];
  /** A ticket whose row takes focus when drawn, if focus was in the grid: the one just moved. */
  focusTicket: number | null;
  /** Says what happened, in the page's status line. */
  onStatus: (text: string) => void;
  /** A row moved: the page reads the skeleton again behind. */
  onMoved: (ticket: number) => void;
}

/** A move asked for: the row, its ticket as last read, and the new parent if already chosen. */
interface Moving {
  row: number;
  ticket: SearchTicket;
  /** A row dropped on, -1 for Remove from parent; left out, the dialog offers rows to choose. */
  target?: number;
}

/** A column as drawn: its place in the structure and what it is. */
interface Drawn {
  index: number;
  column: StructureColumn;
}

/**
 * The browser's own context menu, which the menu key opens on its keyup (Chrome and Edge on
 * Windows) whatever its keydown did, is cancelled once in the next second, so it cannot open over
 * the row's menu that the keydown opened. A right click is left alone.
 */
function swallowNativeMenu() {
  const stop = (event: Event) => {
    event.preventDefault();
    done();
  };
  const done = () => {
    window.removeEventListener('contextmenu', stop, true);
    window.clearTimeout(timer);
  };
  window.addEventListener('contextmenu', stop, true);
  const timer = window.setTimeout(done, 1000);
}

/** The binary search of a skeleton row among the rows shown (they are in preorder). */
function shownIndex(visible: Int32Array, row: number): number {
  let lo = 0;
  let hi = visible.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = visible[mid] as number;
    if (at === row) return mid;
    if (at < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The tree, its cells and the rows in view's tickets, for one skeleton. */
function GridBody({
  planId,
  answer,
  columns,
  compact,
  readOnly,
  client,
  search,
  fields,
  levels,
  focusTicket,
  onStatus,
  onMoved,
}: BodyProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const nameOf = useColumnName(fields);
  const refName = useRefName(fields);
  const groupFieldName = useGroupFieldName(fields);
  // The browser's own copy of the totals; an edit changes it in place and `tick` draws it again.
  const base = useMemo<GridCompute>(() => computeGrid(answer, columns), [answer, columns]);
  // After a move the rows are moved here at once, until the skeleton read again behind arrives.
  const [after, setAfter] = useState<{ base: GridCompute; grid: GridCompute } | null>(null);
  const grid = after?.base === base ? after.grid : base;
  const [tick, setTick] = useState(0);
  const { tree, skeleton } = grid;
  const n = tree.n;
  const store = storageKey(planId, answer.structure.id ?? 'default');
  const keys = useMemo(() => rowKeys(skeleton, tree), [skeleton, tree]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() =>
    collapsedFromKeys(skeleton, tree, loadCollapsed(store)),
  );
  const setAndKeep = (next: ReadonlySet<number>) => {
    // A focused row hidden under a closed row hands focus to the highest closed row above it,
    // which is shown, so the grid keeps its one stop for Tab.
    let shownAbove = -1;
    for (let at = tree.parent[focus.row] as number; at < n; at = tree.parent[at] as number) {
      if (next.has(at)) shownAbove = at;
    }
    if (shownAbove >= 0) setFocus({ row: shownAbove, col: -1 });
    setCollapsed(next);
    saveCollapsed(
      store,
      [...next].map((r) => keys[r] as string),
    );
  };
  const toggle = (row: number) => {
    const next = new Set(collapsed);
    if (next.has(row)) next.delete(row);
    else next.add(row);
    setAndKeep(next);
  };
  const visible = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed]);
  const rowOfTicket = useMemo(() => {
    const m = new Map<number, number>();
    skeleton.rows.ticket.forEach((ticket, row) => {
      if (ticket > 0) m.set(ticket, row);
    });
    return m;
  }, [skeleton]);

  // The columns drawn: the key sits in the tree column, so a key column is not drawn twice.
  const drawn: Drawn[] = columns.flatMap((column, index) =>
    column.kind === 'ticket' && column.field === 'key' ? [] : [{ index, column }],
  );
  const problems = useMemo(() => {
    const out = new Map<number, ColumnProblem | StructureProblem>(columnProblems(grid));
    for (const p of answer.problems) {
      const m = /^columns\.(\d+)$/.exec(p.path);
      if (m) out.set(Number(m[1]), p);
    }
    return out;
  }, [grid, answer.problems]);
  const stepProblems = answer.problems.filter((p) => !p.path.startsWith('columns.'));

  // Keyboard focus, by skeleton row; it stays drawn while scrolled away. A row just moved keeps
  // it when this grid is drawn again from the skeleton read behind, if it was in the grid.
  const [focus, setFocus] = useState<Focus>(() => {
    const at = focusTicket === null ? -1 : skeleton.rows.ticket.indexOf(focusTicket);
    return { row: Math.max(0, at), col: -1 };
  });
  const moved = useRef(
    focusTicket !== null &&
      typeof document !== 'undefined' &&
      (document.activeElement === null ||
        document.activeElement === document.body ||
        document.activeElement.closest('.plan-grid-table') !== null),
  );
  /** A row to bring into view once drawn: the moved row in its new place. */
  const scrollTo = useRef<number | null>(focusTicket === null ? null : focus.row);
  const focusShown = Math.max(0, shownIndex(visible, focus.row));
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  // A card is 120 px unless its words need more (two facts and two marks, or larger text): the
  // tallest card drawn sets every card's height, so the window's rows stay one height.
  const [cardHeight, setCardHeight] = useState(CARD_ROW);
  useLayoutEffect(() => {
    if (!compact) return;
    let need = cardHeight;
    for (const card of scroller.current?.querySelectorAll<HTMLElement>('.plan-grid-card') ?? []) {
      need = Math.max(need, cardHeight + card.scrollHeight - card.clientHeight);
    }
    if (need > cardHeight) setCardHeight(Math.min(CARD_MOST, Math.ceil(need)));
  });
  const rowHeight = compact ? cardHeight : undefined;
  // The sticky header and "All rows" footer cover the scroller's top and foot: a row scrolled to
  // shows between them, and focus scrolls a row clear of them (scroll padding).
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when a phone's cards take the table's place, or give it back
  useLayoutEffect(() => {
    const el = table.current;
    if (!el) return;
    const measure = () => {
      const top = el.tHead?.offsetHeight ?? 0;
      const bottom = el.tFoot?.offsetHeight ?? 0;
      setEdges((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }));
    };
    measure();
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (el.tHead) resized?.observe(el.tHead);
    if (el.tFoot) resized?.observe(el.tFoot);
    return () => resized?.disconnect();
  }, [compact]);
  const win = useRowWindow(scroller, visible.length, {
    keep: focusShown,
    offset: edges.top,
    bottom: edges.bottom,
    ...(rowHeight ? { rowHeight } : {}),
  });
  const runs = useMemo(() => {
    const out: number[] = [];
    if (win.pinned >= 0 && win.pinned < win.first) out.push(win.pinned);
    for (let i = win.first; i < win.last; i++) out.push(i);
    if (win.pinned >= win.last) out.push(win.pinned);
    return out;
  }, [win.first, win.last, win.pinned]);

  // A row moved is brought into view in its new place, once the rows shown include it.
  useEffect(() => {
    const row = scrollTo.current;
    if (row === null) return;
    scrollTo.current = null;
    const at = shownIndex(visible, row);
    if (at >= 0) win.scrollToRow(at);
  });

  // The tickets of the rows drawn, read by window, 500 at a time; about 5,000 are kept.
  const cache = useRef(new Map<number, SearchTicket>());
  const pending = useRef(new Set<number>());
  // Tickets of the rows above an edit, read again because the server recomputed their stored
  // formula fields: when they arrive, their values replace the skeleton's, so formula columns
  // that read those fields agree with the ticket columns beside them.
  const restale = useRef(new Set<number>());
  const gridNow = useRef(grid);
  gridNow.current = grid;
  const [cells, setCells] = useState(0);
  const wanted = runs
    .map((i) => skeleton.rows.ticket[visible[i] as number] as number)
    .filter((ticket) => ticket > 0 && !cache.current.has(ticket) && !pending.current.has(ticket));
  const wantedKey = wanted.join(',');
  // Cells that arrive draw the grid again while it is shown, even after the rows wanted changed:
  // once a read is sent its tickets are pending, so the rows wanted change at the next drawing,
  // and the answer must not be dropped then, or those rows would stay loading.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the rows wanted change
  useEffect(() => {
    if (wanted.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const ticket of wanted) pending.current.add(ticket);
      for (let at = 0; at < wanted.length; at += CELL_BATCH) {
        const batch = wanted.slice(at, at + CELL_BATCH);
        client.tickets(planId, batch).then(
          (tickets) => {
            for (const ticket of batch) pending.current.delete(ticket);
            for (const ticket of tickets) cache.current.set(ticket.id, ticket);
            const now = gridNow.current;
            const edits = tickets.flatMap((ticket) => {
              if (!restale.current.delete(ticket.id)) return [];
              const row = now.skeleton.rows.ticket.indexOf(ticket.id);
              return row < 0 ? [] : [editOfTicket(now, row, savedTicketOf(ticket))];
            });
            if (edits.length > 0) applyEdits(now, edits);
            const keep = new Set(wanted);
            for (const held of cache.current.keys()) {
              if (cache.current.size <= CELL_CACHE) break;
              if (!keep.has(held)) cache.current.delete(held);
            }
            if (mounted.current) setCells((c) => c + 1);
          },
          () => {
            for (const ticket of batch) pending.current.delete(ticket);
          },
        );
      }
    }, CELL_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [wantedKey, client, planId]);

  /** A cell saved: the totals above recompute; the cells in view of the rows above are read again. */
  const onSaved = useCallback(
    (ticket: SearchTicket) => {
      cache.current.set(ticket.id, ticket);
      const row = rowOfTicket.get(ticket.id);
      if (row !== undefined) {
        const touched = applyEdit(grid, editOfTicket(grid, row, savedTicketOf(ticket)));
        for (const r of touched) {
          if (r === row || r >= n) continue;
          const above = skeleton.rows.ticket[r] as number;
          if (above > 0) {
            cache.current.delete(above);
            restale.current.add(above);
          }
        }
      }
      setTick((v) => v + 1);
    },
    [grid, rowOfTicket, n, skeleton],
  );

  const [priorities, setPriorities] = useState<
    { id: number; name: string; level?: number }[] | null
  >(null);
  const wantsPriorities = columns.some((c) => c.kind === 'ticket' && c.field === 'priority');
  useEffect(() => {
    if (!wantsPriorities || readOnly) return;
    let live = true;
    search.priorities().then(
      (l) => live && setPriorities(l),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [search, wantsPriorities, readOnly]);

  const [sheet, setSheet] = useState<number | null>(null);

  // --- Moving a row (acceptance 2): one at a time, after confirmation, by the ticket's change ---
  const [moving, setMoving] = useState<Moving | null>(null);
  /** The row a drag holds, and the row under the pointer with why it cannot be the parent. */
  const [inHand, setInHand] = useState<number | null>(null);
  const [over, setOver] = useState<{ row: number; problem: MoveProblem | null } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  /** Where focus goes once the move dialog closes: the moved row, else where it was. */
  const movedTo = useRef<number | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const ticketOf = (row: number) => skeleton.rows.ticket[row] as number;
  const keyOf = (row: number) => skeleton.rows.key[row] as string;
  const levelName = (rank: number) => levels.find((l) => l.rank === rank)?.name ?? '';
  /** Rows a person may pick up: ticket rows, outside a scenario, not placed by a link. */
  const movable = (row: number) =>
    !readOnly && tree.isTicket[row] === 1 && !placedByLink(skeleton.rows.via[row] as number);

  /**
   * Why `row` cannot move under `target` (-1: Remove from parent), before the server is asked:
   * the levels and tracks of `moveProblem`, and the ticket's own parent as last read, which may sit
   * outside the grid.
   */
  const whyNot = (row: number, target: number): MoveProblem | null => {
    const own = cache.current.get(ticketOf(row))?.parent as { id: number } | null | undefined;
    if (target === -1) {
      if (!tree.isTicket[row]) return 'group_row';
      if (placedByLink(skeleton.rows.via[row] as number)) return 'placed_by_link';
      if ((skeleton.rows.level[row] as number) === -1) return 'required';
      const above = tree.parent[row] as number;
      const hasParent = own === undefined ? above < n && tree.isTicket[above] === 1 : own !== null;
      return hasParent ? null : 'same_parent';
    }
    const p = moveProblem(skeleton, tree, row, target);
    if (p) return p;
    return own && own.id === ticketOf(target) ? 'same_parent' : null;
  };
  const problemText = (p: MoveProblem, row: number) => {
    if (p === 'wrong_level') {
      const up = levelName((skeleton.rows.level[row] as number) + 1);
      if (up) return t('grid.move.no.levelNamed', { level: up });
    }
    return t(MOVE_PROBLEM[p]);
  };

  /** Opens the move of a row: its ticket as last read, read now if not held. */
  const openMove = (row: number, target?: number) => {
    const id = ticketOf(row);
    const open = (ticket: SearchTicket) =>
      setMoving(target === undefined ? { row, ticket } : { row, ticket, target });
    const held = cache.current.get(id);
    if (held) {
      open(held);
      return;
    }
    client.tickets(planId, [id]).then(
      (found) => {
        const ticket = found.find((f) => f.id === id);
        if (!ticket) {
          onStatus(t('grid.move.readFailed', { key: keyOf(row) }));
          return;
        }
        cache.current.set(id, ticket);
        open(ticket);
      },
      () => onStatus(t('grid.move.readFailed', { key: keyOf(row) })),
    );
  };

  /**
   * Sends the move through the ticket's own change, with its version. Once saved, the rows move
   * here at once, the new parent opens, and the skeleton is read again behind; a refusal is said
   * in the dialog and nothing moves. A stale version reads the ticket again, for another try.
   */
  const sendMove = async (m: Moving, target: number): Promise<string | null> => {
    const key = keyOf(m.row);
    let updated: SearchTicket;
    try {
      updated = await search.edit(m.ticket.id, {
        parent: target === -1 ? null : ticketOf(target),
        ...(m.ticket.version !== undefined ? { version: m.ticket.version } : {}),
      });
    } catch (error) {
      const refused = moveRefusal(error);
      if (refused.stale) {
        cache.current.delete(m.ticket.id);
        const again = await client.tickets(planId, [m.ticket.id]).catch(() => []);
        const fresh = again.find((f) => f.id === m.ticket.id);
        if (fresh) {
          cache.current.set(fresh.id, fresh);
          setMoving((was) => (was && was.row === m.row ? { ...was, ticket: fresh } : was));
        }
      }
      return t(refused.id, { key });
    }
    cache.current.set(updated.id, updated);
    const above = tree.parent[m.row] as number;
    // Removed from a parent the grid does not show: its row stays where it is.
    const stays = target === -1 && (above >= n || tree.isTicket[above] !== 1);
    if (!stays) {
      const next = moveRow(grid, m.row, target);
      const kept = [...collapsed].map((r) => keys[r] as string);
      const nextKeys = rowKeys(next.skeleton, next.tree);
      const placed = next.skeleton.rows.ticket.indexOf(updated.id);
      const opened = collapsedFromKeys(next.skeleton, next.tree, kept);
      // Its new parent opens, so the row moved is in view.
      for (let at = next.tree.parent[placed] as number; at < next.tree.n; ) {
        opened.delete(at);
        at = next.tree.parent[at] as number;
      }
      setAfter({ base, grid: next });
      setCollapsed(opened);
      saveCollapsed(
        store,
        [...opened].map((r) => nextKeys[r] as string),
      );
      setFocus({ row: placed, col: -1 });
      movedTo.current = placed;
      scrollTo.current = placed;
    } else {
      movedTo.current = m.row;
    }
    onStatus(
      target === -1
        ? t('grid.move.removed', { key })
        : t('grid.move.done', { key, to: keyOf(target) }),
    );
    setMoving(null);
    onMoved(updated.id);
    return null;
  };

  /** The rows offered as the new parent for the text typed: those that can be, unless searched. */
  const candidates = (row: number) => (text: string) => {
    const want = text.trim().toLocaleLowerCase();
    const list: MoveCandidate[] = [];
    let more = 0;
    for (let at = 0; at < n; at++) {
      if (!tree.isTicket[at] || at === row) continue;
      const key = keyOf(at);
      const summary = cache.current.get(ticketOf(at))?.summary ?? null;
      if (
        want !== '' &&
        !key.toLocaleLowerCase().includes(want) &&
        !(summary ?? '').toLocaleLowerCase().includes(want)
      ) {
        continue;
      }
      const p = whyNot(row, at);
      // Unsearched, only the rows that can be the parent; searched, the others say why not.
      if (p !== null && want === '') continue;
      if (list.length >= MOVE_PAGE) {
        more++;
        continue;
      }
      list.push({
        row: at,
        key,
        summary,
        level: levelName(skeleton.rows.level[at] as number),
        problem: p === null ? null : problemText(p, row),
      });
    }
    return { list, more };
  };

  /** A row's menu, from its grip, Shift and F10 or the menu key, and a phone's sheet. */
  const moveItems = (row: number): MoveMenuItem[] => {
    const items: MoveMenuItem[] = [
      { key: 'under', label: t('grid.move.under'), onSelect: () => openMove(row) },
    ];
    const p = whyNot(row, -1);
    if (p === null || p === 'required') {
      items.push({
        key: 'remove',
        label: t('grid.move.remove'),
        onSelect: () => openMove(row, -1),
      });
    }
    return items;
  };

  const rowAt = (x: number, y: number): number | null => {
    const tr = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('tr[data-row]');
    return tr && table.current?.contains(tr) ? Number(tr.dataset.row) : null;
  };
  /**
   * A press on a row's grip that may become a drag: let go on a row that can be its parent, the
   * move is asked for as Move under would ask; on any other, it says why and nothing moves.
   */
  function beginDrag(event: React.PointerEvent<HTMLButtonElement>, row: number) {
    if (stopDrag.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const key = keyOf(row);
    const done = () => {
      setInHand(null);
      setOver(null);
    };
    const scrollFirst = window.matchMedia?.(COARSE_QUERY).matches === true;
    stopDrag.current = followPointerDrag(
      event,
      {
        start: (x, y) => {
          setInHand(row);
          onStatus(t('grid.move.drag.start', { key }));
          if (ghost.current) ghost.current.style.transform = ghostAt(x, y);
        },
        move: (x, y) => {
          if (ghost.current) ghost.current.style.transform = ghostAt(x, y);
          const at = rowAt(x, y);
          const next = at === null ? null : { row: at, problem: whyNot(row, at) };
          setOver((was) => (was?.row === next?.row && was?.problem === next?.problem ? was : next));
        },
        drop: (x, y) => {
          const at = rowAt(x, y);
          done();
          if (at === null || at === row) {
            onStatus(t('grid.move.drag.cancelled', { key }));
            return;
          }
          const p = whyNot(row, at);
          if (p) onStatus(t('grid.move.drag.refused', { key, reason: problemText(p, row) }));
          else openMove(row, at);
        },
        cancel: () => {
          done();
          onStatus(t('grid.move.drag.cancelled', { key }));
        },
        end: () => {
          stopDrag.current = null;
        },
      },
      { scrollFirst },
    );
  }

  // Keyboard focus follows `focus` once the person moved it; the grid is one stop for Tab.
  // On each drawing, where focus is meant to be.
  useLayoutEffect(() => {
    const body = table.current?.tBodies[0];
    if (!body) return;
    const tr = body.querySelector<HTMLTableRowElement>(`tr[data-row="${focus.row}"]`);
    const target =
      focus.col < 0 || !tr ? tr : ((tr.cells[focus.col] as HTMLElement | undefined) ?? tr);
    for (const cell of body.querySelectorAll<HTMLElement>('th, td')) {
      if (cell !== target) cell.removeAttribute('tabindex');
    }
    if (target && target !== tr) target.tabIndex = 0;
    // Controls inside the cells are reached through their cell, so Tab leaves the grid at once.
    for (const control of body.querySelectorAll<HTMLElement>('a, button')) {
      control.tabIndex = target?.contains(control) && target !== tr ? 0 : -1;
    }
    if (moved.current && target) {
      moved.current = false;
      target.focus();
    }
  });

  const go = (row: number, col: number) => {
    moved.current = true;
    setFocus({ row, col });
    const at = shownIndex(visible, row);
    if (at >= 0) win.scrollToRow(at);
  };
  const lastCol = drawn.length;
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement;
    // Typing in a cell's editor is the editor's own, and a row's grip and menu take their keys.
    if (target.closest('form, .move-grip')) return;
    const at = focusShown;
    const row = visible[at] as number;
    const expandable = (tree.end[row] as number) > row + 1;
    const ctrl = event.ctrlKey || event.metaKey;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        if (at + 1 < visible.length) go(visible[at + 1] as number, focus.col);
        break;
      case 'ArrowUp':
        if (at > 0) go(visible[at - 1] as number, focus.col);
        break;
      case 'PageDown':
        go(visible[Math.min(visible.length - 1, at + 10)] as number, focus.col);
        break;
      case 'PageUp':
        go(visible[Math.max(0, at - 10)] as number, focus.col);
        break;
      case 'ArrowRight':
        if (focus.col < 0 && expandable && collapsed.has(row)) toggle(row);
        else go(row, Math.min(lastCol, focus.col + 1));
        break;
      case 'ArrowLeft':
        if (focus.col >= 0) go(row, focus.col - 1);
        else if (expandable && !collapsed.has(row)) toggle(row);
        else if ((tree.parent[row] as number) < n) go(tree.parent[row] as number, -1);
        break;
      case 'Home':
        if (ctrl) go(visible[0] as number, focus.col);
        else go(row, 0);
        break;
      case 'End':
        if (ctrl) go(visible[visible.length - 1] as number, focus.col);
        else go(row, lastCol);
        break;
      case 'Enter': {
        const cell = table.current?.tBodies[0]?.querySelector<HTMLTableRowElement>(
          `tr[data-row="${row}"]`,
        )?.cells[focus.col];
        const edit = cell?.querySelector<HTMLButtonElement>('.search-cell-edit');
        if (edit) edit.click();
        else if (focus.col < 0 && expandable) toggle(row);
        else handled = false;
        break;
      }
      case 'F10':
      case 'ContextMenu':
        if (event.key === 'F10' && !event.shiftKey) handled = false;
        else {
          swallowNativeMenu();
          openRowMenu(row);
        }
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };
  /** Shift and F10, or the menu key: the row's menu, as its grip opens it; or why it has none. */
  const openRowMenu = (row: number) => {
    if (readOnly || !tree.isTicket[row]) return;
    if (!movable(row)) {
      onStatus(t('grid.move.byLink', { key: keyOf(row) }));
      return;
    }
    table.current?.tBodies[0]
      ?.querySelector<HTMLButtonElement>(`tr[data-row="${row}"] .move-grip-handle`)
      ?.click();
  };
  const onFocusIn = (event: React.FocusEvent<HTMLElement>) => {
    const tr = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-row]');
    if (!tr) return;
    const row = Number(tr.dataset.row);
    const cell = (event.target as HTMLElement).closest('th, td');
    const col =
      cell && cell !== tr && tr.contains(cell)
        ? Array.from(tr.cells).indexOf(cell as HTMLTableCellElement)
        : -1;
    if (row !== focus.row || col !== focus.col) setFocus({ row, col });
  };

  if (n === 0) {
    return (
      <EmptyState title={t('grid.empty')}>
        {stepProblems.length > 0 ? t('grid.emptyBroken') : t('grid.emptyBody')}
      </EmptyState>
    );
  }

  // --- What a cell says -------------------------------------------------------------------------
  const hours = (seconds: number) =>
    t('grid.hours', { hours: Math.round((seconds / 3600) * 10) / 10 });
  const dayOf = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const valueText = (type: string, value: number) =>
    type === 'duration'
      ? hours(value)
      : type === 'date'
        ? dayOf(value)
        : intl.formatNumber(value, { maximumFractionDigits: 2 });
  const totalText = (cell: TotalCell | null): { main: string; partial?: string; bar?: number } => {
    if (!cell) return { main: '' };
    if (cell.kind === 'count') return { main: intl.formatNumber(cell.count) };
    if (cell.kind === 'progress') {
      if (cell.of === 0) return { main: '' };
      return {
        main: t('grid.progress', { closed: cell.closed, of: cell.of }),
        bar: cell.closed / cell.of,
      };
    }
    const main = cell.value === null ? '' : valueText(cell.type, cell.value);
    return !cell.leaf && cell.of > 0 && cell.valued < cell.of
      ? { main, partial: t('grid.partial', { valued: cell.valued, of: cell.of }) }
      : { main };
  };
  const formulaText = (column: StructureColumn, value: number | string | null): string => {
    if (value === null || column.kind !== 'formula') return '';
    if (typeof value === 'string') {
      return column.output === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? intl.formatDate(`${value}T00:00:00Z`, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : value;
    }
    if (column.output === 'duration') return hours(value);
    return intl.formatNumber(value, {
      minimumFractionDigits: column.decimals,
      maximumFractionDigits: column.decimals,
    });
  };
  const headerOf = (d: Drawn): { name: string; note?: string } => {
    const c = d.column;
    if (c.kind === 'ticket') return { name: nameOf(c.field) };
    if (c.kind === 'formula') return { name: c.name, note: t('grid.column.formula') };
    const below = t('grid.total.below');
    if (c.fn === 'count') return { name: t('grid.total.count'), note: below };
    if (c.fn === 'progress') return { name: t('grid.total.progress'), note: below };
    const of = refName(c.of ?? '');
    const dated = skeleton.fields.some((f) => f.ref === c.of && f.type === 'date');
    const word: MessageId =
      c.fn === 'sum'
        ? 'grid.total.sum'
        : c.fn === 'min'
          ? dated
            ? 'grid.total.earliest'
            : 'grid.total.min'
          : dated
            ? 'grid.total.latest'
            : 'grid.total.max';
    return { name: t(word, { field: of }), note: below };
  };
  const brokenText = (p: ColumnProblem | StructureProblem) =>
    'code' in p
      ? t('grid.column.broken', { reason: p.message })
      : p.error
        ? t('grid.column.broken', { reason: p.error.message })
        : t('grid.column.gone');
  const rowLabel = (row: number) => {
    if (tree.isTicket[row]) return skeleton.rows.key[row] as string;
    return groupText(row);
  };
  const groupOf = new Map(skeleton.groups.map((g) => [g.row, g]));
  function groupText(row: number) {
    const g = groupOf.get(row);
    if (!g) return '';
    return t('grid.group', {
      field: groupFieldName(g.field),
      value: g.label === null ? t('grid.noValue') : g.label === '' ? t('grid.unnamed') : g.label,
    });
  }
  /** The marks beside a row: outside the plan, hidden below, shown elsewhere, placed by a link. */
  const marks = (row: number) => {
    const out: string[] = [];
    if (!tree.isTicket[row]) return out;
    if (!skeleton.rows.inPlan[row]) out.push(t('grid.notInPlan'));
    const hidden = grid.hiddenBelow[row] as number;
    if (hidden > 0) out.push(t('grid.notShown', { count: hidden }));
    const elsewhere = skeleton.rows.elsewhere[row] as number;
    if (elsewhere > 0) out.push(t('grid.elsewhere', { count: elsewhere }));
    if (placedByLink(skeleton.rows.via[row] as number)) out.push(t('grid.byLink'));
    return out;
  };

  /** One structure column's cell for a row (`n`: the last row, which totals the top rows). */
  const cellFor = (d: Drawn, row: number, ticket: SearchTicket | undefined) => {
    const c = d.column;
    const broken = problems.get(d.index);
    if (broken) return <td key={d.index} className="plan-grid-cell" data-broken="true" />;
    if (c.kind === 'ticket') {
      if (row >= n || !tree.isTicket[row]) return <td key={d.index} className="plan-grid-cell" />;
      if (!ticket) {
        return (
          <td key={d.index} className="plan-grid-cell">
            <span className="plan-grid-quiet">
              <span className="visually-hidden">{t('grid.cellLoading')}</span>
            </span>
          </td>
        );
      }
      return (
        <Cell
          key={d.index}
          ticket={ticket}
          column={c.field}
          columnName={nameOf(c.field)}
          // The parent changes with Move under, never in a cell.
          editor={readOnly || c.field === 'parent' ? null : cellEditor(c.field, fields)}
          dateTime={isDateTimeColumn(c.field, fields)}
          priorities={priorities}
          client={search}
          onSaved={onSaved}
          tone={null}
        />
      );
    }
    if (c.kind === 'formula') {
      return (
        <td key={d.index} className="plan-grid-cell plan-grid-number">
          {formulaText(c, formulaCell(grid, d.index, row))}
        </td>
      );
    }
    const text = totalText(totalCell(grid, d.index, row));
    return (
      <td key={d.index} className="plan-grid-cell plan-grid-number">
        {text.bar !== undefined && (
          <span className="plan-grid-bar" aria-hidden="true">
            <span style={{ inlineSize: `${Math.round(text.bar * 100)}%` }} />
          </span>
        )}
        <span>{text.main}</span>
        {text.partial && <span className="plan-grid-partial">{text.partial}</span>}
      </td>
    );
  };

  const problemList = (
    <>
      {answer.more && <p className="board-hint">{t('grid.more', { count: n })}</p>}
      {stepProblems.map((p) => (
        <p key={p.path} className="board-hint">
          {p.reason === 'invalid_query'
            ? t('grid.queryBroken', { message: p.message ?? '' })
            : t('grid.stepBroken')}
        </p>
      ))}
    </>
  );
  const sheetRow = sheet;

  const moveDialog = (() => {
    if (moving === null) return null;
    const m = moving;
    const parent = m.ticket.parent as { key?: string | null } | null | undefined;
    const from: MoveParent = parent ? (parent.key ? { key: parent.key } : 'hidden') : null;
    const blocked = m.target === undefined ? null : whyNot(m.row, m.target);
    return (
      <MoveUnderDialog
        moving={keyOf(m.row)}
        from={from}
        below={(tree.end[m.row] as number) - m.row - 1}
        {...(m.target === undefined
          ? { candidates: candidates(m.row) }
          : { target: m.target === -1 ? 'none' : { row: m.target, key: keyOf(m.target) } })}
        blocked={blocked === null ? null : problemText(blocked, m.row)}
        onMove={(target) => sendMove(m, target)}
        onClose={() => setMoving(null)}
        restoreFocus={(opener) => {
          const row = movedTo.current;
          movedTo.current = null;
          if (row !== null && !compact) {
            moved.current = true;
            setFocus({ row, col: -1 });
          } else opener?.focus();
        }}
      />
    );
  })();

  if (compact) {
    const first = drawn[0];
    const second = drawn[1];
    const facts = [first, second].filter(
      (d): d is Drawn =>
        d !== undefined && !(d.column.kind === 'ticket' && d.column.field === 'summary'),
    );
    return (
      <>
        {problemList}
        <GridButtons
          onExpand={() => setAndKeep(new Set())}
          onCollapse={() => setAndKeep(allCollapsible(tree))}
        />
        <div ref={scroller} className="plan-grid-cards-scroll">
          <ul className="plan-grid-cards" aria-label={t('grid.rows', { count: visible.length })}>
            {win.before > 0 && (
              <li aria-hidden="true" className="plan-grid-pad" style={{ blockSize: win.before }} />
            )}
            {runs.map((i) => {
              const row = visible[i] as number;
              const ticket = cache.current.get(skeleton.rows.ticket[row] as number);
              const depth = tree.depth[row] as number;
              const below = (tree.end[row] as number) > row + 1;
              const isTicket = tree.isTicket[row] === 1;
              const label = rowLabel(row);
              return (
                <li
                  key={row}
                  className="glass-card plan-grid-card"
                  style={
                    {
                      '--grid-indent': Math.min(depth, CARD_LEVELS),
                      blockSize: cardHeight,
                    } as React.CSSProperties
                  }
                >
                  {below ? (
                    <button
                      type="button"
                      className="plan-grid-card-toggle"
                      aria-expanded={!collapsed.has(row)}
                      aria-label={
                        collapsed.has(row)
                          ? t('grid.expandRow', { name: label })
                          : t('grid.collapseRow', { name: label })
                      }
                      onClick={() => toggle(row)}
                    >
                      <Chevron open={!collapsed.has(row)} />
                    </button>
                  ) : (
                    <span className="plan-grid-card-leaf" />
                  )}
                  {isTicket ? (
                    // Named by its words, "Open" and the key first: a name that left out the
                    // summary and facts it shows would not match what a speaking user reads.
                    <button
                      type="button"
                      className="plan-grid-card-open"
                      onClick={() => setSheet(row)}
                    >
                      <span className="visually-hidden">{t('grid.openCard', { key: label })}</span>
                      <span className="plan-grid-card-key">
                        <span aria-hidden="true">{label}</span>
                        {depth > CARD_LEVELS && (
                          <span className="plan-grid-card-level">
                            {levelName(skeleton.rows.level[row] as number)}
                          </span>
                        )}
                      </span>
                      <span className="plan-grid-card-summary">
                        {ticket ? ticket.summary : <span className="plan-grid-quiet" />}
                      </span>
                      {facts.map((d) => (
                        <span key={d.index} className="plan-grid-card-fact">
                          <span className="plan-grid-card-label">{headerOf(d).name}</span>
                          <span>{factText(d, row, ticket)}</span>
                        </span>
                      ))}
                      {marks(row).map((m) => (
                        <span key={m} className="plan-grid-mark">
                          {m}
                        </span>
                      ))}
                    </button>
                  ) : (
                    <span className="plan-grid-card-group">{label}</span>
                  )}
                </li>
              );
            })}
            {win.after > 0 && (
              <li aria-hidden="true" className="plan-grid-pad" style={{ blockSize: win.after }} />
            )}
          </ul>
        </div>
        {sheetRow !== null && (
          <RowSheet
            title={`${rowLabel(sheetRow)} ${cache.current.get(skeleton.rows.ticket[sheetRow] as number)?.summary ?? ''}`.trim()}
            marks={marks(sheetRow)}
            actions={movable(sheetRow) ? moveItems(sheetRow) : []}
            onAction={() => setSheet(null)}
            onClose={() => setSheet(null)}
          >
            {drawn.map((d) => {
              const header = headerOf(d);
              const broken = problems.get(d.index);
              return (
                <tr key={d.index}>
                  <th scope="row">
                    {header.name}
                    {broken && <span className="plan-grid-head-note">{brokenText(broken)}</span>}
                  </th>
                  {cellFor(
                    d,
                    sheetRow,
                    cache.current.get(skeleton.rows.ticket[sheetRow] as number),
                  )}
                </tr>
              );
            })}
          </RowSheet>
        )}
        {moveDialog}
      </>
    );
  }

  /** A card's value of a column, as one line. */
  function factText(d: Drawn, row: number, ticket: SearchTicket | undefined): string {
    const c = d.column;
    if (problems.has(d.index)) return '';
    if (c.kind === 'formula') return formulaText(c, formulaCell(grid, d.index, row));
    if (c.kind === 'total') {
      const text = totalText(totalCell(grid, d.index, row));
      return text.partial ? `${text.main} (${text.partial})` : text.main;
    }
    if (!ticket) return '';
    const v = (ticket as Record<string, unknown>)[c.field];
    if (c.field === 'assignee') {
      return (v as { name?: string } | null)?.name ?? t('search.edit.unassigned');
    }
    if (v && typeof v === 'object' && 'name' in v) return String((v as { name: unknown }).name);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  }

  const colCount = drawn.length + 1;
  return (
    <>
      {problemList}
      <GridButtons
        onExpand={() => setAndKeep(new Set())}
        onCollapse={() => setAndKeep(allCollapsible(tree))}
      />
      <div
        ref={scroller}
        className="glass-card glass-scroller plan-grid-scroll"
        style={{ scrollPaddingBlock: `${edges.top}px ${edges.bottom}px` }}
      >
        <table
          ref={table}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a treegrid is a table whose rows open and close (ADR-122 stage 10)
          role="treegrid"
          className="data-table plan-grid-table"
          aria-label={answer.structure.name ?? t('grid.defaultName')}
          aria-rowcount={visible.length + 2}
          aria-colcount={colCount}
          aria-describedby={`${id}-keys`}
          onKeyDown={onKeyDown}
          onFocus={onFocusIn}
        >
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className="plan-grid-tree">
                {t('grid.column.tree')}
              </th>
              {drawn.map((d) => {
                const header = headerOf(d);
                const broken = problems.get(d.index);
                return (
                  <th key={d.index} scope="col" data-kind={d.column.kind}>
                    <span className="plan-grid-head-name">{header.name}</span>
                    {header.note && <span className="plan-grid-head-note">{header.note}</span>}
                    {broken && (
                      <span className="plan-grid-head-note plan-grid-head-broken">
                        {brokenText(broken)}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {win.before > 0 && (
              // biome-ignore lint/a11y/noAriaHiddenOnFocusable: padding for the rows not drawn, never focused
              <tr aria-hidden="true" className="plan-grid-pad" style={{ blockSize: win.before }}>
                <td colSpan={colCount} />
              </tr>
            )}
            {runs.map((i) => {
              const row = visible[i] as number;
              const ticketId = skeleton.rows.ticket[row] as number;
              const ticket = ticketId > 0 ? cache.current.get(ticketId) : undefined;
              const below = (tree.end[row] as number) > row + 1;
              const open = !collapsed.has(row);
              const label = rowLabel(row);
              const isTicket = tree.isTicket[row] === 1;
              return (
                <tr
                  key={row}
                  data-row={row}
                  aria-rowindex={i + 2}
                  aria-level={(tree.depth[row] as number) + 1}
                  aria-setsize={setSize(tree, row)}
                  aria-posinset={tree.posInSet[row]}
                  aria-expanded={below ? open : undefined}
                  tabIndex={focus.row === row && focus.col < 0 ? 0 : -1}
                  className={isTicket ? 'plan-grid-row' : 'plan-grid-row is-group'}
                  data-out={skeleton.rows.inPlan[row] ? undefined : 'true'}
                  data-drop={
                    inHand !== null && over?.row === row && row !== inHand
                      ? over.problem
                        ? 'no'
                        : 'yes'
                      : undefined
                  }
                  data-in-hand={
                    inHand !== null && row >= inHand && row < (tree.end[inHand] as number)
                      ? 'true'
                      : undefined
                  }
                >
                  <th
                    scope="row"
                    className="plan-grid-tree"
                    style={{ '--grid-depth': tree.depth[row] } as React.CSSProperties}
                  >
                    <span className="plan-grid-tree-cell">
                      {movable(row) ? (
                        <MoveMenu
                          className="plan-grid-grip"
                          label={t('grid.move.grip', { key: label })}
                          handle={`row-${ticketId}`}
                          items={moveItems(row)}
                          onDragStart={(event) => beginDrag(event, row)}
                        />
                      ) : (
                        !readOnly && <span className="plan-grid-grip-space" />
                      )}
                      {below ? (
                        <button
                          type="button"
                          className="plan-grid-toggle"
                          aria-label={
                            open
                              ? t('grid.collapseRow', { name: label })
                              : t('grid.expandRow', { name: label })
                          }
                          onClick={() => toggle(row)}
                        >
                          <Chevron open={open} />
                        </button>
                      ) : (
                        <span className="plan-grid-leaf" />
                      )}
                      {isTicket ? (
                        <a href={routeHref(`#/tickets/${encodeURIComponent(label)}`)}>{label}</a>
                      ) : (
                        <span className="plan-grid-group-name">
                          {label}
                          <span className="plan-grid-mark">
                            {t('grid.groupRows', { count: childCount(tree, row) })}
                          </span>
                        </span>
                      )}
                      {marks(row).map((m) => (
                        <span key={m} className="plan-grid-mark">
                          {m}
                        </span>
                      ))}
                    </span>
                  </th>
                  {drawn.map((d) => cellFor(d, row, ticket))}
                </tr>
              );
            })}
            {win.after > 0 && (
              // biome-ignore lint/a11y/noAriaHiddenOnFocusable: padding for the rows not drawn, never focused
              <tr aria-hidden="true" className="plan-grid-pad" style={{ blockSize: win.after }}>
                <td colSpan={colCount} />
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr aria-rowindex={visible.length + 2} className="plan-grid-last">
              <th scope="row" className="plan-grid-tree">
                {t('grid.allRows')}
              </th>
              {drawn.map((d) => cellFor(d, n, undefined))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p id={`${id}-keys`} className="visually-hidden">
        {t('grid.keys')}
      </p>
      {/* `tick` and `cells` only draw the grid again after an edit or a read of cells. */}
      <span hidden data-tick={tick} data-cells={cells} />
      {inHand !== null && (
        <OverlayLayer>
          <div ref={ghost} className="drag-ghost" aria-hidden="true">
            {over === null || over.row === inHand
              ? keyOf(inHand)
              : over.problem
                ? problemText(over.problem, inHand)
                : t('grid.move.drag.on', { key: keyOf(inHand), to: keyOf(over.row) })}
          </div>
        </OverlayLayer>
      )}
      {moveDialog}
    </>
  );
}

function GridButtons({ onExpand, onCollapse }: { onExpand: () => void; onCollapse: () => void }) {
  const t = useT();
  return (
    <div className="plan-grid-expand">
      <button type="button" className="button-quiet" onClick={onExpand}>
        {t('grid.expandAll')}
      </button>
      <button type="button" className="button-quiet" onClick={onCollapse}>
        {t('grid.collapseAll')}
      </button>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      className={open ? 'plan-grid-chevron is-open' : 'plan-grid-chevron'}
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** A phone's sheet of one row: every column, the cell editors working where they may. */
function RowSheet({
  title,
  marks,
  actions,
  onAction,
  onClose,
  children,
}: {
  title: string;
  marks: string[];
  /** Moves offered for the row (Move under, Remove from parent); the sheet closes first. */
  actions: MoveMenuItem[];
  onAction: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const id = useId();
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('grid.sheet.close')}
      className="plan-grid-sheet"
    >
      <h2 id={`${id}-title`}>{title}</h2>
      {marks.length > 0 && <p className="board-hint">{marks.join(' · ')}</p>}
      <table className="data-table plan-grid-sheet-table">
        <tbody>{children}</tbody>
      </table>
      <div className="form-actions">
        {actions.map((item) => (
          <button
            key={item.key}
            type="button"
            className="button-secondary"
            onClick={() => {
              onAction();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
        <button type="button" className="button-secondary" onClick={onClose}>
          {t('grid.sheet.close')}
        </button>
      </div>
    </ModalDialog>
  );
}
