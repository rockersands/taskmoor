import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { ownLayoutsHref, ownSetsHref } from '../sets/trackScope';
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
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [freshLink, setFreshLink] = useState<{ email: string; url: string } | null>(null);
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
    if (body?.error === 'track_archived') return t('trackPeople.problem.archived');
    if (error.status === 403) return t('trackPeople.problem.forbidden');
    return t('trackPeople.problem.other');
  };
  const run = async (work: () => Promise<unknown>, said: string) => {
    setProblem(null);
    try {
      await work();
      setMessage(said);
      await load();
    } catch (error) {
      setMessage('');
      setProblem(refusal(error));
    }
  };

  const titled = (
    <h1 id={titleId} className="page-title">
      {state.status === 'loaded'
        ? t('trackPeople.title', { key: state.track.key, name: state.track.name })
        : t('trackPeople.titleLoading')}
    </h1>
  );
  if (state.status !== 'loaded') {
    return (
      <section aria-labelledby={titleId} className="admin-page people-page">
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

  const resend = (invitation: Invitation, delivery: Delivery) => {
    setFreshLink(null);
    return run(
      async () => {
        const answer = await client.resend(track.id, invitation.id, delivery);
        if (answer.link) setFreshLink({ email: invitation.email, url: answer.link });
      },
      t(delivery === 'email' ? 'trackPeople.resent' : 'trackPeople.linkMade', {
        who: invitation.email,
      }),
    );
  };

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      {titled}
      <p className="page-note">
        <a href={routeHref('#/manage/tracks')}>{t('trackPeople.backToList')}</a>
      </p>
      {track.mode === 'local' && (
        <section aria-labelledby={`${id}-own`}>
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
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
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

      <h2 className="facts-title">{t('trackPeople.holders')}</h2>
      {!anyHolder && <p className="page-note">{t('trackPeople.noHolders')}</p>}
      {appointLocked && <p className="page-note">{t('trackPeople.appointLocked')}</p>}
      {anyHolder && (
        <ul className="people-sublist">
          {holders.flatMap((h) => {
            const may = givable.has(h.roleId);
            const row = (kind: 'users' | 'groups', actor: Named, label: string) => (
              <li key={`r${h.roleId}${kind}${actor.id}`}>
                <span>{label}</span>
                {may && (
                  <button
                    type="button"
                    className="button-secondary people-action"
                    aria-label={t('trackPeople.takeRole', {
                      name: actor.name,
                      role: h.roleName,
                    })}
                    onClick={() =>
                      void run(
                        () => client.setRole(track.id, h.roleId, kind, actor.id, false),
                        t('trackPeople.roleTaken', { name: actor.name, role: h.roleName }),
                      )
                    }
                  >
                    {t('trackPeople.remove')}
                  </button>
                )}
              </li>
            );
            return [
              ...h.users.map((u) =>
                row('users', u, t('trackPeople.inRole', { name: u.name, role: h.roleName })),
              ),
              ...h.groups.map((g) =>
                row('groups', g, t('trackPeople.groupInRole', { name: g.name, role: h.roleName })),
              ),
            ];
          })}
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
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {found.length > 0 && (
        <ul className="people-sublist">
          {found.map((person) => (
            <li key={person.id}>
              <span>{person.name}</span>
              <button
                type="button"
                className="button-secondary people-action"
                disabled={!role}
                aria-label={t('trackPeople.giveTo', { name: person.name, role: roleName })}
                onClick={() =>
                  void run(
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
                    },
                    t(givingTracks ? 'trackPeople.roleGivenWithTracks' : 'trackPeople.roleGiven', {
                      name: person.name,
                      role: roleName,
                    }),
                  )
                }
              >
                {t('trackPeople.add')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="facts-title">{t('trackPeople.pending')}</h2>
      {freshLink && (
        <div className="people-link">
          <p className="page-note">{t('trackPeople.linkHint')}</p>
          <input
            type="text"
            readOnly
            value={freshLink.url}
            aria-label={t('trackPeople.linkFor', { who: freshLink.email })}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="button-secondary" onClick={() => setFreshLink(null)}>
            {t('trackPeople.done')}
          </button>
        </div>
      )}
      {view.invitations.length === 0 ? (
        <p className="page-note">{t('trackPeople.noPending')}</p>
      ) : (
        <ul className="people-list">
          {view.invitations.map((invitation) => (
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
                      onClick={() => void resend(invitation, 'email')}
                    >
                      {t('trackPeople.resend')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button-secondary people-action"
                    aria-label={t('trackPeople.newLinkFor', { who: invitation.email })}
                    onClick={() => void resend(invitation, 'link')}
                  >
                    {t('trackPeople.newLink')}
                  </button>
                  <button
                    type="button"
                    className="button-secondary people-action"
                    aria-label={t('trackPeople.revokeFor', { who: invitation.email })}
                    onClick={() =>
                      void run(
                        () => client.revoke(track.id, invitation.id),
                        t('trackPeople.revoked', { who: invitation.email }),
                      )
                    }
                  >
                    {t('trackPeople.revoke')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ChecklistNoticesBox
        track={track}
        on={track.checklistNotices === true}
        client={client}
        onSaid={(said) => {
          setProblem(null);
          setMessage(said);
        }}
        onRefused={(error) => {
          setMessage('');
          setProblem(refusal(error));
        }}
      />

      {inviting && (
        <InviteDialog
          track={track}
          roles={roles}
          emailAvailable={view.emailAvailable}
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
