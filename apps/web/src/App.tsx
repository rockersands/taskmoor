import { useSyncExternalStore } from 'react';
import { I18nProvider, useT } from './i18n/I18nProvider';
import { type Locale, resolveLocale } from './i18n/locale';
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
  { id: 'home', labelId: 'nav.home', href: '#/home', icon: HomeIcon },
  { id: 'projects', labelId: 'nav.projects', href: '#/projects', icon: ProjectsIcon },
  { id: 'boards', labelId: 'nav.boards', href: '#/boards', icon: BoardsIcon },
  { id: 'search', labelId: 'nav.search', href: '#/search', icon: SearchIcon },
  { id: 'dashboards', labelId: 'nav.dashboards', href: '#/dashboards', icon: DashboardsIcon },
  { id: 'settings', labelId: 'nav.settings', href: '#/settings', icon: SettingsIcon },
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
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return NAV_ITEMS.some((item) => item.id === id) && id ? id : fallback;
}

function Pages() {
  const t = useT();
  const active = useHashRoute('home');
  const page = NAV_ITEMS.find((item) => item.id === active);

  return (
    <AppShell items={NAV_ITEMS} activeId={active}>
      <h1 className="page-title">{page ? t(page.labelId) : ''}</h1>
      <p className="page-note">{t('page.underConstruction')}</p>
    </AppShell>
  );
}

export interface AppProps {
  /** Overrides the locale detection; tests use it for the pseudo-locale. */
  locale?: Locale;
  onI18nError?: (error: Error) => void;
}

export function App({ locale, onI18nError }: AppProps) {
  return (
    <I18nProvider
      locale={locale ?? resolveLocale()}
      {...(onI18nError ? { onError: onI18nError } : {})}
    >
      <Pages />
    </I18nProvider>
  );
}
