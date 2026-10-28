import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react';
import { AccountPage } from './account/AccountPage';
import { SecurityPage } from './admin/SecurityPage';
import { SettingsPage } from './admin/SettingsPage';
import { SystemPage } from './admin/SystemPage';
import { TrashPage } from './admin/TrashPage';
import { I18nProvider, useT } from './i18n/I18nProvider';
import { type Locale, resolveLocale } from './i18n/locale';
import { PasswordLinkPage } from './session/PasswordLinkPage';
import { RequireSession } from './session/RequireSession';
import { type Session, SessionProvider, useSession } from './session/SessionProvider';
import { SignInPage } from './session/SignInPage';
import { UserMenu } from './session/UserMenu';
import { SetupPage } from './setup/SetupPage';
import { AppShell } from './shell/AppShell';
import { type Command, CommandPalette } from './shell/CommandPalette';
import {
  BoardsIcon,
  DashboardsIcon,
  HomeIcon,
  SearchIcon,
  SettingsIcon,
  TracksIcon,
} from './shell/icons';
import type { NavItem } from './shell/NavList';
import { IdentityProvidersPage } from './sso/IdentityProvidersPage';
import { AdminTokensPage } from './tokens/AdminTokensPage';
import { ServiceAccountsPage } from './tokens/ServiceAccountsPage';

export const NAV_ITEMS: readonly (NavItem & { requiresSession?: boolean })[] = [
  { id: 'home', labelId: 'nav.home', href: '#/home', icon: HomeIcon },
  { id: 'tracks', labelId: 'nav.tracks', href: '#/tracks', icon: TracksIcon },
  { id: 'boards', labelId: 'nav.boards', href: '#/boards', icon: BoardsIcon },
  { id: 'search', labelId: 'nav.search', href: '#/search', icon: SearchIcon },
  { id: 'dashboards', labelId: 'nav.dashboards', href: '#/dashboards', icon: DashboardsIcon },
  {
    id: 'settings',
    labelId: 'nav.settings',
    href: '#/settings',
    icon: SettingsIcon,
    requiresSession: true,
  },
];

/** The URL hash, re-rendered on change; hash routes need no server rules. */
function useHash(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => window.location.hash,
    () => '',
  );
}

/** Current page id from the hash (#/tracks -> "tracks"). */
function routeFromHash(hash: string, fallback: string): string {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return NAV_ITEMS.some((item) => item.id === id) && id ? id : fallback;
}

/** True when the hash is this route, with or without a query or a sub-path. */
function isRoute(hash: string, route: string): boolean {
  return hash === route || hash.startsWith(`${route}?`) || hash.startsWith(`${route}/`);
}

/** Pages outside the navigation list that have their own route. */
const ADMIN_SYSTEM = '#/admin/system';
const ADMIN_TOKENS = '#/admin/tokens';
const ADMIN_SERVICE_ACCOUNTS = '#/admin/service-accounts';
const ADMIN_SECURITY = '#/admin/security';
const ADMIN_IDENTITY_PROVIDERS = '#/admin/identity-providers';
const ADMIN_TRASH = '#/admin/trash';
const ACCOUNT = '#/account';
const SIGN_IN = '#/sign-in';
const PASSWORD_LINK = '#/password';
const HOME = '#/home';

const goHome = () => {
  window.location.hash = HOME;
};

function Pages() {
  const t = useT();
  const hash = useHash();
  const { session } = useSession();
  const signedIn = session.status === 'signed-in';
  const admin = signedIn && session.user.isSiteAdmin;
  const showSignIn = useCallback(() => {
    window.location.hash = SIGN_IN;
  }, []);
  const commands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: `go-${item.id}`,
        labelId: item.labelId,
        run: () => {
          window.location.hash = item.href;
        },
      })),
      // The person's own account, once there is one to show.
      ...(signedIn
        ? [
            {
              id: 'go-account',
              labelId: 'account.title' as const,
              keywords: ['profile', 'password', 'sessions', 'tokens'],
              run: () => {
                window.location.hash = ACCOUNT;
              },
            },
          ]
        : []),
      // Administration commands are offered to site administrators only.
      ...(admin
        ? [
            {
              id: 'go-system',
              labelId: 'admin.system.title' as const,
              run: () => {
                window.location.hash = ADMIN_SYSTEM;
              },
            },
            {
              id: 'go-tokens',
              labelId: 'admin.tokens.title' as const,
              keywords: ['api', 'revoke', 'rotate'],
              run: () => {
                window.location.hash = ADMIN_TOKENS;
              },
            },
            {
              id: 'go-service-accounts',
              labelId: 'admin.serviceAccounts.title' as const,
              keywords: ['robot', 'bot', 'token'],
              run: () => {
                window.location.hash = ADMIN_SERVICE_ACCOUNTS;
              },
            },
            {
              id: 'go-security',
              labelId: 'admin.security.title' as const,
              keywords: ['two-factor', '2fa', 'policy'],
              run: () => {
                window.location.hash = ADMIN_SECURITY;
              },
            },
            {
              id: 'go-trash',
              labelId: 'admin.trash.title' as const,
              keywords: ['restore', 'undelete', 'deleted', 'retention'],
              run: () => {
                window.location.hash = ADMIN_TRASH;
              },
            },
            {
              id: 'go-identity-providers',
              labelId: 'admin.sso.title' as const,
              keywords: ['sso', 'oidc', 'openid', 'identity provider', 'domains'],
              run: () => {
                window.location.hash = ADMIN_IDENTITY_PROVIDERS;
              },
            },
          ]
        : []),
    ],
    [signedIn, admin],
  );

  // First-run setup and password links stand alone: no shell before someone can sign in.
  if (hash.startsWith('#/setup')) return <SetupPage onDone={goHome} />;
  if (isRoute(hash, PASSWORD_LINK)) return <PasswordLinkPage onDone={goHome} />;

  // Which navigation entry is highlighted, what the main area shows, and whether it needs a
  // session. Account is personal settings, so Settings stays highlighted there.
  let active = 'settings';
  let guarded = true;
  let content: ReactNode;
  if (hash.startsWith(ADMIN_SYSTEM)) {
    content = <SystemPage />;
  } else if (isRoute(hash, ADMIN_TOKENS)) {
    content = <AdminTokensPage />;
  } else if (isRoute(hash, ADMIN_SERVICE_ACCOUNTS)) {
    content = <ServiceAccountsPage />;
  } else if (isRoute(hash, ADMIN_SECURITY)) {
    content = <SecurityPage />;
  } else if (isRoute(hash, ADMIN_IDENTITY_PROVIDERS)) {
    content = <IdentityProvidersPage />;
  } else if (isRoute(hash, ADMIN_TRASH)) {
    content = <TrashPage />;
  } else if (isRoute(hash, ACCOUNT)) {
    content = <AccountPage />;
  } else if (isRoute(hash, SIGN_IN)) {
    active = '';
    guarded = false;
    content = <SignInPage onSignedIn={goHome} />;
  } else {
    active = routeFromHash(hash, 'home');
    const page = NAV_ITEMS.find((item) => item.id === active);
    guarded = page?.requiresSession ?? false;
    content =
      active === 'settings' ? (
        <SettingsPage />
      ) : (
        <>
          <h1 className="page-title">{page ? t(page.labelId) : ''}</h1>
          <p className="page-note">{t('page.underConstruction')}</p>
        </>
      );
  }

  return (
    <AppShell
      items={NAV_ITEMS}
      activeId={active}
      topbarEnd={
        <>
          <CommandPalette commands={commands} />
          <UserMenu onSignedOut={showSignIn} />
        </>
      }
    >
      {guarded ? <RequireSession>{content}</RequireSession> : content}
    </AppShell>
  );
}

export interface AppProps {
  /** Overrides the locale detection; tests use it for the pseudo-locale. */
  locale?: Locale;
  /** A fixed session skips the backend check; tests and stories start where they need to. */
  session?: Session;
  onI18nError?: (error: Error) => void;
}

export function App({ locale, session, onI18nError }: AppProps) {
  return (
    <I18nProvider
      locale={locale ?? resolveLocale()}
      {...(onI18nError ? { onError: onI18nError } : {})}
    >
      <SessionProvider {...(session ? { session } : {})}>
        <Pages />
      </SessionProvider>
    </I18nProvider>
  );
}
