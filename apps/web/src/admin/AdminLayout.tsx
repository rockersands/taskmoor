import { type ReactNode, useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useMediaQuery } from '../shell/useMediaQuery';
import { useAdminAccess } from './access';
import { ADMIN_HOME, adminGroupHref, adminPlace, groupsFor } from './sections';

/** Below this width the section's navigation folds away above the page. */
const NARROW = '(max-width: 1023px)';

/**
 * Administration's own navigation and each page's breadcrumb back to its group (ADR-114). The
 * pages inside keep their routes and their own guards: someone who may not use a page still
 * lands on its refusal, with no navigation they cannot use.
 */
export function AdminLayout({ hash, children }: { hash: string; children: ReactNode }) {
  const t = useT();
  const access = useAdminAccess();
  const narrow = useMediaQuery(NARROW);
  if (!access || access === 'none') return <>{children}</>;
  const overview = hash === ADMIN_HOME || hash.startsWith(`${ADMIN_HOME}?`);
  const nav = <AdminNav hash={hash} overview={overview} />;
  return (
    <div className="admin-section">
      {narrow ? (
        // Open on the overview, where the list is the way in; folded on a page, so it comes first.
        <details key={hash} className="admin-nav-fold glass-card" open={overview}>
          <summary>{t('admin.nav.menu')}</summary>
          {nav}
        </details>
      ) : (
        <aside className="admin-nav-side glass-card">{nav}</aside>
      )}
      <div className="admin-section-main">
        {!overview && <AdminBreadcrumb hash={hash} />}
        {children}
      </div>
    </div>
  );
}

function AdminNav({ hash, overview }: { hash: string; overview: boolean }) {
  const t = useT();
  const baseId = useId();
  const access = useAdminAccess();
  const current = adminPlace(hash)?.page?.id;
  return (
    <nav aria-label={t('admin.nav.label')} className="admin-nav">
      <ul className="admin-nav-list">
        <li>
          <a
            className="admin-nav-link"
            href={routeHref(ADMIN_HOME)}
            aria-current={overview ? 'page' : undefined}
          >
            {t('admin.overview.title')}
          </a>
        </li>
      </ul>
      {groupsFor(access ?? 'none').map((group) => {
        const headingId = `${baseId}-${group.id}`;
        return (
          <div key={group.id} className="admin-nav-group">
            <p id={headingId} className="nav-group-title">
              {t(group.labelId)}
            </p>
            <ul className="admin-nav-list" aria-labelledby={headingId}>
              {group.pages.map((page) => (
                <li key={page.id}>
                  <a
                    className="admin-nav-link"
                    href={routeHref(page.href)}
                    aria-current={page.id === current ? 'page' : undefined}
                  >
                    {t(page.labelId)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Administration, then the page's group, then the page itself. */
export function AdminBreadcrumb({ hash }: { hash: string }) {
  const t = useT();
  const place = adminPlace(hash);
  return (
    <nav aria-label={t('admin.breadcrumb')} className="admin-breadcrumb">
      <ol>
        <li>
          <a href={routeHref(ADMIN_HOME)}>{t('nav.administration')}</a>
        </li>
        {place && place.page === null && <li aria-current="page">{t(place.group.labelId)}</li>}
        {place?.page && (
          <>
            <li>
              <a href={routeHref(adminGroupHref(place.group))}>{t(place.group.labelId)}</a>
            </li>
            <li aria-current="page">{t(place.page.labelId)}</li>
          </>
        )}
      </ol>
    </nav>
  );
}
