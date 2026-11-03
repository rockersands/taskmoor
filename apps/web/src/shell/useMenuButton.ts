import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
}

/**
 * The behaviour of an APG menu button, shared by the person's menu and the Help menu. Enter, Space
 * and the arrow keys open it; inside, the arrow keys, Home, End and the first letter move, Escape
 * closes it and returns focus to the button, Tab closes it and moves on, and a press outside closes
 * it and leaves focus where the press put it.
 */
export function useMenuButton() {
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  const openMenu = useCallback((first: boolean) => {
    setFocusFirst(first);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const items = menuItems(menu.current);
    (focusFirst ? items[0] : items[items.length - 1])?.focus();
    const onPointerDown = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, focusFirst]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown');
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menu.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const key = event.key.toLocaleLowerCase();
          const after = [...items.slice(index + 1), ...items.slice(0, index + 1)];
          after
            .find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(key))
            ?.focus();
        }
    }
  };

  return {
    open,
    openMenu,
    close,
    container,
    button,
    menu,
    buttonId,
    menuId,
    onButtonKeyDown,
    onMenuKeyDown,
  };
}
