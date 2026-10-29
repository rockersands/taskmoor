import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type Translate, useT } from '../i18n/I18nProvider';
import {
  type Board,
  type BoardCard,
  type BoardClient,
  type BoardData,
  boardClient,
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

/** A person, priority or other named value on a card. */
const nameOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'name' in value
    ? String((value as { name: unknown }).name)
    : null;

function cardMeta(t: Translate, card: BoardCard): string[] {
  const out: string[] = [card.ticketType.name];
  if ('assignee' in card.fields) {
    out.push(nameOf(card.fields.assignee) ?? t('boards.card.unassigned'));
  }
  const priority = nameOf(card.fields.priority);
  if (priority) out.push(priority);
  if (typeof card.fields.dueDate === 'string') {
    out.push(t('boards.card.due', { date: card.fields.dueDate }));
  }
  if (Array.isArray(card.fields.labels) && card.fields.labels.length > 0) {
    out.push(card.fields.labels.join(', '));
  }
  return out;
}

/** The column's count, limits and breach, as its header reads them (AGL-003). */
function ColumnHead({ column, t }: { column: Column; t: Translate }) {
  const hidden = column.count - column.shown;
  return (
    <div className="board-column-head" data-wip={column.wip ?? undefined}>
      <h2 className="board-column-name">{column.name}</h2>
      <p className="board-column-count">
        {t('boards.column.count', { count: column.count })}
        {column.min !== null && <span>{t('boards.column.min', { min: column.min })}</span>}
        {column.max !== null && <span>{t('boards.column.max', { max: column.max })}</span>}
      </p>
      {column.wip === 'over' && <p className="board-column-wip">{t('boards.column.over')}</p>}
      {column.wip === 'under' && <p className="board-column-wip">{t('boards.column.under')}</p>}
      {hidden > 0 && (
        <p className="board-column-hidden">{t('boards.column.hidden', { count: hidden })}</p>
      )}
    </div>
  );
}

/**
 * A board (M1-043; AGL-002 to AGL-006): its columns with counts and WIP limits, its lanes, and
 * the cards in rank order. The columns scroll sideways inside the board, never the page. A card
 * moves with Alt and the arrow keys (another column left or right, up or down in its column)
 * or with its Move menu; a move runs the ticket's transition on the server and asks which one
 * when several lead into the column. Board filters narrow the cards; counts stay whole.
 */
export function BoardPage({ boardId, client = boardClient }: BoardPageProps) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const choiceTitleId = useId();
  const [board, setBoard] = useState<Board | null>(null);
  const [data, setData] = useState<BoardData | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [filters, setFilters] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const focusAfter = useRef<number | null>(null);
  const links = useRef(new Map<number, HTMLAnchorElement>());
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (active: readonly string[]) => {
      const mine = ++generation.current;
      try {
        const [b, d] = await Promise.all([client.board(boardId), client.data(boardId, active)]);
        if (mine !== generation.current) return;
        setBoard(b);
        setData(d);
        setState('loaded');
      } catch {
        if (mine === generation.current) setState('failed');
      }
    },
    [client, boardId],
  );

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  useEffect(() => {
    if (focusAfter.current === null || !data) return;
    links.current.get(focusAfter.current)?.focus();
    focusAfter.current = null;
  }, [data]);

  useEffect(() => {
    if (choice) firstChoice.current?.focus();
  }, [choice]);

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
  const cardsIn = (columnId: string, laneId: string) =>
    data.cards.filter((c) => c.columnId === columnId && c.laneId === laneId);
  const columnById = (id: string) => columns.find((c) => c.id === id) as Column;

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
      if (outcome.kind === 'no_transition') {
        setProblem(t('boards.noTransition', { key: card.key, column: column.name }));
        links.current.get(card.id)?.focus();
        return;
      }
      if (outcome.kind === 'refused') {
        setProblem(t('boards.refused', { key: card.key, code: outcome.code }));
        links.current.get(card.id)?.focus();
        return;
      }
      setAnnouncement(done);
      focusAfter.current = card.id;
      await load(filters);
    } catch {
      setProblem(t('boards.refused', { key: card.key, code: 'error' }));
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

  function onCardKey(event: KeyboardEvent, card: BoardCard) {
    if (!event.altKey || busy) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') toColumn(card, step as -1 | 1);
    else inColumn(card, step as -1 | 1);
  }

  function toggleFilter(id: string) {
    setFilters((current) =>
      current.includes(id) ? current.filter((f) => f !== id) : [...current, id],
    );
  }

  const location =
    board.location.type === 'track'
      ? t('boards.location.track', { track: board.location.track.name ?? '' })
      : t('boards.location.user', { name: board.location.user.name ?? '' });
  const showLanes = data.lanes.length > 1 || data.lanes.some((l) => !l.catchAll);
  const filterButtons = board.boardFilters.map((f) => (
    <button
      key={f.id}
      type="button"
      className="board-filter"
      aria-pressed={filters.includes(f.id)}
      title={f.description || f.query}
      onClick={() => toggleFilter(f.id)}
    >
      {f.name}
    </button>
  ));

  const renderCard = (card: BoardCard) => {
    const column = columnById(card.columnId);
    const at = columns.indexOf(column);
    const cell = cardsIn(card.columnId, card.laneId);
    const position = cell.findIndex((c) => c.id === card.id);
    const menuOpen = menuFor === card.id;
    return (
      <li
        key={card.id}
        className="board-card"
        style={card.colour ? ({ '--card-colour': card.colour } as CSSProperties) : undefined}
        onKeyDown={(event) => onCardKey(event, card)}
      >
        <a
          className="board-card-link"
          href={`#/tickets/${encodeURIComponent(card.key)}`}
          aria-describedby={hintId}
          ref={(el) => {
            if (el) links.current.set(card.id, el);
            else links.current.delete(card.id);
          }}
        >
          <span className="board-card-key">{card.key}</span>{' '}
          <span className="board-card-summary">{card.summary}</span>
        </a>
        <p className="board-card-meta">
          {cardMeta(t, card).map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed in order per card
            <span key={i}>{part}</span>
          ))}
          {card.daysInColumn !== null && (
            <span>{t('boards.card.days', { days: card.daysInColumn })}</span>
          )}
        </p>
        <button
          type="button"
          className="board-card-move"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={() => setMenuFor(menuOpen ? null : card.id)}
        >
          {t('boards.card.move', { key: card.key })}
        </button>
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
      <header className="board-header">
        <h1 id={titleId} className="page-title">
          {board.name}
        </h1>
        <p className="board-meta">
          {t('boards.meta', {
            kind: t(board.kind === 'scrum' ? 'boards.kind.scrum' : 'boards.kind.kanban'),
            location,
          })}
        </p>
      </header>
      {board.boardFilters.length > 0 &&
        (board.boardFilterDisplay === 'dropdown' ? (
          <details className="board-filters-menu">
            <summary>{t('boards.filters.summary', { count: filters.length })}</summary>
            <fieldset className="board-filters">
              <legend className="visually-hidden">{t('boards.filters')}</legend>
              {filterButtons}
            </fieldset>
          </details>
        ) : (
          <fieldset className="board-filters">
            <legend className="visually-hidden">{t('boards.filters')}</legend>
            {filterButtons}
          </fieldset>
        ))}
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
      {data.cards.length === 0 && <p className="page-note">{t('boards.empty')}</p>}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached by keyboard to scroll it */}
      <section className="board-scroll" aria-label={t('boards.columns')} tabIndex={0}>
        <div className="board-grid" style={grid}>
          <div className="board-row board-heads">
            {columns.map((column) => (
              <ColumnHead key={column.id} column={column} t={t} />
            ))}
          </div>
          {data.lanes.map((given) => {
            // The unassigned lane is named here, in the reader's language.
            const lane =
              given.assignee === null ? { ...given, name: t('boards.card.unassigned') } : given;
            const count = data.cards.filter((c) => c.laneId === lane.id).length;
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
                      className="board-cell"
                      aria-label={
                        showLanes
                          ? t('boards.cell', { column: column.name, lane: lane.name })
                          : column.name
                      }
                    >
                      {cardsIn(column.id, lane.id).map(renderCard)}
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
