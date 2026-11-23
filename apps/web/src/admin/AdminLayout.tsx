import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { NotFoundContext } from '../shell/NotFoundPage';
import { useMediaQuery } from '../shell/useMediaQuery';
import { useAdminAccess } from './access';
import { ADMIN_HOME, type AdminGroup, adminGroupHref, adminPlace, groupsFor } from './sections';

/** Below this width the section's navigation folds away above the page. */
const NARROW = '(max-width: 1023px)';

/**
 * The most groups the overview's list opens: a configuration administrator's three (one of them a
 * single page) fit; a site administrator's six would push the last ones out of view (S3-AD-2).
 */
const OPEN_ON_OVERVIEW = 3;

/** A step a page adds after its own name in the breadcrumb: a track, a workflow, a sub-page. */
export interface AdminCrumb {
  label: string;
  /** Where the step leads; the last step is the page itself and has none. */
  href?: string;
}

/** The address each list page last left, by the page's own route: its filters with it. */
const pageAddresses = new Map<string, string>();

/**
 * A list page whose address keeps its filters (People's `?show=`, `?role=`) says where it is, so
 * the breadcrumb's step back to it from a page below (a person) finds the list as it was left.
 */
export function keepPageAddress(page: string, route: string) {
  pageAddresses.set(page, route);
}

const TrailContext = createContext<((trail: readonly AdminCrumb[] | null) => void) | null>(null);

/**
 * Lets a page that sits below an Administration page say where it is: a track's own Layout sets
 * end the breadcrumb at "SWEEPL › Layout sets", a workflow at its name (AD-15, AD-28). Outside
 * Administration it does nothing.
 */
export function useAdminTrail(trail: readonly AdminCrumb[] | null) {
  const set = useContext(TrailContext);
  const key = trail ? JSON.stringify(trail) : '';
  useEffect(() => {
    if (!set) return;
    set(key ? (JSON.parse(key) as AdminCrumb[]) : null);
    return () => set(null);
  }, [set, key]);
}

/**
 * Administration's own navigation and each page's breadcrumb back to its group (ADR-114). The
 * pages inside keep their routes and their own guards: someone who may not use a page still
 * lands on its refusal, with no navigation they cannot use.
 */
export function AdminLayout({ hash, children }: { hash: string; children: ReactNode }) {
  const t = useT();
  const access = useAdminAccess();
  const narrow = useMediaQuery(NARROW);
  const [trail, setTrailState] = useState<readonly AdminCrumb[] | null>(null);
  const setTrail = useCallback((next: readonly AdminCrumb[] | null) => setTrailState(next), []);
  // A not-found page inside Administration, such as a workflow that does not exist, marks no
  // section (D4, PL-43): the app's own navigation marks nothing, so neither does this list.
  const tellFrame = useContext(NotFoundContext);
  const [notFoundAt, setNotFoundAt] = useState<string | null>(null);
  const tellNotFound = useCallback(
    (route: string | null) => {
      setNotFoundAt(route);
      tellFrame?.(route);
    },
    [tellFrame],
  );
  if (!access || access === 'none') return <>{children}</>;
  const lost = notFoundAt !== null && notFoundAt === hash;
  const overview = hash === ADMIN_HOME || hash.startsWith(`${ADMIN_HOME}?`);
  // Which groups are open starts again on each group: what a person opened by hand stays open
  // while they stay within the group.
  const nav = (
    <AdminNav
      key={adminPlace(hash)?.group.id ?? 'overview'}
      hash={hash}
      overview={overview}
      lost={lost}
    />
  );
  // On a phone the list of pages is one bar at the top of every page, the overview too, with a
  // chevron saying it opens (D21). On a wide screen it stays beside the page while it scrolls.
  const side = narrow ? (
    <details key={hash} className="admin-nav-fold glass-card">
      <summary className="admin-disclosure">{t('admin.nav.menu')}</summary>
      {nav}
    </details>
  ) : (
    <aside className="admin-nav-side glass-card">{nav}</aside>
  );
  return (
    <TrailContext.Provider value={setTrail}>
      <NotFoundContext.Provider value={tellNotFound}>
        <div className="admin-section">
          {side}
          <div className="admin-section-main">
            {!overview && <AdminBreadcrumb hash={hash} trail={trail} />}
            {children}
          </div>
        </div>
      </NotFoundContext.Provider>
    </TrailContext.Provider>
  );
}

function AdminNav({
  hash,
  overview,
  lost,
}: {
  hash: string;
  overview: boolean;
  /** The page at this address is a not-found page: nothing is marked current. */
  lost: boolean;
}) {
  const t = useT();
  const access = useAdminAccess();
  const place = adminPlace(hash);
  const groups = groupsFor(access ?? 'none');
  const currentGroup = place?.group.id ?? null;
  // A page shows only its own group's pages, so the list stays short (D18); any other group
  // opens from its heading. The overview, which lists every page itself, shows every group's
  // heading closed, so all of them fit beside it (S3-AD-2); with three groups or fewer, as for
  // someone who only runs tracks or sets them up, they stay open.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        currentGroup
          ? [currentGroup]
          : groups.length <= OPEN_ON_OVERVIEW
            ? groups.map((g) => g.id)
            : [],
      ),
  );
  const toggle = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
      {groups.map((group) => (
        <AdminNavGroup
          key={group.id}
          group={group}
          open={opened.has(group.id)}
          onToggle={() => toggle(group.id)}
          groupCurrent={
            !lost && place !== null && place.page === null && place.group.id === group.id
          }
          currentPage={lost ? null : (place?.page?.id ?? null)}
        />
      ))}
    </nav>
  );
}

function AdminNavGroup({
  group,
  open,
  onToggle,
  groupCurrent,
  currentPage,
}: {
  group: AdminGroup;
  open: boolean;
  onToggle: () => void;
  groupCurrent: boolean;
  currentPage: string | null;
}) {
  const t = useT();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const listId = `${baseId}-pages`;
  return (
    <div className="admin-nav-group">
      <button
        type="button"
        id={headingId}
        className="admin-nav-group-title admin-disclosure"
        aria-expanded={open}
        aria-controls={listId}
        aria-current={groupCurrent ? 'page' : undefined}
        onClick={onToggle}
      >
        {t(group.labelId)}
      </button>
      <ul id={listId} className="admin-nav-list" aria-labelledby={headingId} hidden={!open}>
        {group.pages.map((page) => (
          <li key={page.id}>
            <a
              className="admin-nav-link"
              href={routeHref(page.href)}
              aria-current={page.id === currentPage ? 'page' : undefined}
            >
              {t(page.labelId)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Administration, then the page's group, then the page itself, then whatever the page adds (a
 * track and its sub-page, a workflow). A group the person may not open is named without a link,
 * and so is a page of it: someone who runs a track opens its own workflow, but the list of
 * workflows refuses them (T-227). Each separator travels with the step before it, so a wrapped line never starts with
 * one (AD-14).
 */
export function AdminBreadcrumb({
  hash,
  trail = null,
}: {
  hash: string;
  trail?: readonly AdminCrumb[] | null;
}) {
  const t = useT();
  const access = useAdminAccess();
  const place = adminPlace(hash);
  const groupAllowed =
    place !== null && groupsFor(access ?? 'none').some((g) => g.id === place.group.id);
  const steps: AdminCrumb[] = [{ label: t('nav.administration'), href: ADMIN_HOME }];
  if (place) {
    steps.push({
      label: t(place.group.labelId),
      ...(groupAllowed && place.page ? { href: adminGroupHref(place.group) } : {}),
    });
    if (place.page) {
      const more = trail && trail.length > 0;
      steps.push({
        label: t(place.page.labelId),
        ...(more && groupAllowed
          ? { href: pageAddresses.get(place.page.href) ?? place.page.href }
          : {}),
      });
      if (more) steps.push(...trail);
    }
  }
  return (
    <nav aria-label={t('admin.breadcrumb')} className="admin-breadcrumb">
      <ol>
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are a fixed path, in order
            <li key={i} {...(last ? { 'aria-current': 'page' as const } : {})}>
              {step.href && !last ? <a href={routeHref(step.href)}>{step.label}</a> : step.label}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
