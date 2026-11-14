import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAdminTrail } from '../admin/AdminLayout';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { ownLayoutsHref, ownSetsHref } from '../sets/trackScope';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { ChecklistNoticesBox } from './ChecklistNoticesBox';
import { CreateTracksBox } from './CreateTracksBox';
import {
  type Delivery,
  type Invitation,
  type InvitationsView,
  type ManagedTrack,
  type Named,
  type RoleHolders,
  type TrackPeopleClient,
  type TrackRole,
  trackPeopleClient,
} from './client';
import { InviteDialog } from './InviteDialog';

export interface TrackPeoplePageProps {
  trackId: number;
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TrackPeopleClient;
}

/**
 * The row an action was pressed on (T-248): its list, its key in that list, and where it stood,
 * so its answer shows beside it, or in its place when the action took the row away.
 */
type Row = { list: 'holders' | 'found' | 'invitations' | 'notices'; key: string; index: number };
type Answer = Row & { text: string; refused: boolean };
/** The checklist notices box, a row of one. */
const NOTICES: Row = { list: 'notices', key: 'box', index: 0 };

type State =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'failed' }
  | {
      status: 'loaded';
      track: ManagedTrack;
      roles: TrackRole[];
      holders: RoleHolders[];
      view: InvitationsView;
    };

/**
 * A track's Manage page (IAM-030), for whoever runs that track, site administrator or not: who
 * holds which role, giving and taking roles, inviting people (IAM-027), and whether the track's
 * followers hear of checklist changes (NTF-015). A local-mode track's page also leads to its own
 * layout sets and configuration sets (T-163a).
 */
export function TrackPeoplePage({ trackId, client = trackPeopleClient }: TrackPeoplePageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [said, setSaid] = useState('');
  const saying = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * Tells screen readers what went through, from a status line that is always there. It empties
   * first and takes the words a moment later, so the same words twice are announced twice.
   */
  const say = useCallback((words: string) => {
    clearTimeout(saying.current);
    setSaid('');
    saying.current = setTimeout(() => setSaid(words), 60);
  }, []);
  useEffect(() => () => clearTimeout(saying.current), []);
  const [inviting, setInviting] = useState(false);
  // The breadcrumb ends at the track, not at the list of tracks (AD-15).
  useAdminTrail(
    state.status === 'loaded' ? [{ label: t('common.value', { value: state.track.key }) }] : null,
  );
  const [freshLink, setFreshLink] = useState<{ id: number; email: string; url: string } | null>(
    null,
  );
  const [role, setRole] = useState('');
  const [createTracks, setCreateTracks] = useState(true);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Named[]>([]);
  const inviteButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const [track, roles, holders, view] = await Promise.all([
        client.track(trackId),
        client.roles(trackId),
        client.roleHolders(trackId),
        client.invitations(trackId),
      ]);
      setState({ status: 'loaded', track, roles, holders, view });
      setRole((current) => current || String(roles.find((r) => r.givable)?.id ?? ''));
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setState({ status: 'forbidden' });
      } else setState({ status: 'failed' });
    }
  }, [client, trackId, expired]);
  useEffect(() => {
    void load();
  }, [load]);

  const trackKey = state.status === 'loaded' ? state.track.key : '';
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2 || !trackKey) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.findPeople(trackKey, q).then(
        (people) => live && setFound(people),
        () => live && setFound([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search, trackKey]);

  const refusal = (error: unknown) => {
    if (!(error instanceof ApiError)) return t('trackPeople.problem.other');
    const body = error.body as { error?: string; permission?: string } | null;
    if (body?.error === 'last_track_admin') return t('trackPeople.problem.lastAdmin');
    if (body?.permission === 'appoint_track_admins') return t('trackPeople.problem.appoint');
    if (body?.permission === 'create_local_tracks') return t('trackPeople.problem.createTracks');
    if (body?.error === 'too_many_invitations') return t('trackPeople.problem.tooMany');
    if (body?.error === 'email_not_set_up') return t('trackPeople.emailOff');
    if (body?.error === 'email_invitations_only') return t('trackPeople.linksByEmail');
    if (body?.error === 'track_archived') return t('trackPeople.problem.archived');
    if (error.status === 403) return t('trackPeople.problem.forbidden');
    return t('trackPeople.problem.other');
  };
  const went = (row: Row, text: string) => {
    setAnswer({ ...row, text, refused: false });
    say(text);
  };
  const refused = (row: Row, error: unknown) =>
    setAnswer({ ...row, text: refusal(error), refused: true });
  const run = async (row: Row, work: () => Promise<unknown>, text: string) => {
    setAnswer(null);
    try {
      await work();
    } catch (error) {
      refused(row, error);
      return;
    }
    // Said once the page shows the change, so the answer lands where it stays: in the row, or
    // in its place when the change took the row away.
    await load();
    went(row, text);
  };
  /**
   * What the last action did, beside the row it was pressed on, where the person is looking on
   * however long a list (T-248): what went through, also told to screen readers by the page's
   * status line, or a refusal as an alert.
   */
  const shown = (a: Answer) =>
    a.refused ? (
      <p role="alert" className="form-error people-answer">
        {a.text}
      </p>
    ) : (
      <p className="form-status people-answer">{a.text}</p>
    );
  const answerBeside = (list: Row['list'], key: string) =>
    answer?.list === list && answer.key === key ? shown(answer) : null;
  /** A list's rows, with the answer in the place of a row the action took away. */
  const withAnswer = (list: Row['list'], rows: { key: string; node: ReactElement }[]) => {
    const nodes = rows.map((r) => r.node);
    if (answer?.list === list && !rows.some((r) => r.key === answer.key)) {
      nodes.splice(
        Math.min(answer.index, nodes.length),
        0,
        <li key="answer" className="people-answer-row">
          {shown(answer)}
        </li>,
      );
    }
    return nodes;
  };
  const answerIn = (list: Row['list']) => answer?.list === list;

  // Titled like the track's other own pages, its Layout sets and Configuration sets: the track
  // above the title (S3-TR-9).
  const titled = (
    <PageHeader
      titleId={titleId}
      title={t('trackPeople.titleLoading')}
      {...(state.status === 'loaded'
        ? {
            eyebrow: t('ownSets.trackName', { key: state.track.key, name: state.track.name }),
            purpose: t('purpose.trackPeople'),
            about: t('trackPeople.about'),
          }
        : {})}
    />
  );
  if (state.status !== 'loaded') {
    return (
      <section aria-labelledby={titleId} className="page admin-page people-page">
        {titled}
        {state.status === 'loading' && (
          <p role="status" className="page-note">
            {t('trackPeople.loading')}
          </p>
        )}
        {state.status === 'forbidden' && <p className="page-note">{t('trackPeople.forbidden')}</p>}
        {state.status === 'failed' && (
          <p role="alert" className="form-error">
            {t('trackPeople.failed')}
          </p>
        )}
      </section>
    );
  }

  const { track, roles, holders, view } = state;
  const siteAdmin = session.status === 'signed-in' && session.user.isSiteAdmin;
  // Site administrators and people who may create tracks can give that too (IAM-033).
  const mayGrantCreateTracks =
    session.status === 'signed-in' &&
    (session.user.isSiteAdmin || Boolean(session.user.mayCreateLocalTracks));
  const givable = new Set(roles.filter((r) => r.givable).map((r) => r.id));
  const appointLocked = roles.some((r) => r.runsTrack && !r.givable);
  const chosen = roles.find((r) => String(r.id) === role);
  const roleName = chosen?.name ?? '';
  const offerCreateTracks = mayGrantCreateTracks && Boolean(chosen?.runsTrack);
  const givingTracks = offerCreateTracks && createTracks;
  const anyHolder = holders.some((h) => h.users.length + h.groups.length > 0);

  const resend = (row: Row, invitation: Invitation, delivery: Delivery) => {
    setFreshLink(null);
    return run(
      row,
      async () => {
        const sent = await client.resend(track.id, invitation.id, delivery);
        if (sent.link) {
          setFreshLink({ id: invitation.id, email: invitation.email, url: sent.link });
        }
      },
      t(delivery === 'email' ? 'trackPeople.resent' : 'trackPeople.linkMade', {
        who: invitation.email,
      }),
    );
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      {/* The breadcrumb leads back to the tracks you run; no second link says the same (S3-TR-9). */}
      {titled}
      {track.mode === 'local' && (
        <section aria-labelledby={`${id}-own`} className="glass-card people-card">
          <h2 id={`${id}-own`} className="facts-title">
            {t('trackPeople.ownConfig')}
          </h2>
          <p className="page-note">{t('trackPeople.ownConfigIntro', { key: track.key })}</p>
          <ul className="link-list">
            <li>
              <a href={routeHref(ownLayoutsHref(track.id))}>{t('trackPeople.layoutsLink')}</a>
            </li>
            <li>
              <a href={routeHref(ownSetsHref(track.id))}>{t('trackPeople.setsLink')}</a>
            </li>
          </ul>
        </section>
      )}
      <div className="form-actions">
        {view.canInvite ? (
          <button
            ref={inviteButton}
            type="button"
            className="button-primary"
            disabled={givable.size === 0}
            onClick={() => setInviting(true)}
          >
            {t('trackPeople.invite')}
          </button>
        ) : (
          <p className="page-note">{t('trackPeople.inviteOff')}</p>
        )}
      </div>
      {siteAdmin && !view.invitingGiven && (
        <p className="page-note">
          {t('trackPeople.inviteOffAdmin')}{' '}
          <a href={routeHref('#/admin/permissions')}>{t('trackPeople.openPermissions')}</a>
        </p>
      )}
      {view.canInvite && !view.emailAvailable && (
        <p className="page-note">{t('trackPeople.emailOff')}</p>
      )}
      {view.canInvite && view.emailAvailable && !view.canCopyLinks && (
        <p className="page-note">{t('trackPeople.linksByEmail')}</p>
      )}

      <section aria-labelledby={`${id}-holders`} className="glass-card people-card">
        <h2 id={`${id}-holders`} className="facts-title">
          {t('trackPeople.holders')}
        </h2>
        {!anyHolder && <EmptyState compact title={t('trackPeople.noHolders')} />}
        {appointLocked && <p className="page-note">{t('trackPeople.appointLocked')}</p>}
        {(anyHolder || answerIn('holders')) && (
          <ul className="people-sublist">
            {withAnswer(
              'holders',
              holders
                .flatMap((h) => [
                  ...h.users.map((actor) => ({
                    h,
                    kind: 'users' as const,
                    actor,
                    label: t('trackPeople.inRole', { name: actor.name, role: h.roleName }),
                  })),
                  ...h.groups.map((actor) => ({
                    h,
                    kind: 'groups' as const,
                    actor,
                    label: t('trackPeople.groupInRole', { name: actor.name, role: h.roleName }),
                  })),
                ])
                .map(({ h, kind, actor, label }, index) => {
                  const key = `r${h.roleId}${kind}${actor.id}`;
                  return {
                    key,
                    node: (
                      <li key={key}>
                        <span>{label}</span>
                        {givable.has(h.roleId) && (
                          <button
                            type="button"
                            className="button-secondary people-action"
                            aria-label={t('trackPeople.takeRole', {
                              name: actor.name,
                              role: h.roleName,
                            })}
                            onClick={() =>
                              void run(
                                { list: 'holders', key, index },
                                () => client.setRole(track.id, h.roleId, kind, actor.id, false),
                                t('trackPeople.roleTaken', { name: actor.name, role: h.roleName }),
                              )
                            }
                          >
                            {t('trackPeople.remove')}
                          </button>
                        )}
                        {answerBeside('holders', key)}
                      </li>
                    ),
                  };
                }),
            )}
          </ul>
        )}

        <h2 className="facts-title">{t('trackPeople.giveRole')}</h2>
        <div className="form-field">
          <label htmlFor={`${id}-role`} className="form-label">
            {t('trackPeople.role')}
          </label>
          <select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.givable}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        {offerCreateTracks && <CreateTracksBox checked={createTracks} onChange={setCreateTracks} />}
        <div className="form-field">
          <label htmlFor={`${id}-person`} className="form-label">
            {t('trackPeople.findByName')}
          </label>
          <input
            id={`${id}-person`}
            type="search"
            value={search}
            onChange={(event) => {
              // A new search starts a new list: an answer left in the old one's place goes.
              if (answer?.list === 'found') setAnswer(null);
              setSearch(event.target.value);
            }}
          />
        </div>
        {(found.length > 0 || answerIn('found')) && (
          <ul className="people-sublist">
            {withAnswer(
              'found',
              found.map((person, index) => ({
                key: `f${person.id}`,
                node: (
                  <li key={person.id}>
                    <span>{person.name}</span>
                    <button
                      type="button"
                      className="button-secondary people-action"
                      disabled={!role}
                      aria-label={t('trackPeople.giveTo', { name: person.name, role: roleName })}
                      onClick={() =>
                        void run(
                          { list: 'found', key: `f${person.id}`, index },
                          async () => {
                            await client.setRole(
                              track.id,
                              Number(role),
                              'users',
                              person.id,
                              true,
                              givingTracks ? { createTracks: true } : undefined,
                            );
                            setSearch('');
                            setFound([]);
                          },
                          t(
                            givingTracks
                              ? 'trackPeople.roleGivenWithTracks'
                              : 'trackPeople.roleGiven',
                            {
                              name: person.name,
                              role: roleName,
                            },
                          ),
                        )
                      }
                    >
                      {t('trackPeople.add')}
                    </button>
                    {answerBeside('found', `f${person.id}`)}
                  </li>
                ),
              })),
            )}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-pending`} className="glass-card people-card">
        <h2 id={`${id}-pending`} className="facts-title">
          {t('trackPeople.pending')}
        </h2>
        {(view.invitations.length > 0 || answerIn('invitations')) && (
          <ul className="people-list">
            {withAnswer(
              'invitations',
              view.invitations.map((invitation, index) => {
                const row: Row = { list: 'invitations', key: `i${invitation.id}`, index };
                return {
                  key: row.key,
                  node: (
                    <li key={invitation.id} className="people-item">
                      <div className="people-main">
                        <p className="people-name">
                          {invitation.email}
                          {invitation.state === 'lapsed' && (
                            <span className="people-badge">{t('trackPeople.lapsed')}</span>
                          )}
                          {invitation.sendFailed && (
                            <span className="people-badge">{t('trackPeople.sendFailed')}</span>
                          )}
                        </p>
                        <p className="people-meta">
                          {t('trackPeople.pendingMeta', {
                            role: invitation.role.name,
                            who: invitation.invitedBy ?? t('trackPeople.someone'),
                          })}
                          {invitation.external ? ` ${t('trackPeople.result.external')}` : ''}
                        </p>
                      </div>
                      {view.canInvite && givable.has(invitation.role.id) && (
                        <div className="people-actions">
                          {view.emailAvailable && (
                            <button
                              type="button"
                              className="button-secondary people-action"
                              aria-label={t('trackPeople.resendTo', { who: invitation.email })}
                              onClick={() => void resend(row, invitation, 'email')}
                            >
                              {t('trackPeople.resend')}
                            </button>
                          )}
                          {view.canCopyLinks && (
                            <button
                              type="button"
                              className="button-secondary people-action"
                              aria-label={t('trackPeople.newLinkFor', { who: invitation.email })}
                              onClick={() => void resend(row, invitation, 'link')}
                            >
                              {t('trackPeople.newLink')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="button-secondary people-action"
                            aria-label={t('trackPeople.revokeFor', { who: invitation.email })}
                            onClick={() =>
                              void run(
                                row,
                                () => client.revoke(track.id, invitation.id),
                                t('trackPeople.revoked', { who: invitation.email }),
                              )
                            }
                          >
                            {t('trackPeople.revoke')}
                          </button>
                        </div>
                      )}
                      {answerBeside('invitations', row.key)}
                      {freshLink?.id === invitation.id && (
                        <div className="people-link">
                          <p className="page-note">{t('trackPeople.linkHint')}</p>
                          <input
                            type="text"
                            readOnly
                            value={freshLink.url}
                            aria-label={t('trackPeople.linkFor', { who: freshLink.email })}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => setFreshLink(null)}
                          >
                            {t('trackPeople.done')}
                          </button>
                        </div>
                      )}
                    </li>
                  ),
                };
              }),
            )}
          </ul>
        )}
        {view.invitations.length === 0 && <EmptyState compact title={t('trackPeople.noPending')} />}
      </section>

      <section aria-labelledby={`${id}-notices`} className="glass-card people-card">
        <ChecklistNoticesBox
          titleId={`${id}-notices`}
          track={track}
          on={track.checklistNotices === true}
          client={client}
          answer={answerBeside('notices', NOTICES.key)}
          onSaid={(text) => went(NOTICES, text)}
          onRefused={(error) => refused(NOTICES, error)}
        />
      </section>

      <p role="status" className="visually-hidden">
        {said}
      </p>

      {inviting && (
        <InviteDialog
          track={track}
          roles={roles}
          emailAvailable={view.emailAvailable}
          canCopyLinks={view.canCopyLinks}
          mayGrantCreateTracks={mayGrantCreateTracks}
          client={client}
          onSent={() => void load()}
          onClose={() => {
            setInviting(false);
            inviteButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}
