import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AccountPage } from './account/AccountPage';
import { accountClient } from './account/client';
import { SecurityPage } from './admin/SecurityPage';
import { SettingsPage } from './admin/SettingsPage';
import { SystemPage } from './admin/SystemPage';
import { TrashPage } from './admin/TrashPage';
import { BulkOperationPage } from './bulk/BulkOperationPage';
import { TracksAdminPage } from './configuration/TracksAdminPage';
import { WorkflowMapsPage } from './configuration/WorkflowMapsPage';
import { DirectoriesPage } from './directories/DirectoriesPage';
import { FieldsAdminPage } from './fields/FieldsAdminPage';
import { HomePage } from './home/HomePage';
import { I18nProvider, useT } from './i18n/I18nProvider';
import { type Locale, resolveLocale } from './i18n/locale';
import { InboxPage } from './inbox/InboxPage';
import { UnsubscribePage } from './notifications/UnsubscribePage';
import { GroupsPage } from './people/GroupsPage';
import { UsersPage } from './people/UsersPage';
import { PermissionsPage } from './permissions/PermissionsPage';
import { PasswordLinkPage } from './session/PasswordLinkPage';
import { RequireSession } from './session/RequireSession';
import { type Session, SessionProvider, useSession } from './session/SessionProvider';
import { SignInPage } from './session/SignInPage';
import { UserMenu } from './session/UserMenu';
import { ConfigurationSetsPage } from './sets/ConfigurationSetsPage';
import { SetupPage } from './setup/SetupPage';
import { AppShell } from './shell/AppShell';
import { type Command, CommandPalette } from './shell/CommandPalette';
import {
  BoardsIcon,
  DashboardsIcon,
  HomeIcon,
  InboxIcon,
  SearchIcon,
  SettingsIcon,
  TracksIcon,
} from './shell/icons';
import type { NavItem } from './shell/NavList';
import { PaletteCommandsProvider, useRegisteredCommands } from './shell/paletteCommands';
import { type Appearance, applyAppearance } from './skins/skins';
import { IdentityProvidersPage } from './sso/IdentityProvidersPage';
import { SyncProvider } from './sync/SyncProvider';
import { CreateTicketDialog } from './tickets/CreateTicketDialog';
import { CreateTicketPage } from './tickets/CreateTicketPage';
import { TicketPage } from './tickets/view/TicketPage';
import { AdminTokensPage } from './tokens/AdminTokensPage';
import { ServiceAccountsPage } from './tokens/ServiceAccountsPage';
import { WorkflowEditorPage } from './workflow/WorkflowEditorPage';
import { WorkflowsPage } from './workflow/WorkflowsPage';

export const NAV_ITEMS: readonly (NavItem & { requiresSession?: boolean })[] = [
  { id: 'home', labelId: 'nav.home', href: '#/home', icon: HomeIcon },
  // Mentions and changes to followed tickets (M1-058).
  { id: 'inbox', labelId: 'nav.inbox', href: '#/inbox', icon: InboxIcon, requiresSession: true },
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
const ADMIN_DIRECTORIES = '#/admin/directories';
const CREATE_TICKET = '#/create';
const ADMIN_WORKFLOWS = '#/admin/workflows';
const ADMIN_USERS = '#/admin/users';
const ADMIN_GROUPS = '#/admin/groups';
const ADMIN_TRACKS = '#/admin/tracks';
const ADMIN_WORKFLOW_MAPS = '#/admin/workflow-maps';
const ADMIN_FIELDS = '#/admin/fields';
const ADMIN_PERMISSIONS = '#/admin/permissions';
const ADMIN_SETS = '#/admin/configuration-sets';
const ACCOUNT = '#/account';
/** A ticket by key (#/tickets/ABC-1); its attachments until the ticket view arrives (M1-051). */
const TICKET = '#/tickets';
const BULK = '#/bulk';
const SIGN_IN = '#/sign-in';
const PASSWORD_LINK = '#/password';
const UNSUBSCRIBE = '#/unsubscribe';
const HOME = '#/home';

/** A path segment of the hash, decoded; as it is when it is not valid percent-encoding. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const goHome = () => {
  window.location.hash = HOME;
};

function Pages() {
  const t = useT();
  const hash = useHash();
  const { session, signOut, setUser } = useSession();
  const signedIn = session.status === 'signed-in';
  const admin = signedIn && session.user.isSiteAdmin;
  const showSignIn = useCallback(() => {
    window.location.hash = SIGN_IN;
  }, []);
  const registered = useRegisteredCommands();
  // The create dialog (M1-052): the top bar's button, C anywhere outside fields, the palette.
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'c') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setCreating(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [signedIn]);
  // Applies at once; saved with the account so it follows the person (as on the account page).
  const appear = useCallback(
    (appearance: Appearance) => {
      applyAppearance(appearance);
      accountClient.updateProfile({ appearance }).then(setUser, () => {});
    },
    [setUser],
  );
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
              id: 'create-ticket',
              labelId: 'tickets.create.title' as const,
              keywords: ['new', 'issue', 'add'],
              run: () => setCreating(true),
            },
            {
              id: 'go-account',
              labelId: 'account.title' as const,
              keywords: ['profile', 'password', 'sessions', 'tokens'],
              run: () => {
                window.location.hash = ACCOUNT;
              },
            },
            {
              id: 'appearance-light',
              labelId: 'palette.appearance.light' as const,
              keywords: ['skin', 'theme', 'light', 'appearance'],
              run: () => appear('light'),
            },
            {
              id: 'appearance-dark',
              labelId: 'palette.appearance.dark' as const,
              keywords: ['skin', 'theme', 'dark', 'appearance'],
              run: () => appear('dark'),
            },
            {
              id: 'appearance-system',
              labelId: 'palette.appearance.system' as const,
              keywords: ['skin', 'theme', 'system', 'appearance'],
              run: () => appear('system'),
            },
            {
              id: 'sign-out',
              labelId: 'palette.signOut' as const,
              keywords: ['log out', 'logout', 'leave'],
              run: () => {
                void signOut().then(showSignIn, () => {});
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
            {
              id: 'go-directories',
              labelId: 'admin.directories.title' as const,
              keywords: ['ldap', 'active directory', 'directory', 'sync', 'groups'],
              run: () => {
                window.location.hash = ADMIN_DIRECTORIES;
              },
            },
            {
              id: 'go-workflows',
              labelId: 'admin.workflows.title' as const,
              keywords: ['status', 'transition', 'guard', 'check', 'effect', 'publish'],
              run: () => {
                window.location.hash = ADMIN_WORKFLOWS;
              },
            },
            {
              id: 'go-users',
              labelId: 'admin.users.title' as const,
              keywords: ['people', 'user', 'account', 'deactivate', 'invite', 'password'],
              run: () => {
                window.location.hash = ADMIN_USERS;
              },
            },
            {
              id: 'go-admin-tracks',
              labelId: 'admin.tracks.title' as const,
              keywords: ['track', 'project', 'roles', 'members', 'archive'],
              run: () => {
                window.location.hash = ADMIN_TRACKS;
              },
            },
            {
              id: 'go-workflow-maps',
              labelId: 'admin.maps.title' as const,
              keywords: ['workflow', 'map', 'ticket type', 'scheme'],
              run: () => {
                window.location.hash = ADMIN_WORKFLOW_MAPS;
              },
            },
            {
              id: 'go-fields',
              labelId: 'admin.fields.title' as const,
              keywords: ['field', 'custom field', 'options', 'choice'],
              run: () => {
                window.location.hash = ADMIN_FIELDS;
              },
            },
            {
              id: 'go-permissions',
              labelId: 'admin.permissions.title' as const,
              keywords: ['permission', 'role', 'access policy', 'grant', 'scheme'],
              run: () => {
                window.location.hash = ADMIN_PERMISSIONS;
              },
            },
            {
              id: 'go-configuration-sets',
              labelId: 'admin.sets.title' as const,
              keywords: ['type set', 'field rules', 'required', 'hidden', 'scheme'],
              run: () => {
                window.location.hash = ADMIN_SETS;
              },
            },
            {
              id: 'go-groups',
              labelId: 'admin.groups.title' as const,
              keywords: ['group', 'team', 'members', 'nested'],
              run: () => {
                window.location.hash = ADMIN_GROUPS;
              },
            },
          ]
        : []),
    ],
    [signedIn, admin, appear, showSignIn, signOut],
  );

  // First-run setup and password links stand alone: no shell before someone can sign in.
  if (hash.startsWith('#/setup')) return <SetupPage onDone={goHome} />;
  if (isRoute(hash, PASSWORD_LINK)) return <PasswordLinkPage onDone={goHome} />;
  if (isRoute(hash, UNSUBSCRIBE)) return <UnsubscribePage />;

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
  } else if (isRoute(hash, ADMIN_DIRECTORIES)) {
    content = <DirectoriesPage />;
  } else if (isRoute(hash, ADMIN_USERS)) {
    content = <UsersPage />;
  } else if (isRoute(hash, ADMIN_GROUPS)) {
    content = <GroupsPage />;
  } else if (isRoute(hash, ADMIN_TRACKS)) {
    content = <TracksAdminPage />;
  } else if (isRoute(hash, ADMIN_WORKFLOW_MAPS)) {
    content = <WorkflowMapsPage />;
  } else if (isRoute(hash, ADMIN_FIELDS)) {
    content = <FieldsAdminPage />;
  } else if (isRoute(hash, ADMIN_PERMISSIONS)) {
    content = <PermissionsPage />;
  } else if (isRoute(hash, ADMIN_SETS)) {
    content = <ConfigurationSetsPage />;
  } else if (isRoute(hash, CREATE_TICKET)) {
    active = 'tracks';
    content = <CreateTicketPage />;
  } else if (isRoute(hash, ADMIN_WORKFLOWS)) {
    const workflowId = /^#\/admin\/workflows\/(\d{1,10})(?:[/?]|$)/.exec(hash)?.[1];
    content = workflowId ? (
      <WorkflowEditorPage key={workflowId} workflowId={Number(workflowId)} />
    ) : (
      <WorkflowsPage />
    );
  } else if (isRoute(hash, ACCOUNT)) {
    content = <AccountPage />;
  } else if (hash.startsWith(`${TICKET}/`) && hash.length > TICKET.length + 1) {
    active = 'tracks';
    const ticket = decodedSegment(hash.slice(TICKET.length + 1).split(/[/?]/)[0] ?? '');
    content = <TicketPage key={ticket} ticket={ticket} />;
  } else if (hash.startsWith(`${BULK}/`) && hash.length > BULK.length + 1) {
    active = 'tracks';
    const id = decodedSegment(hash.slice(BULK.length + 1).split(/[/?]/)[0] ?? '');
    content = <BulkOperationPage key={id} id={id} />;
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
      ) : active === 'inbox' ? (
        <InboxPage />
      ) : active === 'home' && signedIn ? (
        <HomePage />
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
          {signedIn && (
            <button
              type="button"
              className="button-primary create-open"
              title={t('tickets.create.openDialogHint')}
              aria-haspopup="dialog"
              onClick={() => setCreating(true)}
            >
              {t('tickets.create.openDialog')}
            </button>
          )}
          <CommandPalette commands={[...commands, ...registered]} />
          <UserMenu onSignedOut={showSignIn} />
        </>
      }
    >
      {guarded ? <RequireSession>{content}</RequireSession> : content}
      {creating && signedIn && <CreateTicketDialog onClose={() => setCreating(false)} />}
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
        <SyncProvider>
          <PaletteCommandsProvider>
            <Pages />
          </PaletteCommandsProvider>
        </SyncProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
