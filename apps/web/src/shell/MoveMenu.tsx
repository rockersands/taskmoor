import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { leaveMotion } from './motion';
import { useMenuButton } from './useMenuButton';

/** Six dots: a handle's grip, drawn here. */
export function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {[4, 8, 12].map((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />),
      )}
    </svg>
  );
}

/** One move in a grip's menu; the key is stable, since two places may share a name. */
export interface MoveMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

export interface MoveMenuProps {
  label: string;
  /** Which element this handle moves, so focus can find it again after a change. */
  handle: string;
  items: MoveMenuItem[];
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /**
   * Alt and an arrow key: -1 earlier (up or left), 1 later (down or right). Left out where the
   * row around the grip takes Alt and the arrows itself.
   */
  onStep?: (direction: -1 | 1) => void;
  /** True right after this handle's own drag, whose click must not open the menu. */
  justDragged?: (handle: string) => boolean;
  /** Extra classes on the grip's box, for where the page places it. */
  className?: string;
}

/**
 * A grip that moves what it belongs to (ADR-114, section 7; T-162): drag it with a mouse or a
 * finger, or press it for a menu of the same moves; Alt and the arrow keys move it too. Every
 * drag has this keyboard path. The Tracks page's groups (CORE-034) and the backlog use it. With
 * no moves to offer, a press opens nothing: the grip says it is unavailable, and still drags,
 * since a drop may have somewhere to go that its menu does not list.
 */
export function MoveMenu({
  label,
  handle,
  items,
  onDragStart,
  onStep,
  justDragged,
  className,
}: MoveMenuProps) {
  const { open, openMenu, close, container, button, menu, buttonId, menuId, ...keys } =
    useMenuButton();
  const none = items.length === 0;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : 0;
    if (event.altKey && step !== 0) {
      // Never the browser's own Alt and arrow (Back and Forward on some systems).
      event.preventDefault();
      onStep?.(step);
      return;
    }
    if (!none) keys.onButtonKeyDown(event);
  };
  return (
    <div className={className ? `move-grip ${className}` : 'move-grip'} ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="move-grip-handle"
        data-handle={handle}
        aria-label={label}
        aria-haspopup={none ? undefined : 'menu'}
        aria-expanded={none ? undefined : open}
        aria-disabled={none || undefined}
        {...(open && !none ? { 'aria-controls': menuId } : {})}
        onClick={(event) => {
          if (none) return;
          // A pointer's click right after a drag is the drag's; Enter or Space never is.
          if (event.detail > 0 && justDragged?.(handle)) return;
          if (open) close(false);
          else openMenu(true);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onDragStart}
      >
        <GripIcon />
      </button>
      {open && !none && (
        <div ref={leaveMotion} className="user-menu-popup move-grip-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={keys.onMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.key}
                role="menuitem"
                tabIndex={-1}
                type="button"
                className="user-menu-item"
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
