import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { leaveMotion } from '../shell/motion';
import { useMenuButton } from '../shell/useMenuButton';
import { useSession } from './SessionProvider';

export interface UserMenuProps {
  /** Runs once the backend has ended the session, for example to show the sign-in page. */
  onSignedOut: () => void;
}

const ACCOUNT = '#/account';

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
  const {
    open,
    openMenu: showMenu,
    close,
    container,
    button,
    menu,
    buttonId,
    menuId,
    onButtonKeyDown,
    onMenuKeyDown,
  } = useMenuButton();
  const [failed, setFailed] = useState(false);

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
    showMenu(first);
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
        <div ref={leaveMotion} className="user-menu-popup">
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
