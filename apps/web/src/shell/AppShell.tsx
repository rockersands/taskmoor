import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { UpdateNotice } from '../admin/UpdateNotice';
import { useT } from '../i18n/I18nProvider';
import { UpdateBanner } from '../meta/VersionGate';
import { startGlassLens } from './glassLens';
import { CloseIcon, MenuIcon } from './icons';
import { leaveMotion, useLeaveMotion } from './motion';
import { type NavItem, NavList } from './NavList';
import { COMPACT_QUERY, useMediaQuery } from './useMediaQuery';

interface AppShellProps {
  items: readonly NavItem[];
  activeId: string;
  /** Controls shown at the right end of the top bar, such as the command palette. */
  topbarEnd?: ReactNode;
  children: ReactNode;
}

/**
 * Page frame: top bar, navigation and main area.
 *
 * Desktop first: on wide screens the sidebar is always there and can collapse to an icon rail.
 * Below 768px it becomes a drawer opened from the menu button, so the app still works on phones.
 */
export function AppShell({ items, activeId, topbarEnd, children }: AppShellProps) {
  const t = useT();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const drawerRef = useLeaveMotion(drawer);
  const topbar = useRef<HTMLElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  }, []);

  useEffect(() => startGlassLens(), []);

  // The top bar stays over the top of the page as it scrolls. How far down it reaches, with the
  // shell's gap below it, goes to the page's scroll padding (shell.css), so whatever is brought
  // into view (a card the arrows reach, a focused field, a link's target) stops below the bar,
  // not under it (WCAG 2.4.11). Measured, so it follows the bar on every layout and zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the gap changes with the layout
  useLayoutEffect(() => {
    const bar = topbar.current;
    if (!bar) return;
    const root = document.documentElement;
    const measure = () => {
      const style = getComputedStyle(bar);
      const stays = style.position === 'sticky' || style.position === 'fixed';
      const reach = stays
        ? (Number.parseFloat(style.top) || 0) +
          bar.offsetHeight +
          (Number.parseFloat(style.marginTop) || 0)
        : 0;
      root.style.setProperty('--shell-topbar-reach', `${Math.ceil(reach)}px`);
    };
    measure();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watch?.observe(bar);
    return () => {
      watch?.disconnect();
      root.style.removeProperty('--shell-topbar-reach');
    };
  }, [compact]);

  // Growing past the compact breakpoint swaps the drawer for the sidebar.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  useEffect(() => {
    if (!drawerOpen) return;
    // The first page, not the close button above it: opening the drawer is for going somewhere.
    drawer.current?.querySelector<HTMLElement>('nav a, nav button')?.focus();
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
        {t('shell.skipToContent')}
      </a>

      <header ref={topbar} className="shell-topbar">
        {compact ? (
          <button
            ref={menuButton}
            type="button"
            className="icon-button"
            aria-label={t('shell.openNavigation')}
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
            aria-label={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            aria-expanded={!collapsed}
            aria-controls="shell-sidebar"
            onClick={() => setCollapsed((value) => !value)}
          >
            <MenuIcon />
          </button>
        )}
        <span className="shell-brand">{t('app.name')}</span>
        <div className="shell-topbar-end">{topbarEnd}</div>
      </header>

      {!compact && (
        <aside id="shell-sidebar" className="shell-sidebar">
          <NavList items={items} activeId={activeId} showLabels={!collapsed} />
        </aside>
      )}

      {compact && drawerOpen && (
        <>
          <button
            ref={leaveMotion}
            type="button"
            className="shell-backdrop"
            aria-label={t('shell.closeNavigation')}
            tabIndex={-1}
            onClick={closeDrawer}
          />
          <div
            ref={drawerRef}
            id="shell-drawer"
            className="shell-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.navigationDialog')}
            onKeyDown={trapFocus}
          >
            {/* The drawer says what it is and how to leave it (S3-SP-12): the product's name, and
                a button that closes it, since the drawer covers the menu button. */}
            <div className="shell-drawer-head">
              <span className="shell-drawer-brand">{t('app.name')}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={t('shell.closeNavigation')}
                onClick={closeDrawer}
              >
                <CloseIcon />
              </button>
            </div>
            <NavList items={items} activeId={activeId} showLabels onNavigate={closeDrawer} />
          </div>
        </>
      )}

      <main id="main" className="shell-main" tabIndex={-1}>
        <UpdateBanner />
        <UpdateNotice />
        {children}
      </main>
    </div>
  );
}
