import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { localeOptions, timeZoneOptions } from '../account/options';
import { PersonalDataSection } from '../account/PersonalDataSection';
import { useAdminTrail } from '../admin/AdminLayout';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import { type PeopleClient, type PersonDetail, peopleClient, type RoleSource } from './client';
import { EraseUserForm } from './EraseUserForm';
import { peopleRefusal, ROLE_LABEL } from './peopleWords';

/** Where roles are given (IAM-009): global permissions, groups, and each track's People page. */
const PERMISSIONS_HREF = '#/admin/permissions';
const GROUPS_HREF = '#/admin/groups';
const trackPeopleHref = (id: number) => `#/manage/tracks/${id}`;

export interface PersonPageProps {
  userId: number;
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PeopleClient;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; detail: PersonDetail }
  | { status: 'failed' }
  | { status: 'forbidden' }
  | { status: 'missing' };

/**
 * One person under Administration > People (#/admin/users/<id>; T-331, IAM-008), opened by the
 * Edit link on their row: every action for them, which the rows no longer hold (the user's
 * request of 2026-11-17). Their roles with where each comes from and links to where it changes
 * (IAM-009), the tracks they run (IAM-028); their name, email, time zone and language; a password
 * link, the break-glass mark and a reset of their second factor (IAM-001); their data (ASVS
 * 8.3.2); and deactivating, reactivating or erasing them (ADR-111). Destructive actions ask
 * first (ADR-114 D13). Nobody deactivates, erases or demotes themselves here.
 */
export function PersonPage({ userId, client = peopleClient }: PersonPageProps) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const me = session.status === 'signed-in' ? session.user.id : 0;
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', detail: await client.person(userId) });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else if (error instanceof ApiError && error.status === 404) setState({ status: 'missing' });
      else setState({ status: 'failed' });
    }
  }, [client, userId, expired]);

  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const detail = state.status === 'loaded' ? state.detail : null;
  // The breadcrumb ends at the person, under People (AD-28).
  useAdminTrail(
    detail
      ? [{ label: t('common.value', { value: detail.user.name }) }]
      : state.status === 'missing'
        ? [{ label: t('notFound.person') }]
        : null,
  );

  /** Runs a change, says what it did, and reads the person again; a refusal is said in words. */
  const act = async (work: () => Promise<unknown>, said: () => string): Promise<boolean> => {
    setProblem(null);
    setMessage('');
    setBusy(true);
    try {
      await work();
      setMessage(said());
      await load();
      return true;
    } catch (error) {
      if (!expired(error)) setProblem(peopleRefusal(t, error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'missing') return <NotFoundPage title={t('notFound.person')} />;

  if (!detail) {
    return (
      <section aria-labelledby={titleId} className="page admin-page people-page">
        <PageHeader titleId={titleId} title={t('admin.users.title')} />
        {state.status === 'forbidden' && <p className="page-note">{t('admin.users.forbidden')}</p>}
        {state.status === 'loading' && (
          <p role="status" className="page-note">
            {t('admin.person.loading')}
          </p>
        )}
        {state.status === 'failed' && (
          <p role="alert" className="form-error">
            {t('admin.person.failed')}
          </p>
        )}
      </section>
    );
  }

  const { user } = detail;
  const self = user.id === me;
  const managed = detail.directory;
  const when = (iso: string | null) =>
    iso ? intl.formatDate(new Date(iso), { dateStyle: 'medium' }) : t('admin.users.never');

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page person-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('common.value', { value: user.name })}
        purpose={t('admin.person.purpose')}
        about={t('admin.person.about')}
      />
      <p className="people-meta person-summary">
        {user.email} ·{' '}
        <span className="people-meta-whole">
          {t('admin.users.lastSignIn', { date: when(user.lastSignInAt) })}
        </span>
        {user.erased ? (
          <span className="people-badge">{t('admin.users.erased')}</span>
        ) : (
          !user.active && <span className="people-badge">{t('admin.users.deactivated')}</span>
        )}
      </p>
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {user.erased ? (
        <p className="page-note">{t('admin.person.erasedNote')}</p>
      ) : (
        <>
          <RolesSection
            detail={detail}
            self={self}
            busy={busy}
            onSiteAdmin={(next) =>
              void act(
                () => client.updateUser(user.id, { isSiteAdmin: next }),
                () => t('admin.users.saved', { name: user.name }),
              )
            }
          />
          <ProfileSection
            key={`${user.name}|${user.email}|${user.timeZone}|${user.locale}`}
            detail={detail}
            busy={busy}
            onSave={(change) =>
              act(
                () => client.updateUser(user.id, change),
                () => t('admin.users.saved', { name: change.name ?? user.name }),
              )
            }
          />

          <section aria-labelledby={`${id}-sign-in`} className="glass-card people-card">
            <h2 id={`${id}-sign-in`} className="facts-title">
              {t('admin.person.signIn')}
            </h2>
            {/* A one-time link to set a password, for a password the site checks. */}
            {managed ? (
              <p className="page-note">
                {t('admin.person.passwordDirectory', { directory: managed.name })}
              </p>
            ) : (
              user.active && (
                <div className="person-action">
                  <p className="page-note">{t('admin.person.passwordLinkHint')}</p>
                  <button
                    type="button"
                    className="button-secondary people-action"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setProblem(null);
                        try {
                          setLink(await client.passwordLink(user.id));
                        } catch (error) {
                          if (!expired(error)) setProblem(peopleRefusal(t, error));
                        }
                      })()
                    }
                  >
                    {t('admin.users.passwordLink')}
                  </button>
                  {link && (
                    <div className="people-link">
                      <p className="page-note">{t('admin.users.linkHint', { name: user.name })}</p>
                      <input
                        type="text"
                        readOnly
                        value={link}
                        aria-label={t('admin.users.linkFor', { name: user.name })}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setLink(null)}
                      >
                        {t('admin.users.linkDone')}
                      </button>
                    </div>
                  )}
                </div>
              )
            )}
            {/* Break-glass (IAM-001): a password still works while single sign-on is enforced. */}
            <div className="person-action">
              <h3 className="person-subtitle">{t('admin.person.breakGlass')}</h3>
              <p className="page-note">{t('admin.person.breakGlassHint')}</p>
              <p className="page-note">
                {t(user.breakGlass ? 'admin.person.isBreakGlass' : 'admin.person.notBreakGlass')}
              </p>
              {managed ? (
                <p className="page-note">{t('admin.person.breakGlassDirectory')}</p>
              ) : (
                <button
                  type="button"
                  className="button-secondary people-action"
                  disabled={busy}
                  onClick={() => {
                    const next = !user.breakGlass;
                    void act(
                      () => client.updateUser(user.id, { breakGlass: next }),
                      () =>
                        t(next ? 'admin.person.breakGlassOn' : 'admin.person.breakGlassOff', {
                          name: user.name,
                        }),
                    );
                  }}
                >
                  {t(
                    user.breakGlass
                      ? 'admin.person.unmarkBreakGlass'
                      : 'admin.person.markBreakGlass',
                  )}
                </button>
              )}
            </div>
            {/* Their second factor (IAM-001): reset, they set one up again. */}
            <div className="person-action">
              <h3 className="person-subtitle">{t('admin.person.twoFactor')}</h3>
              {!detail.hasSecondFactor ? (
                <p className="page-note">{t('admin.person.noTwoFactor')}</p>
              ) : self ? (
                <p className="page-note">{t('admin.person.ownTwoFactor')}</p>
              ) : (
                <>
                  <p className="page-note">{t('admin.person.hasTwoFactor')}</p>
                  <DangerAction
                    label={t('admin.person.resetTwoFactor')}
                    outcome={t('admin.person.resetTwoFactorConfirm', { name: user.name })}
                    confirmLabel={t('admin.person.resetTwoFactorOf', { name: user.name })}
                    onConfirm={async () => {
                      setProblem(null);
                      try {
                        await client.resetTwoFactor(user.id);
                      } catch (error) {
                        if (!expired(error)) setProblem(peopleRefusal(t, error));
                        throw error;
                      }
                      setMessage(t('admin.person.twoFactorReset', { name: user.name }));
                      title.current?.focus();
                      await load();
                    }}
                  />
                </>
              )}
            </div>
          </section>

          <PersonalDataSection
            client={client.personalData(user)}
            timeZone={session.status === 'signed-in' ? session.user.timeZone : null}
          />

          <section aria-labelledby={`${id}-account`} className="glass-card people-card">
            <h2 id={`${id}-account`} className="facts-title">
              {t('admin.person.account')}
            </h2>
            {self ? (
              <p className="page-note">{t('admin.person.self')}</p>
            ) : (
              <>
                <p className="page-note">
                  {t(user.active ? 'admin.person.activeNote' : 'admin.person.deactivatedNote')}
                </p>
                <div className="people-actions">
                  {user.active ? (
                    // Asks first, saying what will happen (D13).
                    <DangerAction
                      label={t('admin.users.deactivate')}
                      outcome={t('admin.users.deactivateConfirm', { name: user.name })}
                      confirmLabel={t('admin.users.deactivateOf', { name: user.name })}
                      onConfirm={async () => {
                        setProblem(null);
                        try {
                          await client.deactivate(user.id);
                        } catch (error) {
                          // Refused: the question stays, and the reason shows above.
                          if (!expired(error)) setProblem(peopleRefusal(t, error));
                          throw error;
                        }
                        setMessage(t('admin.users.deactivatedSaid', { name: user.name }));
                        // The button went with the deactivation: the heading keeps the focus.
                        title.current?.focus();
                        await load();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="button-secondary people-action"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => client.reactivate(user.id),
                          () => t('admin.users.reactivatedSaid', { name: user.name }),
                        )
                      }
                    >
                      {t('admin.users.reactivate')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button-danger-quiet people-action"
                    aria-expanded={erasing}
                    aria-controls={`${id}-erase`}
                    onClick={() => {
                      setProblem(null);
                      setErasing(!erasing);
                    }}
                  >
                    {t('admin.users.erase')}
                  </button>
                </div>
                <div id={`${id}-erase`}>
                  {erasing && (
                    <EraseUserForm
                      user={user}
                      onCancel={() => setErasing(false)}
                      onErase={async (confirmEmail) => {
                        setProblem(null);
                        try {
                          const { label } = await client.erase(user.id, confirmEmail);
                          setErasing(false);
                          setMessage(t('admin.users.erasedSaid', { label }));
                          title.current?.focus();
                          await load();
                        } catch (error) {
                          if (!expired(error)) setProblem(peopleRefusal(t, error));
                        }
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}

/**
 * The person's administrator roles, each with where it comes from as a link to where it changes,
 * the tracks they run, or "Member" (T-331; IAM-009, IAM-028); and the site administrator mark of
 * their account, which this page changes.
 */
function RolesSection({
  detail,
  self,
  busy,
  onSiteAdmin,
}: {
  detail: PersonDetail;
  self: boolean;
  busy: boolean;
  onSiteAdmin: (next: boolean) => void;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const { user, roles, tracks } = detail;
  const runs = user.tracksRun ?? tracks.length;
  const source = (s: RoleSource, key: number) => {
    const words =
      s.kind === 'account' ? (
        t('admin.person.source.account')
      ) : s.kind === 'group' ? (
        <a href={routeHref(GROUPS_HREF)}>
          {t('admin.person.source.group', { group: s.group.name })}
        </a>
      ) : (
        <a href={routeHref(PERMISSIONS_HREF)}>
          {t(s.kind === 'user' ? 'admin.person.source.user' : 'admin.person.source.everyone')}
        </a>
      );
    return <li key={key}>{words}</li>;
  };
  return (
    <section aria-labelledby={`${id}-roles`} className="glass-card people-card">
      <h2 id={`${id}-roles`} className="facts-title">
        {t('admin.person.roles')}
      </h2>
      {roles.length === 0 && runs === 0 ? (
        <p className="page-note">{t('admin.person.member')}</p>
      ) : (
        <ul className="people-sublist person-roles">
          {roles.map((held) => (
            <li key={held.role} className="person-role">
              <span className="people-badge">{t(ROLE_LABEL[held.role])}</span>
              <ul className="person-sources">{held.sources.map(source)}</ul>
            </li>
          ))}
          {runs > 0 && (
            <li className="person-role">
              <span className="people-badge">{t('admin.users.runsTracks', { count: runs })}</span>
              <ul className="person-sources">
                {tracks.map((track) => (
                  <li key={track.id}>
                    <a href={routeHref(trackPeopleHref(track.id))}>
                      {t('admin.person.track', { key: track.key, name: track.name })}
                    </a>
                  </li>
                ))}
                {runs > tracks.length && (
                  <li>{t('admin.person.moreTracks', { count: runs - tracks.length })}</li>
                )}
              </ul>
            </li>
          )}
        </ul>
      )}
      <p className="page-note">
        {detail.groups.length > 0
          ? t('admin.person.inGroups', {
              groups: intl.formatList(
                detail.groups.map((g) => g.name),
                { type: 'conjunction' },
              ),
            })
          : t('admin.person.noGroups')}
      </p>
      <p className="page-note person-where">
        {t('admin.person.whereRoles')}{' '}
        <a href={routeHref(PERMISSIONS_HREF)}>{t('admin.person.toPermissions')}</a>
        {' · '}
        <a href={routeHref(GROUPS_HREF)}>{t('admin.person.toGroups')}</a>
      </p>
      {user.active && !self && (
        <div className="people-actions">
          <button
            type="button"
            className="button-secondary people-action"
            disabled={busy}
            onClick={() => onSiteAdmin(!user.isSiteAdmin)}
          >
            {t(user.isSiteAdmin ? 'admin.users.unmakeAdmin' : 'admin.users.makeAdmin')}
          </button>
        </div>
      )}
    </section>
  );
}

/** Name, email, time zone and language (IAM-008); a directory may keep the first two (M1-082). */
function ProfileSection({
  detail,
  busy,
  onSave,
}: {
  detail: PersonDetail;
  busy: boolean;
  onSave: (change: {
    name?: string;
    email?: string;
    timeZone?: string | null;
    locale?: string | null;
  }) => Promise<boolean>;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const { user, directory } = detail;
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [timeZone, setTimeZone] = useState(user.timeZone ?? '');
  const [locale, setLocale] = useState(user.locale ?? '');
  // Data, not UI text: it goes through the catalogue only so the pseudo-locale can bracket it.
  const zones = useMemo(
    () =>
      timeZoneOptions(user.timeZone ?? null).map((zone) => ({
        value: zone,
        label: intl.formatMessage({ id: 'common.value' }, { value: zone.replaceAll('_', ' ') }),
      })),
    [intl, user.timeZone],
  );
  const locales = useMemo(
    () =>
      localeOptions(intl.locale, user.locale ?? null).map((option) => ({
        value: option.value,
        label: intl.formatMessage({ id: 'common.value' }, { value: option.label }),
      })),
    [intl, user.locale],
  );
  const field = (key: string) => `${id}-${key}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Only what changed goes: a directory refuses a change to the name or address it keeps.
    const change = {
      ...(name.trim() !== user.name ? { name: name.trim() } : {}),
      ...(email.trim().toLowerCase() !== user.email.toLowerCase() ? { email: email.trim() } : {}),
      ...(timeZone !== (user.timeZone ?? '') ? { timeZone: timeZone || null } : {}),
      ...(locale !== (user.locale ?? '') ? { locale: locale || null } : {}),
    };
    if (Object.keys(change).length > 0) void onSave(change);
  };
  return (
    <section aria-labelledby={field('title')} className="glass-card people-card">
      <h2 id={field('title')} className="facts-title">
        {t('admin.person.profile')}
      </h2>
      {directory && (
        <p className="page-note">
          {t(
            directory.mode === 'read_write'
              ? 'admin.person.directoryWrites'
              : 'admin.person.directoryKeeps',
            { directory: directory.name },
          )}
        </p>
      )}
      <form className="people-form" aria-labelledby={field('title')} onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={field('name')} className="form-label">
            {t('admin.users.name')}
          </label>
          <input
            id={field('name')}
            type="text"
            required
            maxLength={200}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={field('email')} className="form-label">
            {t('admin.users.email')}
          </label>
          <input
            id={field('email')}
            type="email"
            required
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={field('time-zone')} className="form-label">
            {t('account.timeZone')}
          </label>
          <select
            id={field('time-zone')}
            value={timeZone}
            aria-describedby={field('time-zone-hint')}
            onChange={(event) => setTimeZone(event.target.value)}
          >
            <option value="">{t('account.timeZoneAutomatic')}</option>
            {zones.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
          <p id={field('time-zone-hint')} className="form-hint">
            {t('admin.person.timeZoneHint')}
          </p>
        </div>
        <div className="form-field">
          <label htmlFor={field('locale')} className="form-label">
            {t('account.locale')}
          </label>
          <select
            id={field('locale')}
            value={locale}
            aria-describedby={field('locale-hint')}
            onChange={(event) => setLocale(event.target.value)}
          >
            <option value="">{t('account.localeAutomatic')}</option>
            {locales.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={field('locale-hint')} className="form-hint">
            {t('admin.person.localeHint')}
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('admin.person.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
