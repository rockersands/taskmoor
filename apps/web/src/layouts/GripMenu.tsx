import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../i18n/I18nProvider';
import { leaveMotion } from '../shell/motion';
import { useMenuButton } from '../shell/useMenuButton';

/** Six dots: a grip, drawn here. */
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {[4, 8, 12].map((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />),
      )}
    </svg>
  );
}

/** One move in a grip's menu. */
export interface GripItem {
  key: string;
  label: string;
  onSelect: () => void;
}

interface GripMenuProps {
  label: string;
  /** What this grip moves, so focus can find it again after a move. */
  handle: string;
  items: GripItem[];
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** Alt and an arrow key: -1 earlier, 1 later. */
  onStep?: (direction: -1 | 1) => void;
  /** True right after this grip's own drag, whose click must not open the menu. */
  justDragged: (handle: string) => boolean;
}

/**
 * The layout editor's grip (UI-T15): drag it with a mouse or a finger, or press it for a menu of
 * the same moves; Alt and the arrow keys move what it belongs to one place. Every drag has this
 * keyboard path (ADR-114 section 7).
 */
export function GripMenu({
  label,
  handle,
  items,
  onDragStart,
  onStep,
  justDragged,
}: GripMenuProps) {
  const t = useT();
  const { open, openMenu, close, container, button, menu, buttonId, menuId, ...keys } =
    useMenuButton();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : 0;
    if (event.altKey && step !== 0) {
      event.preventDefault();
      onStep?.(step);
      return;
    }
    keys.onButtonKeyDown(event);
  };
  return (
    <div className="layout-grip" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="layout-grip-handle"
        data-handle={handle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={(event) => {
          // A pointer's click right after a drag is the drag's; Enter or Space never is.
          if (event.detail > 0 && justDragged(handle)) return;
          if (open) close(false);
          else openMenu(true);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onDragStart}
      >
        <GripIcon />
      </button>
      {open && (
        <div ref={leaveMotion} className="user-menu-popup layout-grip-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={keys.onMenuKeyDown}
          >
            {items.length === 0 && (
              // Nowhere to go yet (one tab, or no section to put a field in): said, not hidden.
              <button
                role="menuitem"
                tabIndex={-1}
                type="button"
                aria-disabled="true"
                className="user-menu-item"
                onClick={() => close(true)}
              >
                {t('layouts.noMoves')}
              </button>
            )}
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
