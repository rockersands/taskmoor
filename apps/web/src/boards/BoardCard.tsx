import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { type Translate, useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { ClockIcon, NobodyIcon, PencilIcon } from '../shell/icons';
import { GripIcon } from '../shell/MoveMenu';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import type { SubticketProgress } from '../tickets/tools/client';
import { SubticketProgressMini } from '../tickets/tools/Progress';
import type { BoardCard } from './client';

/**
 * What a card asks of its board. The board hands every card the same object, whose methods call
 * its latest handlers, so a card is drawn again only when its own props change (T-193).
 */
export interface CardActions {
  /**
   * A press begins on the card, which may become a drag (T-162b; ADR-114, section 12): a mouse's
   * anywhere but on the pencil, anything's on the grip (`data-card-grip`), the Move button.
   */
  grab(event: ReactPointerEvent, card: BoardCard): void;
  keyDown(event: KeyboardEvent, card: BoardCard): void;
  /** The card's link is followed (a click that ends a drag never reaches it). */
  open(card: BoardCard): void;
  editTitle(card: BoardCard): void;
  toggleMenu(card: BoardCard): void;
  linkRef(id: number, link: HTMLAnchorElement | null): void;
  pencilRef(id: number, pencil: HTMLButtonElement | null): void;
}

export interface BoardCardProps {
  card: BoardCard;
  /** Its place in its cell, from 1, and how many cards the cell holds (for screen readers). */
  place: number;
  of: number;
  hintId: string;
  /** Its link and buttons are in the tab order: the cell's current card (roving focus). */
  tabbable: boolean;
  dragging: boolean;
  dropBefore: boolean;
  /** Its own move is running: its buttons wait, and it cannot be dragged. */
  busy: boolean;
  menuOpen: boolean;
  /** The title editor, in place of the link while it is open. */
  editor: ReactNode;
  /** The Move menu, while it is open. */
  menu: ReactNode;
  progress: SubticketProgress | undefined;
  /** Room for the cards a long cell does not draw just above this one, in pixels. */
  skipBefore: number;
  actions: CardActions;
}

/** A person, priority or other named value on a card. */
const nameOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'name' in value
    ? String((value as { name: unknown }).name)
    : null;

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

/**
 * One card (M1-043, M1-046; AGL-006): its key and title, icons, the fields the board shows, and
 * its pencil and grip, which opens the Move menu. A mouse drags the card from anywhere but the
 * pencil; a finger by the grip, since elsewhere it scrolls (T-162b). Drawn again only when its
 * own props change: a drop, a drag over the board or a reload draws the cards that changed, not
 * the whole board (T-193).
 */
function BoardCardView({
  card,
  place,
  of,
  hintId,
  tabbable,
  dragging,
  dropBefore,
  busy,
  menuOpen,
  editor,
  menu,
  progress,
  skipBefore,
  actions,
}: BoardCardProps) {
  const t = useT();
  const priority = card.fields.priority as { name: string; level?: number } | null | undefined;
  const titleOpen = editor !== null && editor !== undefined;
  // Out of the tab order unless it is the cell's current card: the arrows reach the others.
  const tabIndex = tabbable ? undefined : -1;
  const style = {
    ...(card.colour ? { '--card-colour': card.colour } : {}),
    ...(skipBefore > 0 ? { marginBlockStart: `${skipBefore}px` } : {}),
  } as CSSProperties;
  return (
    <li
      className={`board-card${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}`}
      data-card-id={card.id}
      aria-posinset={place}
      aria-setsize={of}
      onPointerDown={(event) => actions.grab(event, card)}
      style={Object.keys(style).length > 0 ? style : undefined}
      onKeyDown={(event) => actions.keyDown(event, card)}
    >
      {titleOpen ? (
        editor
      ) : (
        <a
          className="board-card-link"
          href={routeHref(`#/tickets/${encodeURIComponent(card.key)}`)}
          onClick={() => actions.open(card)}
          aria-describedby={hintId}
          title={`${card.key} ${card.summary}`}
          tabIndex={tabIndex}
          // The card is dragged, not the link's address (the browser's own drag would end ours).
          draggable={false}
          ref={(el) => actions.linkRef(card.id, el)}
        >
          <span className="board-card-key">{card.key}</span>{' '}
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
        {progress && <SubticketProgressMini progress={progress} />}
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
              tabIndex={tabIndex}
              ref={(el) => actions.pencilRef(card.id, el)}
              onClick={() => actions.editTitle(card)}
            >
              <PencilIcon width={18} height={18} />
            </button>
          )}
          {/* The card's grip: a mouse or a finger drags the card by it, and a press opens the
              Move menu. Elsewhere on the card a finger scrolls the board (T-162b). */}
          <button
            type="button"
            className="board-card-move board-card-grip"
            data-card-grip=""
            aria-expanded={menuOpen}
            aria-label={t('boards.card.move', { key: card.key })}
            title={t('boards.card.move', { key: card.key })}
            disabled={busy}
            tabIndex={tabIndex}
            onClick={() => actions.toggleMenu(card)}
          >
            <GripIcon />
          </button>
        </span>
      )}
      {menu}
    </li>
  );
}

/** Subticket counts arrive as new objects on every read: the same numbers are the same props. */
const sameProps = (a: BoardCardProps, b: BoardCardProps): boolean => {
  for (const key of Object.keys(a) as (keyof BoardCardProps)[]) {
    if (key === 'progress') {
      if (a.progress?.total !== b.progress?.total || a.progress?.closed !== b.progress?.closed) {
        return false;
      }
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
};

export const BoardCardItem = memo(BoardCardView, sameProps);
