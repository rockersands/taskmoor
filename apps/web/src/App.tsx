import { useSyncExternalStore } from 'react';
import { AppShell } from './shell/AppShell';
import {
  BoardsIcon,
  DashboardsIcon,
  HomeIcon,
  ProjectsIcon,
  SearchIcon,
  SettingsIcon,
} from './shell/icons';
import type { NavItem } from './shell/NavList';

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', href: '#/home', icon: HomeIcon },
  { id: 'projects', label: 'Projects', href: '#/projects', icon: ProjectsIcon },
  { id: 'boards', label: 'Boards', href: '#/boards', icon: BoardsIcon },
  { id: 'search', label: 'Search', href: '#/search', icon: SearchIcon },
  { id: 'dashboards', label: 'Dashboards', href: '#/dashboards', icon: DashboardsIcon },
  { id: 'settings', label: 'Settings', href: '#/settings', icon: SettingsIcon },
];

/** Current page id from the URL hash (#/projects -> "projects"); hash routes need no server rules. */
function useHashRoute(fallback: string): string {
  const hash = useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => window.location.hash,
    () => '',
  );
  const id = hash.replace(/^#\/?/, '').split('/')[0];
  return NAV_ITEMS.some((item) => item.id === id) && id ? id : fallback;
}

export function App() {
  const active = useHashRoute('home');
  const page = NAV_ITEMS.find((item) => item.id === active);

  return (
    <AppShell productName="Tracksmith" items={NAV_ITEMS} activeId={active}>
      <h1 className="page-title">{page?.label}</h1>
      <p className="page-note">This area is under construction.</p>
    </AppShell>
  );
}
