import type { MessageId } from '../i18n/messages.en';
import type { AdminAccess } from './access';

/** One page of Administration. `href` is its own route; admin routes keep their paths. */
export interface AdminPage {
  id: string;
  href: string;
  labelId: MessageId;
  hintId: MessageId;
}

export interface AdminGroup {
  id: 'tracks' | 'people' | 'setup' | 'security' | 'integrations' | 'system';
  labelId: MessageId;
  purposeId: MessageId;
  pages: readonly AdminPage[];
}

export const ADMIN_HOME = '#/admin';

/**
 * Administration's groups and pages (ADR-114). A control that has no page yet is not listed:
 * notification policies join their group with their page.
 * The tracks someone runs lead the list, and are all a track's manager sees here.
 */
export const ADMIN_GROUPS: readonly AdminGroup[] = [
  {
    id: 'tracks',
    labelId: 'admin.group.tracks',
    purposeId: 'admin.group.tracksPurpose',
    pages: [
      {
        id: 'managed-tracks',
        href: '#/manage/tracks',
        labelId: 'settings.managedTracks',
        hintId: 'settings.managedTracksHint',
      },
    ],
  },
  {
    id: 'people',
    labelId: 'admin.group.people',
    purposeId: 'admin.group.peoplePurpose',
    pages: [
      {
        id: 'users',
        href: '#/admin/users',
        labelId: 'settings.users',
        hintId: 'settings.usersHint',
      },
      {
        id: 'groups',
        href: '#/admin/groups',
        labelId: 'settings.groups',
        hintId: 'settings.groupsHint',
      },
      {
        id: 'teams',
        href: '#/admin/teams',
        labelId: 'settings.teams',
        hintId: 'settings.teamsHint',
      },
      {
        id: 'permissions',
        href: '#/admin/permissions',
        labelId: 'settings.permissions',
        hintId: 'settings.permissionsHint',
      },
      {
        id: 'visibility',
        href: '#/admin/visibility',
        labelId: 'settings.visibility',
        hintId: 'settings.visibilityHint',
      },
      {
        id: 'permission-explainer',
        href: '#/admin/permission-explainer',
        labelId: 'settings.explainer',
        hintId: 'settings.explainerHint',
      },
    ],
  },
  {
    id: 'setup',
    labelId: 'admin.group.setup',
    purposeId: 'admin.group.setupPurpose',
    pages: [
      {
        id: 'tracks',
        href: '#/admin/tracks',
        labelId: 'settings.tracks',
        hintId: 'settings.tracksHint',
      },
      {
        id: 'ticket-templates',
        href: '#/admin/ticket-templates',
        labelId: 'settings.ticketTemplates',
        hintId: 'settings.ticketTemplatesHint',
      },
      {
        id: 'workflows',
        href: '#/admin/workflows',
        labelId: 'settings.workflows',
        hintId: 'settings.workflowsHint',
      },
      {
        id: 'workflow-maps',
        href: '#/admin/workflow-maps',
        labelId: 'settings.workflowMaps',
        hintId: 'settings.workflowMapsHint',
      },
      {
        id: 'fields',
        href: '#/admin/fields',
        labelId: 'settings.fields',
        hintId: 'settings.fieldsHint',
      },
      {
        id: 'configuration-sets',
        href: '#/admin/configuration-sets',
        labelId: 'settings.sets',
        hintId: 'settings.setsHint',
      },
      {
        id: 'layouts',
        href: '#/admin/layouts',
        labelId: 'settings.layouts',
        hintId: 'settings.layoutsHint',
      },
      {
        id: 'priorities',
        href: '#/admin/priorities',
        labelId: 'settings.priorities',
        hintId: 'settings.prioritiesHint',
      },
      {
        id: 'track-sets',
        href: '#/admin/track-sets',
        labelId: 'settings.trackSets',
        hintId: 'settings.trackSetsHint',
      },
    ],
  },
  {
    id: 'security',
    labelId: 'admin.group.security',
    purposeId: 'admin.group.securityPurpose',
    pages: [
      {
        id: 'security',
        href: '#/admin/security',
        labelId: 'settings.security',
        hintId: 'settings.securityHint',
      },
      {
        id: 'identity-providers',
        href: '#/admin/identity-providers',
        labelId: 'settings.singleSignOn',
        hintId: 'settings.singleSignOnHint',
      },
      {
        id: 'directories',
        href: '#/admin/directories',
        labelId: 'settings.directories',
        hintId: 'settings.directoriesHint',
      },
      {
        id: 'network-access',
        href: '#/admin/network-access',
        labelId: 'settings.networkAccess',
        hintId: 'settings.networkAccessHint',
      },
      {
        id: 'audit',
        href: '#/admin/audit',
        labelId: 'settings.auditLog',
        hintId: 'settings.auditLogHint',
      },
    ],
  },
  {
    id: 'integrations',
    labelId: 'admin.group.integrations',
    purposeId: 'admin.group.integrationsPurpose',
    pages: [
      {
        id: 'tokens',
        href: '#/admin/tokens',
        labelId: 'settings.apiTokens',
        hintId: 'settings.apiTokensHint',
      },
      {
        id: 'service-accounts',
        href: '#/admin/service-accounts',
        labelId: 'settings.serviceAccounts',
        hintId: 'settings.serviceAccountsHint',
      },
      { id: 'mcp', href: '#/admin/mcp', labelId: 'settings.mcp', hintId: 'settings.mcpHint' },
      {
        id: 'frontends',
        href: '#/admin/frontends',
        labelId: 'settings.frontends',
        hintId: 'settings.frontendsHint',
      },
      {
        id: 'webhooks',
        href: '#/admin/webhooks',
        labelId: 'settings.webhooks',
        hintId: 'settings.webhooksHint',
      },
      { id: 'ai', href: '#/admin/ai', labelId: 'settings.ai', hintId: 'settings.aiHint' },
      {
        id: 'ai-usage',
        href: '#/admin/ai-usage',
        labelId: 'settings.aiUsage',
        hintId: 'settings.aiUsageHint',
      },
      {
        id: 'ai-limits',
        href: '#/admin/ai-limits',
        labelId: 'settings.aiLimits',
        hintId: 'settings.aiLimitsHint',
      },
    ],
  },
  {
    id: 'system',
    labelId: 'admin.group.system',
    purposeId: 'admin.group.systemPurpose',
    pages: [
      {
        id: 'system',
        href: '#/admin/system',
        labelId: 'settings.systemStatus',
        hintId: 'settings.systemStatusHint',
      },
      {
        id: 'api-usage',
        href: '#/admin/api-usage',
        labelId: 'settings.apiUsage',
        hintId: 'settings.apiUsageHint',
      },
      {
        id: 'imports',
        href: '#/admin/imports',
        labelId: 'settings.imports',
        hintId: 'settings.importsHint',
      },
      {
        id: 'trash',
        href: '#/admin/trash',
        labelId: 'settings.trash',
        hintId: 'settings.trashHint',
      },
      {
        id: 'guardrails',
        href: '#/admin/guardrails',
        labelId: 'settings.guardrails',
        hintId: 'settings.guardrailsHint',
      },
    ],
  },
];

/** The groups a person sees: a configuration administrator only the setup pages (ADR-114). */
export function groupsFor(access: AdminAccess): readonly AdminGroup[] {
  if (access === 'site') return ADMIN_GROUPS;
  if (access === 'setup') return ADMIN_GROUPS.filter((g) => g.id === 'setup' || g.id === 'tracks');
  return access === 'tracks' ? ADMIN_GROUPS.filter((g) => g.id === 'tracks') : [];
}

export const adminGroupHref = (group: AdminGroup) => `${ADMIN_HOME}/group/${group.id}`;

const isRouteOf = (hash: string, href: string) =>
  hash === href || hash.startsWith(`${href}?`) || hash.startsWith(`${href}/`);

/** The page and group an address belongs to, with its sub-pages (a workflow's editor, say). */
export function adminPlace(hash: string): { group: AdminGroup; page: AdminPage | null } | null {
  for (const group of ADMIN_GROUPS) {
    if (isRouteOf(hash, adminGroupHref(group))) return { group, page: null };
    const page = group.pages.find((p) => isRouteOf(hash, p.href));
    if (page) return { group, page };
  }
  return null;
}

/** Whether this address is the group's own page, and which group. */
export function adminGroupOf(hash: string): AdminGroup | null {
  const place = adminPlace(hash);
  return place && !place.page ? place.group : null;
}
