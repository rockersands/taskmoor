import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { useAdminAccess } from './access';
import { type AdminGroup, groupsFor } from './sections';

/** The links of one group with what each page is for. */
export function AdminPageLinks({ group }: { group: AdminGroup }) {
  const t = useT();
  return (
    <ul className="link-list admin-page-links">
      {group.pages.map((page) => (
        <li key={page.id}>
          <a href={routeHref(page.href)}>{t(page.labelId)}</a>
          <p className="page-note">{t(page.hintId)}</p>
        </li>
      ))}
    </ul>
  );
}

/** A group's own page, where a breadcrumb leads back to: what is in it and what each page does. */
export function AdminGroupPage({ group }: { group: AdminGroup }) {
  const t = useT();
  const titleId = useId();
  const access = useAdminAccess();
  // The group as this person sees it: a configuration administrator only its setup pages (T-322).
  const shown = groupsFor(access ?? 'none').find((g) => g.id === group.id);
  const allowed = shown !== undefined;
  return (
    <section aria-labelledby={titleId} className="page admin-page">
      <PageHeader
        titleId={titleId}
        title={t(group.labelId)}
        {...(allowed ? { purpose: t(group.purposeId), about: t('admin.group.about') } : {})}
      />
      {access && !allowed && <p className="page-note">{t('admin.forbidden')}</p>}
      {shown && (
        <div className="glass-card admin-panel">
          <AdminPageLinks group={shown} />
        </div>
      )}
    </section>
  );
}
