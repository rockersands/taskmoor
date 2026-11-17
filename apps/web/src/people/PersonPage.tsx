import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
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

/**
 * Where on the page a refusal is said: next to the action that was refused, not at the page's
 * top, which a long page leaves screens away.
 */
type Place = 'roles' | 'profile' | 'password' | 'breakGlass' | 'twoFactor' | 'account';

/** A refusal, said beside its action and brought into view (ImportsPage does the same). */
function Refusal({ children }: { children: ReactNode }) {
  const seen = useCallback((p: HTMLParagraphElement | null) => {
    p?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <p role="alert" className="form-error" ref={seen}>
      {children}
    </p>
  );
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
  const [problem, setProblem] = useState<{ at: Place; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const passwordButton = useRef<HTMLButtonElement>(null);
  const eraseButton = useRef<HTMLButtonElement>(null);
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

  /** Says why an action at `at` was refused, beside it. */
  const refuse = (at: Place, error: unknown) => {
    if (!expired(error)) setProblem({ at, text: peopleRefusal(t, error) });
  };
  const refusalAt = (at: Place) => (problem?.at === at ? <Refusal>{problem.text}</Refusal> : null);

  /**
   * Runs a change, says what it did, and reads the person again; a refusal is said in words
   * beside the action at `at`. One change at a time: the buttons stay focusable while it runs
   * (`aria-disabled`), so the focus never falls to the page.
   */
  const act = async (
    at: Place,
    work: () => Promise<unknown>,
    said: () => string,
  ): Promise<boolean> => {
    if (busy) return false;
    setProblem(null);
    setMessage('');
    setBusy(true);
    try {
      await work();
      setMessage(said());
      await load();
      return true;
    } catch (error) {
      refuse(at, error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'missing') return <NotFoundPage title={t('notFound.person')} />;

  if (!detail) {
    return (
      <section aria-labelledby={titleId} className="page admin-page people-page">
        <PageHeader
          titleId={titleId}
          title={t('admin.users.title')}
          {...(state.status === 'forbidden' ? {} : { purpose: t('admin.person.purpose') })}
        />
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
      {user.erased ? (
        <p className="page-note">{t('admin.person.erasedNote')}</p>
      ) : (
        <>
          <RolesSection
            detail={detail}
            self={self}
            busy={busy}
            refusal={refusalAt('roles')}
            onSiteAdmin={(next) =>
              void act(
                'roles',
                () => client.updateUser(user.id, { isSiteAdmin: next }),
                () => t('admin.users.saved', { name: user.name }),
              )
            }
          />
          {/* Not remounted after a save: Save keeps the focus. */}
          <ProfileSection
            detail={detail}
            busy={busy}
            refusal={refusalAt('profile')}
            onSave={(change) =>
              act(
                'profile',
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
                    ref={passwordButton}
                    type="button"
                    className="button-secondary people-action"
                    aria-disabled={busy || undefined}
                    onClick={() =>
                      void (async () => {
                        if (busy) return;
                        setProblem(null);
                        try {
                          setLink(await client.passwordLink(user.id));
                        } catch (error) {
                          refuse('password', error);
                        }
                      })()
                    }
                  >
                    {t('admin.users.passwordLink')}
                  </button>
                  {refusalAt('password')}
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
                        onClick={() => {
                          setLink(null);
                          // Done goes with the link: the focus goes back to where it came from.
                          passwordButton.current?.focus();
                        }}
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
              {/* A directory's account cannot be marked; one marked before the directory took it
                  can still lose the mark, which the server allows (IAM-001). */}
              {managed && (
                <p className="page-note">
                  {t(
                    user.breakGlass
                      ? 'admin.person.breakGlassDirectoryMarked'
                      : 'admin.person.breakGlassDirectory',
                  )}
                </p>
              )}
              {(!managed || user.breakGlass) && (
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    const next = !user.breakGlass;
                    void act(
                      'breakGlass',
                      () => client.updateUser(user.id, { breakGlass: next }),
                      () =>
                        t(next ? 'admin.person.breakGlassOn' : 'admin.person.breakGlassOff', {
                          name: user.name,
                        }),
                    ).then((done) => {
                      // A directory's account has no button once unmarked: the heading has the focus.
                      if (done && managed) title.current?.focus();
                    });
                  }}
                >
                  {t(
                    user.breakGlass
                      ? 'admin.person.unmarkBreakGlass'
                      : 'admin.person.markBreakGlass',
                  )}
                </button>
              )}
              {refusalAt('breakGlass')}
            </div>
            {/* Their second factor (IAM-001): reset, they set one up again. */}
            <div className="person-action">
              <h3 className="person-subtitle">{t('admin.person.twoFactor')}</h3>
              {!detail.hasSecondFactor ? (
                <p className="page-note">{t('admin.person.withoutTwoFactor')}</p>
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
                        refuse('twoFactor', error);
                        throw error;
                      }
                      setMessage(t('admin.person.twoFactorReset', { name: user.name }));
                      title.current?.focus();
                      await load();
                    }}
                  />
                  {refusalAt('twoFactor')}
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
                          // Refused: the question stays, and the reason shows below it.
                          refuse('account', error);
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
                      aria-disabled={busy || undefined}
                      onClick={() =>
                        void act(
                          'account',
                          () => client.reactivate(user.id),
                          () => t('admin.users.reactivatedSaid', { name: user.name }),
                        ).then((done) => {
                          // Deactivate takes the button's place: the heading keeps the focus.
                          if (done) title.current?.focus();
                        })
                      }
                    >
                      {t('admin.users.reactivate')}
                    </button>
                  )}
                  <button
                    ref={eraseButton}
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
                      onCancel={() => {
                        setErasing(false);
                        eraseButton.current?.focus();
                      }}
                      onErase={async (confirmEmail) => {
                        setProblem(null);
                        try {
                          const { label } = await client.erase(user.id, confirmEmail);
                          setErasing(false);
                          setMessage(t('admin.users.erasedSaid', { label }));
                          title.current?.focus();
                          await load();
                        } catch (error) {
                          refuse('account', error);
                        }
                      }}
                    />
                  )}
                </div>
                {refusalAt('account')}
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
  refusal,
  onSiteAdmin,
}: {
  detail: PersonDetail;
  self: boolean;
  busy: boolean;
  /** Why the last change here was refused, said beside its button. */
  refusal: ReactNode;
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
          : t('admin.person.groupless')}
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
            aria-disabled={busy || undefined}
            onClick={() => onSiteAdmin(!user.isSiteAdmin)}
          >
            {t(user.isSiteAdmin ? 'admin.users.unmakeAdmin' : 'admin.users.makeAdmin')}
          </button>
        </div>
      )}
      {refusal}
    </section>
  );
}

/** Name, email, time zone and language (IAM-008); a directory may keep the first two (M1-082). */
function ProfileSection({
  detail,
  busy,
  refusal,
  onSave,
}: {
  detail: PersonDetail;
  busy: boolean;
  /** Why the last save was refused, said beside Save. */
  refusal: ReactNode;
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
  // After a save the person is read again: the fields take what was saved, and the form stays
  // mounted, so Save keeps the focus.
  const saved = `${user.name}|${user.email}|${user.timeZone}|${user.locale}`;
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setName(user.name);
    setEmail(user.email);
    setTimeZone(user.timeZone ?? '');
    setLocale(user.locale ?? '');
  }
  // A read-only directory keeps the name and address: shown, not edited (M1-082).
  const kept = directory !== null && directory.mode !== 'read_write';
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
    if (busy) return;
    // Only what changed goes: a directory refuses a change to the name or address it keeps.
    const change = {
      ...(!kept && name.trim() !== user.name ? { name: name.trim() } : {}),
      ...(!kept && email.trim().toLowerCase() !== user.email.toLowerCase()
        ? { email: email.trim() }
        : {}),
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
        <p className="page-note" id={field('directory')}>
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
            readOnly={kept}
            aria-describedby={kept ? field('directory') : undefined}
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
            readOnly={kept}
            aria-describedby={kept ? field('directory') : undefined}
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
          <button type="submit" className="button-primary" aria-disabled={busy || undefined}>
            {t('admin.person.save')}
          </button>
        </div>
        {refusal}
      </form>
    </section>
  );
}
