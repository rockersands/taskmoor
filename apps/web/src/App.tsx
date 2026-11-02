import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { AccountPage } from './account/AccountPage';
import { accountClient } from './account/client';
import { AiSettingsPage } from './admin/AiSettingsPage';
import { AiUsagePage } from './admin/AiUsagePage';
import { ApiUsagePage } from './admin/ApiUsagePage';
import { AuditPage } from './admin/audit/AuditPage';
import { FrontendsPage } from './admin/FrontendsPage';
import { ImportsPage } from './admin/imports/ImportsPage';
import { McpPage } from './admin/McpPage';
import { NetworkAccessPage } from './admin/NetworkAccessPage';
import { SecurityPage } from './admin/SecurityPage';
import { SettingsPage } from './admin/SettingsPage';
import { SystemPage } from './admin/SystemPage';
import { TrashPage } from './admin/TrashPage';
import { BoardPage } from './boards/BoardPage';
import { BoardSettingsPage } from './boards/BoardSettingsPage';
import { BoardsPage } from './boards/BoardsPage';
import { BulkOperationPage } from './bulk/BulkOperationPage';
import { CalendarPage } from './calendar/CalendarPage';
import { TracksAdminPage } from './configuration/TracksAdminPage';
import { WorkflowMapsPage } from './configuration/WorkflowMapsPage';
import { DashboardPage } from './dashboards/DashboardPage';
import { DashboardsPage } from './dashboards/DashboardsPage';
import { DirectoriesPage } from './directories/DirectoriesPage';
import { FieldsAdminPage } from './fields/FieldsAdminPage';
import { GuardrailsPage } from './guardrails/GuardrailsPage';
import { HomePage } from './home/HomePage';
import { I18nProvider, useT } from './i18n/I18nProvider';
import {
  catalogueFor,
  type Locale,
  localeInUrl,
  rememberLocale,
  resolveLocale,
} from './i18n/locale';
import { InboxPage } from './inbox/InboxPage';
import { ListPage } from './list/ListPage';
import type { MetaClient } from './meta/client';
import { VersionGate } from './meta/VersionGate';
import { UnsubscribePage } from './notifications/UnsubscribePage';
import { ConsentPage } from './oauth/ConsentPage';
import { GroupsPage } from './people/GroupsPage';
import { TeamsPage } from './people/TeamsPage';
import { UsersPage } from './people/UsersPage';
import { PermissionsPage } from './permissions/PermissionsPage';
import { ReleasePage } from './releases/ReleasePage';
import { ReleasesPage } from './releases/ReleasesPage';
import { BOARD_REPORTS, BoardReportsPage } from './reports/BoardReportsPage';
import { ImportedLinkPage, sourceLinkRoute } from './routing/ImportedLinkPage';
import { currentRoute, navigate, useRoute } from './routing/router';
import { runtimeConfig } from './runtime/config';
import { queryFromHash, SearchPage } from './search/SearchPage';
import { savedSearchFromHash } from './search/savedClient';
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
import { ThemeToggle } from './shell/ThemeToggle';
import { type Appearance, applyAppearance } from './skins/skins';
import { BacklogPage } from './sprints/BacklogPage';
import { SprintReportPage } from './sprints/SprintReportPage';
import { continuation } from './sso/client';
import { IdentityProvidersPage } from './sso/IdentityProvidersPage';
import { SyncProvider } from './sync/SyncProvider';
import { CreateTicketDialog } from './tickets/CreateTicketDialog';
import { CreateTicketPage } from './tickets/CreateTicketPage';
import { TicketPage } from './tickets/view/TicketPage';
import { TimelinePage } from './timeline/TimelinePage';
import { AdminTokensPage } from './tokens/AdminTokensPage';
import { ServiceAccountsPage } from './tokens/ServiceAccountsPage';
import { TrackSummaryPage } from './tracks/TrackSummaryPage';
import { TutorialsPage } from './tutorial/TutorialsPage';
import { WorkflowEditorPage } from './workflow/WorkflowEditorPage';
import { WorkflowsPage } from './workflow/WorkflowsPage';

export const NAV_ITEMS: readonly (NavItem & { requiresSession?: boolean })[] = [
  { id: 'home', labelId: 'nav.home', href: '#/home', icon: HomeIcon, group: 'you' },
  // Mentions and changes to followed tickets (M1-058).
  {
    id: 'inbox',
    labelId: 'nav.inbox',
    href: '#/inbox',
    icon: InboxIcon,
    requiresSession: true,
    group: 'you',
  },
  { id: 'tracks', labelId: 'nav.tracks', href: '#/tracks', icon: TracksIcon, group: 'work' },
  { id: 'boards', labelId: 'nav.boards', href: '#/boards', icon: BoardsIcon, group: 'work' },
  { id: 'search', labelId: 'nav.search', href: '#/search', icon: SearchIcon, group: 'work' },
  {
    id: 'dashboards',
    labelId: 'nav.dashboards',
    href: '#/dashboards',
    icon: DashboardsIcon,
    requiresSession: true,
    group: 'work',
  },
  {
    id: 'settings',
    labelId: 'nav.settings',
    href: '#/settings',
    icon: SettingsIcon,
    requiresSession: true,
    group: 'manage',
  },
];

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
const ADMIN_MCP = '#/admin/mcp';
const ADMIN_API_USAGE = '#/admin/api-usage';
const ADMIN_AI_USAGE = '#/admin/ai-usage';
const ADMIN_AUDIT = '#/admin/audit';
const ADMIN_NETWORK = '#/admin/network-access';
const ADMIN_FRONTENDS = '#/admin/frontends';
const ADMIN_AI = '#/admin/ai';
const ADMIN_DIRECTORIES = '#/admin/directories';
const CREATE_TICKET = '#/create';
const ADMIN_WORKFLOWS = '#/admin/workflows';
const ADMIN_USERS = '#/admin/users';
const ADMIN_GROUPS = '#/admin/groups';
const ADMIN_TEAMS = '#/admin/teams';
const ADMIN_TRACKS = '#/admin/tracks';
const ADMIN_WORKFLOW_MAPS = '#/admin/workflow-maps';
const ADMIN_FIELDS = '#/admin/fields';
const ADMIN_PERMISSIONS = '#/admin/permissions';
const ADMIN_SETS = '#/admin/configuration-sets';
const ADMIN_GUARDRAILS = '#/admin/guardrails';
const ADMIN_IMPORTS = '#/admin/imports';
const ACCOUNT = '#/account';
/** Every section of the guided tutorial, to start or do again (ADR-115). */
const TUTORIALS = '#/settings/tutorials';
/** A ticket by key (#/tickets/ABC-1); its attachments until the ticket view arrives (M1-051). */
const TICKET = '#/tickets';
const BULK = '#/bulk';
/** A board by id (#/boards/7), and the list of boards at #/boards (M1-043). */
const BOARDS = '#/boards';
/** A track's summary by key (M1-064); the list of tracks itself is still to come. */
const TRACK_SUMMARY = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})(?:[/?]|$)/;
/** A track's releases hub and a release's page (M1-050). */
const TRACK_RELEASES = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})\/releases(?:[/?]|$)/;
const RELEASE = /^#\/releases\/(\d{1,10})(?:[/?]|$)/;
/** A track's calendar (M1-049). */
const TRACK_CALENDAR = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})\/calendar(?:[/?]|$)/;
/** A track's list (M1-049). */
const TRACK_LIST = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})\/list(?:[/?]|$)/;
/** A track's timeline (M1-048). */
const TRACK_TIMELINE = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})\/timeline(?:[/?]|$)/;
/** Dashboards (M1-064): the list, one by id, and one as a wallboard turning to the next. */
const DASHBOARDS = '#/dashboards';
const SIGN_IN = '#/sign-in';
const PASSWORD_LINK = '#/password';
const UNSUBSCRIBE = '#/unsubscribe';
/** An MCP client's OAuth request waiting for the person's answer (M1-072). */
const OAUTH_CONSENT = '#/oauth/consent';
const HOME = '#/home';
/** A filter, board or dashboard of the tracker an import came from, by its id (M1-128). */
const IMPORTED_LINK = '#/imported';

/** A path segment of the hash, decoded; as it is when it is not valid percent-encoding. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const goHome = () => {
  navigate(HOME);
};

/**
 * After signing in on this backend's page: back to the frontend on another site that sent the
 * person here (its authorization, M1-107), or the start page.
 */
const afterSignIn = () => {
  const next = continuation(currentRoute());
  if (next) window.location.assign(next);
  else goHome();
};

function Pages() {
  const t = useT();
  const hash = useRoute();
  const { session, signOut, setUser } = useSession();
  const signedIn = session.status === 'signed-in';
  const admin = signedIn && session.user.isSiteAdmin;
  const showSignIn = useCallback(() => {
    navigate(SIGN_IN);
  }, []);
  const registered = useRegisteredCommands();
  // The instance's name from the runtime configuration (M1-105) leads the page title.
  useEffect(() => {
    const instance = runtimeConfig.instanceName;
    if (instance) document.title = t('app.instanceTitle', { instance });
  }, [t]);
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
          navigate(item.href);
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
                navigate(ACCOUNT);
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
                navigate(ADMIN_SYSTEM);
              },
            },
            {
              id: 'go-tokens',
              labelId: 'admin.tokens.title' as const,
              keywords: ['api', 'revoke', 'rotate'],
              run: () => {
                navigate(ADMIN_TOKENS);
              },
            },
            {
              id: 'go-service-accounts',
              labelId: 'admin.serviceAccounts.title' as const,
              keywords: ['robot', 'bot', 'token'],
              run: () => {
                navigate(ADMIN_SERVICE_ACCOUNTS);
              },
            },
            {
              id: 'go-security',
              labelId: 'admin.security.title' as const,
              keywords: ['two-factor', '2fa', 'policy'],
              run: () => {
                navigate(ADMIN_SECURITY);
              },
            },
            {
              id: 'go-trash',
              labelId: 'admin.trash.title' as const,
              keywords: ['restore', 'undelete', 'deleted', 'retention'],
              run: () => {
                navigate(ADMIN_TRASH);
              },
            },
            {
              id: 'go-identity-providers',
              labelId: 'admin.sso.title' as const,
              keywords: ['sso', 'oidc', 'openid', 'identity provider', 'domains'],
              run: () => {
                navigate(ADMIN_IDENTITY_PROVIDERS);
              },
            },
            {
              id: 'go-directories',
              labelId: 'admin.directories.title' as const,
              keywords: ['ldap', 'active directory', 'directory', 'sync', 'groups'],
              run: () => {
                navigate(ADMIN_DIRECTORIES);
              },
            },
            {
              id: 'go-workflows',
              labelId: 'admin.workflows.title' as const,
              keywords: ['status', 'transition', 'guard', 'check', 'effect', 'publish'],
              run: () => {
                navigate(ADMIN_WORKFLOWS);
              },
            },
            {
              id: 'go-users',
              labelId: 'admin.users.title' as const,
              keywords: ['people', 'user', 'account', 'deactivate', 'invite', 'password'],
              run: () => {
                navigate(ADMIN_USERS);
              },
            },
            {
              id: 'go-admin-tracks',
              labelId: 'admin.tracks.title' as const,
              keywords: ['track', 'project', 'roles', 'members', 'archive'],
              run: () => {
                navigate(ADMIN_TRACKS);
              },
            },
            {
              id: 'go-workflow-maps',
              labelId: 'admin.maps.title' as const,
              keywords: ['workflow', 'map', 'ticket type', 'scheme'],
              run: () => {
                navigate(ADMIN_WORKFLOW_MAPS);
              },
            },
            {
              id: 'go-fields',
              labelId: 'admin.fields.title' as const,
              keywords: ['field', 'custom field', 'options', 'choice'],
              run: () => {
                navigate(ADMIN_FIELDS);
              },
            },
            {
              id: 'go-permissions',
              labelId: 'admin.permissions.title' as const,
              keywords: ['permission', 'role', 'access policy', 'grant', 'scheme'],
              run: () => {
                navigate(ADMIN_PERMISSIONS);
              },
            },
            {
              id: 'go-configuration-sets',
              labelId: 'admin.sets.title' as const,
              keywords: ['type set', 'field rules', 'required', 'hidden', 'scheme'],
              run: () => {
                navigate(ADMIN_SETS);
              },
            },
            {
              id: 'go-imports',
              labelId: 'admin.imports.title' as const,
              keywords: ['import', 'migrate', 'backup', 'csv', 'cloud', 'delta'],
              run: () => {
                navigate(ADMIN_IMPORTS);
              },
            },
            {
              id: 'go-guardrails',
              labelId: 'guardrails.title' as const,
              keywords: ['limits', 'guardrail', 'usage', 'quota'],
              run: () => {
                navigate(ADMIN_GUARDRAILS);
              },
            },
            {
              id: 'go-groups',
              labelId: 'admin.groups.title' as const,
              keywords: ['group', 'members', 'nested'],
              run: () => {
                navigate(ADMIN_GROUPS);
              },
            },
            {
              id: 'go-teams',
              labelId: 'admin.teams.title' as const,
              keywords: ['team', 'squad', 'members', 'lead'],
              run: () => {
                navigate(ADMIN_TEAMS);
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
  if (isRoute(hash, OAUTH_CONSENT)) return <ConsentPage />;

  // Which navigation entry is highlighted, what the main area shows, and whether it needs a
  // session. Account is personal settings, so Settings stays highlighted there.
  let active = 'settings';
  let guarded = true;
  let content: ReactNode;
  let wallboard = false;
  if (isRoute(hash, IMPORTED_LINK) || sourceLinkRoute(hash) !== null) {
    // A link from the tracker an import came from (M1-128): to the page it stands for.
    active = '';
    content = <ImportedLinkPage key={hash} route={hash} />;
  } else if (hash.startsWith(ADMIN_SYSTEM)) {
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
  } else if (isRoute(hash, ADMIN_MCP)) {
    content = <McpPage />;
  } else if (isRoute(hash, ADMIN_API_USAGE)) {
    content = <ApiUsagePage />;
  } else if (isRoute(hash, ADMIN_AI_USAGE)) {
    content = <AiUsagePage />;
  } else if (isRoute(hash, ADMIN_AUDIT)) {
    content = <AuditPage />;
  } else if (isRoute(hash, ADMIN_NETWORK)) {
    content = <NetworkAccessPage />;
  } else if (isRoute(hash, ADMIN_FRONTENDS)) {
    content = <FrontendsPage />;
  } else if (isRoute(hash, ADMIN_AI)) {
    content = <AiSettingsPage />;
  } else if (isRoute(hash, ADMIN_DIRECTORIES)) {
    content = <DirectoriesPage />;
  } else if (isRoute(hash, ADMIN_USERS)) {
    content = <UsersPage />;
  } else if (isRoute(hash, ADMIN_GROUPS)) {
    content = <GroupsPage />;
  } else if (isRoute(hash, ADMIN_TEAMS)) {
    content = <TeamsPage />;
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
  } else if (isRoute(hash, ADMIN_IMPORTS)) {
    content = <ImportsPage />;
  } else if (isRoute(hash, ADMIN_GUARDRAILS)) {
    content = <GuardrailsPage />;
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
  } else if (isRoute(hash, TUTORIALS)) {
    content = <TutorialsPage />;
  } else if (hash.startsWith(`${TICKET}/`) && hash.length > TICKET.length + 1) {
    active = 'tracks';
    const ticket = decodedSegment(hash.slice(TICKET.length + 1).split(/[/?]/)[0] ?? '');
    content = <TicketPage key={ticket} ticket={ticket} />;
  } else if (isRoute(hash, BOARDS)) {
    active = 'boards';
    guarded = true;
    const boardId = /^#\/boards\/(\d{1,10})(?:[/?]|$)/.exec(hash)?.[1];
    const settings = /^#\/boards\/\d{1,10}\/settings(?:[/?]|$)/.test(hash);
    // Sprints (M1-044): a Scrum board's backlog and a sprint's report.
    const backlog = /^#\/boards\/\d{1,10}\/backlog(?:[/?]|$)/.test(hash);
    const report = /^#\/boards\/\d{1,10}\/sprints\/(\d{1,10})\/report(?:[/?]|$)/.exec(hash)?.[1];
    // Flow reports (M1-061): #/boards/7/reports and #/boards/7/reports/<report>.
    const reports = /^#\/boards\/\d{1,10}\/reports(?:\/([a-z-]{1,40}))?(?:[/?]|$)/.exec(hash);
    const flowReport = BOARD_REPORTS.find((r) => r === reports?.[1]) ?? 'cumulative-flow';
    content = !boardId ? (
      <BoardsPage />
    ) : backlog ? (
      <BacklogPage key={`${boardId}-backlog`} boardId={Number(boardId)} />
    ) : report ? (
      <SprintReportPage
        key={`${boardId}-report-${report}`}
        boardId={Number(boardId)}
        sprintId={Number(report)}
      />
    ) : reports ? (
      <BoardReportsPage key={`${boardId}-reports`} boardId={Number(boardId)} report={flowReport} />
    ) : settings ? (
      <BoardSettingsPage key={`${boardId}-settings`} boardId={Number(boardId)} />
    ) : (
      <BoardPage key={boardId} boardId={Number(boardId)} />
    );
  } else if (hash.startsWith(`${BULK}/`) && hash.length > BULK.length + 1) {
    active = 'tracks';
    const id = decodedSegment(hash.slice(BULK.length + 1).split(/[/?]/)[0] ?? '');
    content = <BulkOperationPage key={id} id={id} />;
  } else if (TRACK_CALENDAR.test(hash)) {
    active = 'tracks';
    guarded = true;
    const key = TRACK_CALENDAR.exec(hash)?.[1] ?? '';
    content = <CalendarPage key={key} trackKey={key} />;
  } else if (TRACK_LIST.test(hash)) {
    active = 'tracks';
    guarded = true;
    const key = TRACK_LIST.exec(hash)?.[1] ?? '';
    content = <ListPage key={key} trackKey={key} />;
  } else if (TRACK_TIMELINE.test(hash)) {
    active = 'tracks';
    guarded = true;
    const key = TRACK_TIMELINE.exec(hash)?.[1] ?? '';
    content = <TimelinePage key={key} trackKey={key} />;
  } else if (TRACK_RELEASES.test(hash)) {
    active = 'tracks';
    guarded = true;
    const key = TRACK_RELEASES.exec(hash)?.[1] ?? '';
    content = <ReleasesPage key={key} trackKey={key} />;
  } else if (RELEASE.test(hash)) {
    active = 'tracks';
    guarded = true;
    const releaseId = Number(RELEASE.exec(hash)?.[1]);
    content = <ReleasePage key={releaseId} releaseId={releaseId} />;
  } else if (TRACK_SUMMARY.test(hash)) {
    active = 'tracks';
    guarded = true;
    const key = TRACK_SUMMARY.exec(hash)?.[1] ?? '';
    content = <TrackSummaryPage key={key} trackKey={key} />;
  } else if (isRoute(hash, DASHBOARDS)) {
    active = 'dashboards';
    guarded = true;
    const dashboardId = /^#\/dashboards\/(\d{1,10})(?:[/?]|$)/.exec(hash)?.[1];
    const wall = /^#\/dashboards\/\d{1,10}\/wallboard(?:\?(.*))?$/.exec(hash);
    const params = new URLSearchParams(wall?.[1] ?? '');
    const rotation = (params.get('rotate') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const seconds = Math.min(3600, Math.max(10, Number(params.get('seconds')) || 60));
    wallboard = Boolean(dashboardId && wall);
    content = !dashboardId ? (
      <DashboardsPage />
    ) : (
      <DashboardPage
        key={`${dashboardId}-${wallboard}`}
        id={Number(dashboardId)}
        wallboard={wallboard ? { rotation, seconds } : null}
      />
    );
  } else if (isRoute(hash, SIGN_IN)) {
    active = '';
    guarded = false;
    content = <SignInPage onSignedIn={afterSignIn} />;
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
      ) : active === 'home' && session.status === 'anonymous' ? (
        // Signed out, as on a fresh install's first visit: say where to start (M1-113). Not
        // while the session is still being checked, or a signed-in person would see it flash.
        <>
          <h1 className="page-title">{t('nav.home')}</h1>
          <p className="page-note">
            {t('home.signedOut')} <a href="#/sign-in">{t('auth.signIn')}</a>
          </p>
        </>
      ) : active === 'search' && signedIn ? (
        <SearchPage
          key={queryFromHash(hash) || String(savedSearchFromHash(hash) ?? '')}
          initialQuery={queryFromHash(hash)}
          initialSavedSearch={savedSearchFromHash(hash)}
        />
      ) : (
        <>
          <h1 className="page-title">{page ? t(page.labelId) : ''}</h1>
          <p className="page-note">{t('page.underConstruction')}</p>
        </>
      );
  }

  // A wallboard fills the window: no navigation, no top bar (RPT-004 (2)).
  if (wallboard) {
    return (
      <main className="wallboard-shell">
        <RequireSession>{content}</RequireSession>
      </main>
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
              <span aria-hidden="true" className="create-open-icon">
                +
              </span>
              <span className="create-open-label">{t('tickets.create.openDialog')}</span>
            </button>
          )}
          <CommandPalette commands={[...commands, ...registered]} />
          {signedIn && <ThemeToggle onChoose={appear} />}
          <UserMenu onSignedOut={showSignIn} />
        </>
      }
    >
      {guarded ? <RequireSession>{content}</RequireSession> : content}
      {creating && signedIn && <CreateTicketDialog onClose={() => setCreating(false)} />}
    </AppShell>
  );
}

/**
 * The language a person saved on their account applies once they are signed in, and is
 * remembered in the browser so the next visit starts in it. `?locale=` still wins.
 */
function FollowAccountLocale({
  current,
  onLocale,
}: {
  current: Locale;
  onLocale: (locale: Locale) => void;
}) {
  const { session } = useSession();
  const saved = session.status === 'signed-in' ? session.user.locale : null;
  useEffect(() => {
    const wanted = catalogueFor(saved);
    if (!wanted || localeInUrl()) return;
    rememberLocale(wanted);
    if (wanted !== current) onLocale(wanted);
  }, [saved, current, onLocale]);
  return null;
}

export interface AppProps {
  /** Overrides the locale detection; tests use it for the pseudo-locale. */
  locale?: Locale;
  /** A fixed session skips the backend check; tests and stories start where they need to. */
  session?: Session;
  onI18nError?: (error: Error) => void;
  /** Where the backend's versions come from (M1-106); tests give a fixed answer. */
  metaClient?: MetaClient;
}

export function App({ locale, session, onI18nError, metaClient }: AppProps) {
  const [chosen, setChosen] = useState<Locale>(() => locale ?? resolveLocale());
  return (
    <I18nProvider locale={chosen} {...(onI18nError ? { onError: onI18nError } : {})}>
      <SessionProvider {...(session ? { session } : {})}>
        {locale === undefined && <FollowAccountLocale current={chosen} onLocale={setChosen} />}
        <SyncProvider>
          <PaletteCommandsProvider>
            <VersionGate {...(metaClient ? { client: metaClient } : {})}>
              <Pages />
            </VersionGate>
          </PaletteCommandsProvider>
        </SyncProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
