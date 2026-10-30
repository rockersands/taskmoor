import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { useSession } from './SessionProvider';

export interface UserMenuProps {
  /** Runs once the backend has ended the session, for example to show the sign-in page. */
  onSignedOut: () => void;
}

const ACCOUNT = '#/account';

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
}

/**
 * The signed-in person's menu at the end of the top bar, built as an APG menu button: the
 * button shows their name and opens a menu with Account and Sign out. Enter, Space and the
 * arrow keys open it; inside, the arrow keys, Home, End and the first letter move, Escape
 * closes it and returns focus to the button, Tab closes it and moves on. Visitors who are not
 * signed in get a "Sign in" link instead.
 */
export function UserMenu({ onSignedOut }: UserMenuProps) {
  const t = useT();
  const { session, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(true);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const items = menuItems(menu.current);
    (focusFirst ? items[0] : items[items.length - 1])?.focus();
    // A press anywhere outside closes the menu and leaves focus where the press put it.
    const onPointerDown = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, focusFirst]);

  if (session.status === 'loading') return null;
  if (session.status === 'anonymous') {
    return (
      <a className="topbar-link" href={routeHref('#/sign-in')}>
        {t('auth.signIn')}
      </a>
    );
  }

  const { user } = session;
  const initial = [...user.name.trim()][0]?.toLocaleUpperCase() ?? '?';

  const openMenu = (first: boolean, keepError = false) => {
    if (!keepError) setFailed(false);
    setFocusFirst(first);
    setOpen(true);
  };

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

  const runSignOut = async () => {
    close(true);
    try {
      await signOut();
      onSignedOut();
    } catch {
      // The session may still be valid, so never pretend it ended: say so in the menu.
      setFailed(true);
      openMenu(false, true);
    }
  };

  return (
    <div className="user-menu" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={() => (open ? close(false) : openMenu(true))}
        onKeyDown={onButtonKeyDown}
      >
        <span className="user-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="user-menu-name">{t('common.value', { value: user.name })}</span>
      </button>
      {open && (
        <div className="user-menu-popup">
          <p className="user-menu-email">{t('userMenu.signedInAs', { email: user.email })}</p>
          {failed && (
            <p className="form-error user-menu-error" role="alert">
              {t('userMenu.signOutFailed')}
            </p>
          )}
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={onMenuKeyDown}
          >
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className="user-menu-item"
              onClick={() => {
                close(true);
                navigate(ACCOUNT);
              }}
            >
              {t('userMenu.account')}
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className="user-menu-item"
              onClick={() => void runSignOut()}
            >
              {t('userMenu.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
