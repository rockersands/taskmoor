import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { type PeopleClient, peopleClient, type User, type UserStatus } from './client';

export interface UsersPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PeopleClient;
}

/**
 * People (IAM-008), for site administrators: find someone by name or email, add a person (who
 * gets a one-time link to set a password), make or unmake a site administrator, deactivate and
 * reactivate, and make a new password link. Deactivating keeps everything the person did
 * attributed to them; the last site administrator stays.
 */
export function UsersPage({ client = peopleClient }: UsersPageProps) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const searchId = useId();
  const statusId = useId();
  const me = session.status === 'signed-in' ? session.user.id : 0;
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<UserStatus>('active');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; users: User[]; total: number }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const found = await client.users(query.trim(), status);
      setState({ status: 'loaded', ...found });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, query, status, expired]);

  useEffect(() => {
    if (notAdmin) return;
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, notAdmin, query]);

  const refusal = (error: unknown) => {
    const code =
      error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
    if (code === 'email_taken') return t('admin.users.problem.emailTaken');
    if (code === 'last_admin') return t('admin.users.problem.lastAdmin');
    if (code === 'cannot_deactivate_self') return t('admin.users.problem.self');
    if (code === 'directory_managed' || code === 'read_only') {
      return t('admin.users.problem.directory');
    }
    if (code === 'invalid_request') return t('admin.users.problem.invalid');
    return t('admin.users.problem.other');
  };
  const act = async (work: () => Promise<unknown>, said: string) => {
    setProblem(null);
    try {
      await work();
      setMessage(said);
      await load();
    } catch (error) {
      if (!expired(error)) setProblem(refusal(error));
    }
  };
  const when = (iso: string | null) =>
    iso ? intl.formatDate(new Date(iso), { dateStyle: 'medium' }) : t('admin.users.never');

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <h1 id={titleId} className="page-title">
        {t('admin.users.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.users.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.users.intro')}</p>
          <AddUser
            client={client}
            onAdded={(user, activation) => {
              setMessage(t('admin.users.added', { name: user.name }));
              setProblem(null);
              setLink(activation ? { name: user.name, url: activation } : null);
              void load();
            }}
            onProblem={(error) => setProblem(refusal(error))}
          />
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
          <div className="people-filters">
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
          </div>
          {state.status === 'loading' && <p className="page-note">{t('admin.users.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.users.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            (state.users.length === 0 ? (
              <p className="page-note">{t('admin.users.none')}</p>
            ) : (
              <>
                <p className="page-note">{t('admin.users.count', { count: state.total })}</p>
                <ul className="people-list">
                  {state.users.map((u) => (
                    <li key={u.id} className="people-item">
                      <div className="people-main">
                        <p className="people-name">
                          {u.name}
                          {u.isSiteAdmin && (
                            <span className="people-badge">{t('admin.users.siteAdmin')}</span>
                          )}
                          {!u.active && (
                            <span className="people-badge">{t('admin.users.deactivated')}</span>
                          )}
                        </p>
                        <p className="people-meta">
                          {u.email} · {t('admin.users.lastSignIn', { date: when(u.lastSignInAt) })}
                        </p>
                      </div>
                      <div className="people-actions">
                        {u.active && u.id !== me && (
                          <button
                            type="button"
                            className="button-secondary people-action"
                            aria-label={t(
                              u.isSiteAdmin
                                ? 'admin.users.unmakeAdminOf'
                                : 'admin.users.makeAdminOf',
                              { name: u.name },
                            )}
                            onClick={() =>
                              void act(
                                () => client.updateUser(u.id, { isSiteAdmin: !u.isSiteAdmin }),
                                t('admin.users.saved', { name: u.name }),
                              )
                            }
                          >
                            {t(u.isSiteAdmin ? 'admin.users.unmakeAdmin' : 'admin.users.makeAdmin')}
                          </button>
                        )}
                        {u.active && (
                          <button
                            type="button"
                            className="button-secondary people-action"
                            aria-label={t('admin.users.passwordLinkOf', { name: u.name })}
                            onClick={() =>
                              void (async () => {
                                setProblem(null);
                                try {
                                  setLink({ name: u.name, url: await client.passwordLink(u.id) });
                                } catch (error) {
                                  if (!expired(error)) setProblem(refusal(error));
                                }
                              })()
                            }
                          >
                            {t('admin.users.passwordLink')}
                          </button>
                        )}
                        {u.id !== me &&
                          (u.active ? (
                            <button
                              type="button"
                              className="button-secondary people-action"
                              aria-label={t('admin.users.deactivateOf', { name: u.name })}
                              onClick={() =>
                                void act(
                                  () => client.deactivate(u.id),
                                  t('admin.users.deactivatedSaid', { name: u.name }),
                                )
                              }
                            >
                              {t('admin.users.deactivate')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="button-secondary people-action"
                              aria-label={t('admin.users.reactivateOf', { name: u.name })}
                              onClick={() =>
                                void act(
                                  () => client.reactivate(u.id),
                                  t('admin.users.reactivatedSaid', { name: u.name }),
                                )
                              }
                            >
                              {t('admin.users.reactivate')}
                            </button>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </>
      )}
    </section>
  );
}

function AddUser({
  client,
  onAdded,
  onProblem,
}: {
  client: PeopleClient;
  onAdded: (user: User, activationLink: string | null) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div className="form-actions">
        <button type="button" className="button-primary" onClick={() => setOpen(true)}>
          {t('admin.users.add')}
        </button>
      </div>
    );
  }
  return (
    <form
      className="people-form"
      aria-label={t('admin.users.add')}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        client
          .createUser({ name: name.trim(), email: email.trim(), isSiteAdmin: admin })
          .then((made) => {
            onAdded(made.user, made.activationLink);
            setOpen(false);
            setName('');
            setEmail('');
            setAdmin(false);
          }, onProblem)
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
        <button type="button" className="button-secondary" onClick={() => setOpen(false)}>
          {t('admin.users.cancel')}
        </button>
      </div>
    </form>
  );
}
