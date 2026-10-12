import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { MenuIcon } from './icons';
import { type NavItem, NavList } from './NavList';
import { COMPACT_QUERY, useMediaQuery } from './useMediaQuery';

interface AppShellProps {
  productName: string;
  items: readonly NavItem[];
  activeId: string;
  children: ReactNode;
}

/**
 * Page frame: top bar, navigation and main area.
 *
 * Desktop first: on wide screens the sidebar is always there and can collapse to an icon rail.
 * Below 768px it becomes a drawer opened from the menu button, so the app still works on phones.
 */
export function AppShell({ productName, items, activeId, children }: AppShellProps) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  }, []);

  // Growing past the compact breakpoint swaps the drawer for the sidebar.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  useEffect(() => {
    if (!drawerOpen) return;
    drawer.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  // Keeps Tab inside the open drawer, as expected of a modal dialog.
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !drawer.current) return;
    const focusable = [...drawer.current.querySelectorAll<HTMLElement>('a, button')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="shell"
      data-layout={compact ? 'compact' : 'desktop'}
      data-collapsed={!compact && collapsed}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell-topbar">
        {compact ? (
          <button
            ref={menuButton}
            type="button"
            className="icon-button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="shell-drawer"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </button>
        ) : (
          <button
            type="button"
            className="icon-button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="shell-sidebar"
            onClick={() => setCollapsed((value) => !value)}
          >
            <MenuIcon />
          </button>
        )}
        <span className="shell-brand">{productName}</span>
      </header>

      {!compact && (
        <aside id="shell-sidebar" className="shell-sidebar">
          <NavList items={items} activeId={activeId} showLabels={!collapsed} />
        </aside>
      )}

      {compact && drawerOpen && (
        <>
          <button
            type="button"
            className="shell-backdrop"
            aria-label="Close navigation"
            tabIndex={-1}
            onClick={closeDrawer}
          />
          <div
            ref={drawer}
            id="shell-drawer"
            className="shell-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onKeyDown={trapFocus}
          >
            <NavList items={items} activeId={activeId} showLabels onNavigate={closeDrawer} />
          </div>
        </>
      )}

      <main id="main" className="shell-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
