import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { PersonalDataSection } from '../account/PersonalDataSection';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type PeopleClient, peopleClient, type User, type UserStatus } from './client';
import { EraseUserForm } from './EraseUserForm';

export interface UsersPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PeopleClient;
}

/**
 * People (IAM-008), for site administrators: find someone by name or email, add a person (who
 * gets a one-time link to set a password), make or unmake a site administrator, deactivate and
 * reactivate, and make a new password link. Deactivating keeps everything the person did
 * attributed to them; the last site administrator stays. For a person's data (ASVS 8.3.2,
 * ADR-111): download it, or erase the person, confirmed by typing their email.
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
  /** The person whose data panel or erase form is open. */
  const [open, setOpen] = useState<{ user: User; panel: 'data' | 'erase' } | null>(null);
  // A deactivation takes the person's Deactivate away: the page's heading keeps the focus.
  const title = useRef<HTMLHeadingElement>(null);

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
    if (code === 'confirmation_mismatch') return t('admin.users.problem.mismatch');
    if (code === 'cannot_erase_self') return t('admin.users.problem.eraseSelf');
    if (code === 'managed_by_directory' || code === 'managed_by_scim') {
      return t('admin.users.problem.managed');
    }
    if (code === 'already_erased' || code === 'erased') return t('admin.users.problem.erased');
    // Their shared track groups gave the only other person who runs a track its role (ADR-121).
    if (code === 'last_track_admin') return t('admin.users.problem.lastTrackAdmin');
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
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.users.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.usersHint'), about: t('admin.users.intro') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.users.forbidden')}</p>
      ) : (
        <>
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
                    <li key={u.id} className="people-item">
                      <div className="people-main">
                        <p className="people-name">
                          {u.name}
                          {u.isSiteAdmin && (
                            <span className="people-badge">{t('admin.users.siteAdmin')}</span>
                          )}
                          {u.erased ? (
                            <span className="people-badge">{t('admin.users.erased')}</span>
                          ) : (
                            !u.active && (
                              <span className="people-badge">{t('admin.users.deactivated')}</span>
                            )
                          )}
                        </p>
                        <p className="people-meta">
                          {u.email} · {t('admin.users.lastSignIn', { date: when(u.lastSignInAt) })}
                        </p>
                      </div>
                      {!u.erased && (
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
                              {t(
                                u.isSiteAdmin ? 'admin.users.unmakeAdmin' : 'admin.users.makeAdmin',
                              )}
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
                              // Asks first, saying what will happen (D13).
                              <DangerAction
                                label={t('admin.users.deactivate')}
                                name={t('admin.users.deactivateOf', { name: u.name })}
                                outcome={t('admin.users.deactivateConfirm', { name: u.name })}
                                confirmLabel={t('admin.users.deactivateOf', { name: u.name })}
                                onConfirm={async () => {
                                  setProblem(null);
                                  try {
                                    await client.deactivate(u.id);
                                  } catch (error) {
                                    // Refused: the question stays, and the reason shows above.
                                    if (!expired(error)) setProblem(refusal(error));
                                    throw error;
                                  }
                                  setMessage(t('admin.users.deactivatedSaid', { name: u.name }));
                                  title.current?.focus();
                                  await load();
                                }}
                              />
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
                          <button
                            type="button"
                            className="button-secondary people-action"
                            aria-label={t('admin.users.dataOf', { name: u.name })}
                            aria-expanded={open?.user.id === u.id && open.panel === 'data'}
                            onClick={() =>
                              setOpen(
                                open?.user.id === u.id && open.panel === 'data'
                                  ? null
                                  : { user: u, panel: 'data' },
                              )
                            }
                          >
                            {t('admin.users.data')}
                          </button>
                          {u.id !== me && (
                            <button
                              type="button"
                              className="button-danger-quiet people-action"
                              aria-label={t('admin.users.eraseOf', { name: u.name })}
                              onClick={() => {
                                setProblem(null);
                                setOpen({ user: u, panel: 'erase' });
                              }}
                            >
                              {t('admin.users.erase')}
                            </button>
                          )}
                        </div>
                      )}
                      {open?.user.id === u.id && open.panel === 'data' && (
                        <div className="people-panel">
                          <PersonalDataSection
                            client={client.personalData(u)}
                            timeZone={session.status === 'signed-in' ? session.user.timeZone : null}
                          />
                          <div className="form-actions">
                            <button
                              type="button"
                              className="button-secondary"
                              onClick={() => setOpen(null)}
                            >
                              {t('admin.users.dataClose')}
                            </button>
                          </div>
                        </div>
                      )}
                      {open?.user.id === u.id && open.panel === 'erase' && (
                        <div className="people-panel">
                          <EraseUserForm
                            user={u}
                            onCancel={() => setOpen(null)}
                            onErase={async (confirmEmail) => {
                              setProblem(null);
                              try {
                                const { label } = await client.erase(u.id, confirmEmail);
                                setOpen(null);
                                setMessage(t('admin.users.erasedSaid', { label }));
                                await load();
                              } catch (error) {
                                if (!expired(error)) setProblem(refusal(error));
                              }
                            }}
                          />
                        </div>
                      )}
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
      <div className="form-actions" data-tutorial="admin-user-new">
        <button type="button" className="button-primary" onClick={() => setOpen(true)}>
          {t('admin.users.add')}
        </button>
      </div>
    );
  }
  return (
    <form
      className="glass-card people-card people-form"
      data-tutorial="admin-user-new"
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
