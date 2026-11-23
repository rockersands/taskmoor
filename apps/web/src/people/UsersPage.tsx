import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { keepPageAddress } from '../admin/AdminLayout';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { pageAfter } from '../api/pages';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, onRouteChange, replaceRoute, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type PeopleClient,
  peopleClient,
  ROLE_FILTERS,
  type RoleFilter,
  type User,
  type UserStatus,
} from './client';
import { peopleRefusal, ROLE_FILTER_LABEL, roleWords } from './peopleWords';

/** The People page's own address; a person's page is under it (T-331). */
export const USERS_ROUTE = '#/admin/users';
export const personHref = (id: number) => `${USERS_ROUTE}/${id}`;

const STATUSES: readonly UserStatus[] = ['active', 'deactivated', 'all'];

/** Whether the route is the list's own, with or without its filters. */
const isListRoute = (route: string) => route === USERS_ROUTE || route.startsWith(`${USERS_ROUTE}?`);

/** The route's query, empty without one. */
const paramsOf = (route: string) =>
  new URLSearchParams(route.includes('?') ? route.slice(route.indexOf('?') + 1) : '');

interface Filters {
  status: UserStatus;
  role: RoleFilter;
  query: string;
}

/**
 * The filters the address keeps (T-331): `#/admin/users?show=all&role=ai_admin&q=grace`, so going
 * back from a person's page, by Back or by the breadcrumb, finds the list as it was. Other
 * addresses (stories, tests) keep nothing.
 */
function filtersInAddress(route = currentRoute()): Filters {
  const kept: Filters = { status: 'active', role: 'any', query: '' };
  if (!isListRoute(route)) return kept;
  const params = paramsOf(route);
  const show = params.get('show');
  const role = params.get('role');
  return {
    status: STATUSES.includes(show as UserStatus) ? (show as UserStatus) : kept.status,
    role: (ROLE_FILTERS as readonly string[]).includes(role ?? '') ? (role as RoleFilter) : 'any',
    query: params.get('q') ?? '',
  };
}

/**
 * Writes the filters into the address, in place: only `show`, `role` and `q` change, and every
 * other parameter stays (`?locale=` above all, NFR-006). The breadcrumb's People step leads back
 * to the address it leaves.
 */
function keepFilters({ status, role, query }: Filters) {
  const route = currentRoute();
  if (!isListRoute(route)) return;
  const params = paramsOf(route);
  const set = (name: string, value: string | null) =>
    value === null ? params.delete(name) : params.set(name, value);
  set('show', status === 'active' ? null : status);
  set('role', role === 'any' ? null : role);
  set('q', query === '' ? null : query);
  const search = params.toString();
  const next = search ? `${USERS_ROUTE}?${search}` : USERS_ROUTE;
  if (next !== route) replaceRoute(next);
  keepPageAddress(USERS_ROUTE, next);
}

export interface UsersPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PeopleClient;
}

/**
 * People (IAM-008), for site administrators: find someone by name or email, by status and by
 * role, and add a person (who gets a one-time link to set a password). Each row says which
 * administrator roles the person holds, how many tracks they run, or "Member" (T-331; IAM-009,
 * IAM-028), and has one Edit link to the person's page, which holds every action for them: the
 * rows hold no other action (the user's request of 2026-11-17).
 */
export function UsersPage({ client = peopleClient }: UsersPageProps) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const searchId = useId();
  const statusId = useId();
  const roleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [query, setQuery] = useState(() => filtersInAddress().query);
  const [status, setStatus] = useState<UserStatus>(() => filtersInAddress().status);
  const [role, setRole] = useState<RoleFilter>(() => filtersInAddress().role);
  const [state, setState] = useState<
    | { status: 'loading' }
    | ({ status: 'loaded' } & Listed)
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  // Each reading of the list from its start takes the next number; a page that arrives after a
  // newer reading began (another search, another status, a change) is dropped (T-307).
  const reading = useRef(0);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const adding = useNewForm();

  /** The person the focus goes to: the first one the last page brought, as Show more goes. */
  const [focusId, setFocusId] = useState<number | null>(null);
  const focusRow = useCallback((row: HTMLLIElement | null) => row?.focus(), []);

  /**
   * Reads the list from its start: one page after a search, or as many as were shown (`keep`)
   * after a change, so Show more's pages stay open. Resolves to what it shows, or null.
   */
  const load = useCallback(
    async (keep = 0): Promise<Listed | null> => {
      const mine = ++reading.current;
      const asked = { query: query.trim(), show: status, role };
      const start: Listed = {
        ...asked,
        users: [],
        total: 0,
        read: 0,
        lastId: null,
        end: false,
        more: false,
      };
      try {
        let listed = start;
        let moved = 0;
        do {
          const got = await pageAfter(
            listed,
            (offset) => client.users(asked.query, asked.show, offset, asked.role),
            (page) => page.users,
            moved < MOST_MOVES,
          );
          if (mine !== reading.current) return null;
          if (got === null) {
            // The list moved while it was read: from its start again.
            moved += 1;
            listed = start;
          } else {
            listed = withPage(listed, got.rows, got.page.total);
          }
        } while (listed === start || (listed.read < Math.min(keep, listed.total) && !listed.end));
        setState({ status: 'loaded', ...listed });
        return listed;
      } catch (error) {
        if (mine !== reading.current || expired(error)) return null;
        if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
        else setState({ status: 'failed' });
        return null;
      }
    },
    [client, query, status, role, expired],
  );
  const shown = state.status === 'loaded' ? state.read : 0;

  /**
   * Show more: the next page of the same search, after the rows already shown (T-307). When
   * the list moved meanwhile (someone left it or came), it is read again from its start, one
   * page further, so nobody is skipped. The last page puts the focus on the first person it
   * brought.
   */
  const more = async () => {
    if (state.status !== 'loaded' || state.more) return;
    const mine = reading.current;
    const from = state;
    setState({ ...from, more: true });
    setFocusId(null);
    try {
      const got = await pageAfter(
        from,
        (offset) => client.users(from.query, from.show, offset, from.role),
        (page) => page.users,
      );
      if (mine !== reading.current) return;
      const after =
        got === null ? await load(from.read + 1) : withPage(from, got.rows, got.page.total);
      if (after === null) return;
      if (got !== null) setState({ status: 'loaded', ...after, more: false });
      if (after.end || after.read >= after.total) {
        const before = new Set(from.users.map((u) => u.id));
        setFocusId((after.users.find((u) => !before.has(u.id)) ?? after.users.at(-1))?.id ?? null);
      }
    } catch (error) {
      if (mine !== reading.current || expired(error)) return;
      setState((s) => (s.status === 'loaded' ? { ...s, more: false } : s));
      setProblem(t('admin.users.failed'));
    }
  };

  useEffect(() => {
    if (notAdmin) return;
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, notAdmin, query]);

  // The address keeps the filters, so going back from a person's page finds them (T-331).
  useEffect(() => keepFilters({ status, role, query }), [status, role, query]);
  // And the list follows the address when it changes under the page: People in Administration's
  // navigation is the list with no filter, whatever this one showed.
  useEffect(
    () =>
      onRouteChange(() => {
        const route = currentRoute();
        if (!isListRoute(route)) return;
        const kept = filtersInAddress(route);
        setStatus(kept.status);
        setRole(kept.role);
        setQuery(kept.query);
      }),
    [],
  );

  const when = (iso: string | null) =>
    iso ? intl.formatDate(new Date(iso), { dateStyle: 'medium' }) : t('admin.users.never');

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.users.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('settings.usersHint'),
              about: t('admin.users.intro'),
              // A filled "New …" button that opens the form, as on every list page (D11, AD-19).
              actions: (
                <NewButton
                  label={t('admin.users.add')}
                  open={adding.open}
                  onToggle={adding.toggle}
                  ref={adding.button}
                  data-tutorial="admin-user-new"
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.users.forbidden')}</p>
      ) : (
        <>
          {adding.open && (
            <AddUser
              client={client}
              onAdded={(user, activation) => {
                adding.close();
                setMessage(t('admin.users.added', { name: user.name }));
                setProblem(null);
                setLink(activation ? { name: user.name, url: activation } : null);
                void load(shown);
              }}
              onCancel={adding.close}
              onProblem={(error) => setProblem(peopleRefusal(t, error))}
            />
          )}
          {link && (
            <div className="people-link">
              <p className="page-note">{t('admin.users.linkHint', { name: link.name })}</p>
              <input
                type="text"
                readOnly
                value={link.url}
                aria-label={t('admin.users.linkFor', { name: link.name })}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="button-secondary" onClick={() => setLink(null)}>
                {t('admin.users.linkDone')}
              </button>
            </div>
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          <div className="glass-card people-card people-filters">
            <div className="form-field">
              <label htmlFor={searchId} className="form-label">
                {t('admin.users.search')}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={statusId} className="form-label">
                {t('admin.users.show')}
              </label>
              <select
                id={statusId}
                value={status}
                onChange={(event) => setStatus(event.target.value as UserStatus)}
              >
                <option value="active">{t('admin.users.status.active')}</option>
                <option value="deactivated">{t('admin.users.status.deactivated')}</option>
                <option value="all">{t('admin.users.status.all')}</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={roleId} className="form-label">
                {t('admin.users.filter.role')}
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(event) => setRole(event.target.value as RoleFilter)}
              >
                {(['any', ...ROLE_FILTERS] as const).map((choice) => (
                  <option key={choice} value={choice}>
                    {t(ROLE_FILTER_LABEL[choice])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {state.status === 'loading' && <p className="page-note">{t('admin.users.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.users.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            (state.users.length === 0 ? (
              <EmptyState title={t('admin.users.none')}>{t('empty.users.body')}</EmptyState>
            ) : (
              <>
                <p className="page-note">{t('admin.users.count', { count: state.total })}</p>
                <ul className="people-list people-list-users">
                  {state.users.map((u) => (
                    <li
                      key={u.id}
                      className="people-item"
                      tabIndex={u.id === focusId ? -1 : undefined}
                      ref={u.id === focusId ? focusRow : undefined}
                    >
                      <div className="people-main">
                        <p className="people-name">
                          {u.name}
                          {u.erased ? (
                            <span className="people-badge">{t('admin.users.erased')}</span>
                          ) : (
                            !u.active && (
                              <span className="people-badge">{t('admin.users.deactivated')}</span>
                            )
                          )}
                        </p>
                        {/* The sign-in date stays whole: it moves to the next line as one piece,
                            wherever the address ends (S3-AC-10). */}
                        <p className="people-meta">
                          {u.email} ·{' '}
                          <span className="people-meta-whole">
                            {t('admin.users.lastSignIn', { date: when(u.lastSignInAt) })}
                          </span>
                        </p>
                        {/* Every administrator role, the tracks they run, or Member (T-331). */}
                        {!u.erased && (
                          <p className="people-roles">
                            {roleWords(t, u).map((word, i) => (
                              <span key={word} className="people-badge people-role">
                                {i > 0 && (
                                  <span className="visually-hidden">
                                    {t('admin.users.roleSeparator')}
                                  </span>
                                )}
                                {word}
                              </span>
                            ))}
                          </p>
                        )}
                      </div>
                      {!u.erased && (
                        <div className="people-actions">
                          {/* One way to everything about the person: their page (T-331). The
                              name starts with the visible word (WCAG 2.5.3). */}
                          <a
                            href={routeHref(personHref(u.id))}
                            className="button-secondary people-action people-edit"
                            aria-label={t('admin.users.editOf', { name: u.name })}
                          >
                            {t('admin.users.edit')}
                          </a>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {!state.end && state.read < state.total && (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      // Not disabled: the focus stays on it while the page loads.
                      aria-disabled={state.more || undefined}
                      onClick={() => void more()}
                    >
                      {t('admin.users.more')}
                    </button>
                  </div>
                )}
              </>
            ))}
        </>
      )}
    </section>
  );
}

/** The people shown, the search they answer, and how far the server's list has been read. */
interface Listed {
  query: string;
  /** Which people the list holds: active, deactivated or everyone. */
  show: UserStatus;
  /** Which role they hold, or `any` (T-331). */
  role: RoleFilter;
  users: User[];
  total: number;
  /** Rows read from the server so far: where the next page starts. */
  read: number;
  /** The id of the last row read, which the next page reads again (`pageAfter`). */
  lastId: number | null;
  /** A page brought nobody new before `total` was reached (people left the list meanwhile). */
  end: boolean;
  /** Show more is reading the next page. */
  more: boolean;
}

/** Reads of a list that keeps moving before its pages are taken as they come. */
const MOST_MOVES = 3;

/** The list with a page's new rows after it; someone already shown is not shown twice. */
function withPage<L extends Listed>(listed: L, rows: User[], total: number): L {
  const known = new Set(listed.users.map((u) => u.id));
  return {
    ...listed,
    users: [...listed.users, ...rows.filter((u) => !known.has(u.id))],
    total,
    read: listed.read + rows.length,
    lastId: rows.at(-1)?.id ?? listed.lastId,
    end: rows.length === 0,
  };
}

function AddUser({
  client,
  onAdded,
  onCancel,
  onProblem,
}: {
  client: PeopleClient;
  onAdded: (user: User, activationLink: string | null) => void;
  onCancel: () => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="glass-card people-card people-form"
      aria-label={t('admin.users.add')}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        client
          .createUser({ name: name.trim(), email: email.trim(), isSiteAdmin: admin })
          .then((made) => onAdded(made.user, made.activationLink), onProblem)
          .finally(() => setBusy(false));
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.users.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-email`} className="form-label">
          {t('admin.users.email')}
        </label>
        <input
          id={`${id}-email`}
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <label className="form-check">
        <input
          type="checkbox"
          checked={admin}
          onChange={(event) => setAdmin(event.target.checked)}
        />
        {t('admin.users.makeSiteAdmin')}
      </label>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('admin.users.create')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.users.cancel')}
        </button>
      </div>
    </form>
  );
}
