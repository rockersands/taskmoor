import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';

/** Settings: the person's own account for everyone, administration for site administrators. */
export function SettingsPage() {
  const t = useT();
  const { session } = useSession();
  const personalId = useId();
  const adminId = useId();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  return (
    <>
      <h1 className="page-title">{t('nav.settings')}</h1>
      <section aria-labelledby={personalId} className="settings-section">
        <h2 id={personalId} className="facts-title">
          {t('settings.personal')}
        </h2>
        <ul className="link-list">
          <li>
            <a href={routeHref('#/account')}>{t('settings.account')}</a>
            <p className="page-note">{t('settings.accountHint')}</p>
          </li>
          <li>
            <a href={routeHref('#/manage/tracks')}>{t('settings.managedTracks')}</a>
            <p className="page-note">{t('settings.managedTracksHint')}</p>
          </li>
        </ul>
      </section>
      {admin && (
        <section aria-labelledby={adminId} className="settings-section">
          <h2 id={adminId} className="facts-title">
            {t('settings.administration')}
          </h2>
          <ul className="link-list">
            <li>
              <a href={routeHref('#/admin/users')}>{t('settings.users')}</a>
              <p className="page-note">{t('settings.usersHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/groups')}>{t('settings.groups')}</a>
              <p className="page-note">{t('settings.groupsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/teams')}>{t('settings.teams')}</a>
              <p className="page-note">{t('settings.teamsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/system')}>{t('settings.systemStatus')}</a>
              <p className="page-note">{t('settings.systemStatusHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/tokens')}>{t('settings.apiTokens')}</a>
              <p className="page-note">{t('settings.apiTokensHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/service-accounts')}>{t('settings.serviceAccounts')}</a>
              <p className="page-note">{t('settings.serviceAccountsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/security')}>{t('settings.security')}</a>
              <p className="page-note">{t('settings.securityHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/imports')}>{t('settings.imports')}</a>
              <p className="page-note">{t('settings.importsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/trash')}>{t('settings.trash')}</a>
              <p className="page-note">{t('settings.trashHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/mcp')}>{t('settings.mcp')}</a>
              <p className="page-note">{t('settings.mcpHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/ai')}>{t('settings.ai')}</a>
              <p className="page-note">{t('settings.aiHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/api-usage')}>{t('settings.apiUsage')}</a>
              <p className="page-note">{t('settings.apiUsageHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/ai-usage')}>{t('settings.aiUsage')}</a>
              <p className="page-note">{t('settings.aiUsageHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/audit')}>{t('settings.auditLog')}</a>
              <p className="page-note">{t('settings.auditLogHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/network-access')}>{t('settings.networkAccess')}</a>
              <p className="page-note">{t('settings.networkAccessHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/frontends')}>{t('settings.frontends')}</a>
              <p className="page-note">{t('settings.frontendsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/identity-providers')}>{t('settings.singleSignOn')}</a>
              <p className="page-note">{t('settings.singleSignOnHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/directories')}>{t('settings.directories')}</a>
              <p className="page-note">{t('settings.directoriesHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/workflows')}>{t('settings.workflows')}</a>
              <p className="page-note">{t('settings.workflowsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/workflow-maps')}>{t('settings.workflowMaps')}</a>
              <p className="page-note">{t('settings.workflowMapsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/tracks')}>{t('settings.tracks')}</a>
              <p className="page-note">{t('settings.tracksHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/fields')}>{t('settings.fields')}</a>
              <p className="page-note">{t('settings.fieldsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/configuration-sets')}>{t('settings.sets')}</a>
              <p className="page-note">{t('settings.setsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/guardrails')}>{t('settings.guardrails')}</a>
              <p className="page-note">{t('settings.guardrailsHint')}</p>
            </li>
            <li>
              <a href={routeHref('#/admin/permissions')}>{t('settings.permissions')}</a>
              <p className="page-note">{t('settings.permissionsHint')}</p>
            </li>
          </ul>
        </section>
      )}
    </>
  );
}
