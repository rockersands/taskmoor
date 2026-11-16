import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  ScopeNote,
  type ScopeTrack,
  TrackScopeLine,
  useSetScope,
  useTrackPageTrail,
} from '../sets/trackScope';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type FieldChoice, fieldName, type Grantee, type Named } from './client';
import {
  type NewMember,
  type VisibilityClient,
  type VisibilityLevel,
  type VisibilityMember,
  type VisibilityPolicy,
  visibilityClient,
} from './visibilityClient';

/** Who a level can name from this page, the people and groups in a field too (T-320). */
const MEMBER_KINDS: readonly Grantee[] = [
  'role',
  'group',
  'user',
  'track_owner',
  'requester',
  'assignee',
  'user_field',
  'group_field',
  'any_user',
  'anyone',
];

type Translate = ReturnType<typeof useT>;

/** Who a member is, a field member by its field's name (T-320). */
function memberName(
  t: Translate,
  member: VisibilityMember,
  fields: readonly FieldChoice[],
): string {
  const name =
    member.role?.name ??
    member.group?.name ??
    member.user?.name ??
    fieldName(fields, member.fieldKey);
  return t(`admin.permissions.grantee.${member.grantee}` as MessageId, { name });
}

/** The server refused a field member: its field is gone or not of its kind (400 `fieldKey`). */
function fieldRefused(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.body as { detail?: unknown } | null)?.detail === 'fieldKey'
  );
}

interface Feedback {
  /** Says what happened and loads the page again; the promise settles once it is loaded. */
  said: (text: string) => Promise<void>;
  failed: (error: unknown) => void;
}

interface Lists {
  roles: Named[];
  groups: Named[];
  /** The user and group fields of the site: a field member names one (T-320). */
  fields: FieldChoice[];
  client: VisibilityClient;
  /** A local-mode track's own page (T-322): people are found among those it may name. */
  track: ScopeTrack | null;
}

/** A local-mode track's own visibility policies, beside its Manage page (T-322). */
export const ownVisibilityHref = (trackId: number) =>
  `#/manage/tracks/${trackId}/visibility-policies`;

export interface VisibilityPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: VisibilityClient;
  /** A local-mode track's own page: only the policies it owns (T-322; T-163a's pattern). */
  trackId?: number | null;
}

/**
 * Visibility policies and levels (IAM-011): which tickets only some people see. A track uses one
 * policy; a level names its members, and a ticket at a level shows only to them.
 *
 * Site and configuration administrators manage the shared policies, as the server lets them. On a
 * local-mode track's own page (`trackId`; T-322) whoever runs the track manages the policies it
 * owns and makes the track use one. Someone who runs tracks but is no administrator is offered
 * those pages instead (`sets/trackScope.tsx`). Which shared policy a track uses is chosen on
 * Which sets a track uses.
 */
export function VisibilityPage({ client = visibilityClient, trackId = null }: VisibilityPageProps) {
  const t = useT();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const scope = useSetScope(trackId, client);
  const track = scope.status === 'track' ? scope.track : null;
  useTrackPageTrail(scope, t('admin.visibility.title'));
  /** The purpose shows only to someone who may be here; only the policies themselves can tell. */
  const header = (allowed: boolean, actions?: ReactNode) => (
    <PageHeader
      titleId={titleId}
      titleRef={title}
      title={t('admin.visibility.title')}
      {...(track ? { eyebrow: t('ownSets.trackName', { key: track.key, name: track.name }) } : {})}
      {...(allowed
        ? {
            purpose: t('admin.visibility.purpose'),
            about: t(track ? 'admin.visibility.trackAbout' : 'admin.visibility.about'),
            ...(actions ? { actions } : {}),
          }
        : {})}
    />
  );
  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      {scope.status === 'all' || track ? (
        <Policies
          key={track?.id ?? 'all'}
          client={client}
          track={track}
          header={header}
          title={title}
        />
      ) : (
        <>
          {header(false)}
          <ScopeNote
            scope={scope}
            hrefOf={ownVisibilityHref}
            words={{
              chooseIntro: t('admin.visibility.choose.intro'),
              chooseNone: t('admin.visibility.choose.none'),
              chooseOpen: (run) =>
                t('admin.visibility.choose.open', { key: run.key, name: run.name }),
              shared: (shared) => t('admin.visibility.scope.shared', { key: shared.key }),
              none: t('admin.visibility.forbidden'),
              failed: t('admin.visibility.failed'),
            }}
          />
        </>
      )}
    </section>
  );
}

/** The policies the page shows: every shared one, or one track's own. */
function Policies({
  client,
  track,
  header,
  title,
}: {
  client: VisibilityClient;
  track: ScopeTrack | null;
  header: (allowed: boolean, actions?: ReactNode) => ReactNode;
  /** The page's heading, which takes the focus when a policy goes. */
  title: RefObject<HTMLHeadingElement | null>;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'loaded';
        policies: VisibilityPolicy[];
        roles: Named[];
        groups: Named[];
        fields: FieldChoice[];
      }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const creating = useNewForm();
  const owner = track?.id ?? null;

  const load = useCallback(async () => {
    try {
      const [policies, roles, groups, fields] = await Promise.all([
        client.policies(owner),
        // The lists only offer choices: a level's form without them still names the ticket's
        // people (T-322).
        client.roles(track).catch(() => []),
        client.groups(),
        client.fields(track).catch(() => []),
      ]);
      setState({ status: 'loaded', policies, roles, groups, fields });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, owner, track, expired]);
  useEffect(() => {
    void load();
  }, [load]);

  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    return load();
  };
  const failed = (error: unknown) => {
    if (expired(error)) return;
    const code =
      error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
    setProblem(
      code === 'name_taken'
        ? t('admin.visibility.problem.nameTaken')
        : code === 'in_use'
          ? t('admin.visibility.problem.policyInUse')
          : code === 'levels_in_use'
            ? t('admin.visibility.problem.levelsInUse')
            : code === 'already_member'
              ? t('admin.visibility.problem.alreadyMember')
              : code === 'limit_reached' || code === 'too_many_members'
                ? t('admin.visibility.problem.limit')
                : fieldRefused(error)
                  ? t('admin.permissions.problem.field')
                  : error instanceof ApiError && (error.status === 403 || error.status === 404)
                    ? t('admin.visibility.problem.forbidden')
                    : t('admin.visibility.problem.other'),
    );
  };

  if (state.status === 'forbidden') {
    return (
      <>
        {header(false)}
        <p className="page-note">{t('admin.visibility.forbidden')}</p>
      </>
    );
  }
  const policies = state.status === 'loaded' ? state.policies : [];
  const usedHere = track ? policies.find((p) => p.usedBy.some((u) => u.id === track.id)) : null;
  return (
    <>
      {header(
        true,
        <NewButton
          label={t('admin.visibility.newPolicy')}
          open={creating.open}
          onToggle={creating.toggle}
          ref={creating.button}
        />,
      )}
      {track && <TrackScopeLine track={track} intro={t('admin.visibility.trackIntro')} />}
      {track && state.status === 'loaded' && (
        <p className="page-note">
          {usedHere
            ? t('admin.visibility.trackUsesOwn', { key: track.key, name: usedHere.name })
            : track.visibilityPolicyId == null
              ? t('admin.visibility.trackUsesNoPolicy', { key: track.key })
              : t('admin.visibility.trackUsesShared', { key: track.key })}
        </p>
      )}
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('admin.visibility.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.visibility.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {creating.open && (
            <AddPolicy
              client={client}
              track={track}
              said={(text) => {
                creating.close();
                return said(text);
              }}
              failed={failed}
              onCancel={creating.close}
            />
          )}
          {state.policies.length === 0 ? (
            <EmptyState title={t('admin.visibility.emptyTitle')}>
              {track
                ? t('admin.visibility.ownEmpty', { key: track.key })
                : t('admin.visibility.empty')}
            </EmptyState>
          ) : (
            state.policies.map((policy) => (
              <PolicyPanel
                key={policy.id}
                policy={policy}
                client={client}
                track={track}
                roles={state.roles}
                groups={state.groups}
                fields={state.fields}
                said={said}
                failed={failed}
                onDeleted={() => title.current?.focus()}
              />
            ))
          )}
        </>
      )}
    </>
  );
}

function AddPolicy({
  client,
  track,
  said,
  failed,
  onCancel,
}: Feedback & { client: VisibilityClient; track: ScopeTrack | null; onCancel: () => void }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    client.createPolicy({ name: trimmed, ...(track ? { trackId: track.id } : {}) }).then(() => {
      setName('');
      said(t('admin.visibility.policyAdded', { name: trimmed }));
    }, failed);
  };
  return (
    <form
      className="glass-card people-card people-inline"
      aria-label={t('admin.visibility.addPolicy')}
      onSubmit={submit}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.visibility.policyName')}
        </label>
        <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.visibility.addPolicy')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.visibility.cancelNew')}
        </button>
      </div>
    </form>
  );
}

function PolicyPanel({
  policy,
  client,
  track,
  roles,
  groups,
  fields,
  said,
  failed,
  onDeleted,
}: Feedback &
  Lists & {
    policy: VisibilityPolicy;
    /** The policy is gone: the page's heading takes the focus. */
    onDeleted: () => void;
  }) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [levelName, setLevelName] = useState('');
  // A track's own page offers its own policies to the track (T-322).
  const mayUse =
    track !== null &&
    policy.trackId === track.id &&
    !policy.usedBy.some((used) => used.id === track.id);
  const addLevel = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = levelName.trim();
    if (!trimmed) return;
    client.addLevel(policy.id, { name: trimmed }).then(() => {
      setLevelName('');
      said(t('admin.visibility.levelAdded', { name: trimmed }));
    }, failed);
  };
  return (
    <section aria-labelledby={`${id}-title`} className="glass-card admin-panel">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="section-title">
        {policy.name}
      </h2>
      {policy.description && <p className="page-note">{policy.description}</p>}
      <p className="page-note">
        {policy.usedBy.length > 0
          ? t('admin.visibility.usedBy', { tracks: policy.usedBy.map((u) => u.key).join(', ') })
          : t('admin.visibility.unused')}
      </p>
      <div className="form-field">
        <label htmlFor={`${id}-default`} className="form-label">
          {t('admin.visibility.defaultLevel')}
        </label>
        <select
          id={`${id}-default`}
          value={policy.defaultLevelId ?? ''}
          aria-describedby={`${id}-default-hint`}
          onChange={(e) => {
            const value = e.target.value;
            client
              .updatePolicy(policy.id, { defaultLevelId: value ? Number(value) : null })
              .then(() => said(t('admin.visibility.defaultSaved', { name: policy.name })), failed);
          }}
        >
          <option value="">{t('admin.visibility.noDefault')}</option>
          {policy.levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
        <p id={`${id}-default-hint`} className="form-hint">
          {t('admin.visibility.defaultHint')}
        </p>
      </div>
      {policy.levels.length === 0 ? (
        <EmptyState compact title={t('admin.visibility.noLevels')} />
      ) : (
        <ul className="people-list">
          {policy.levels.map((level, index) => (
            <LevelRow
              key={level.id}
              policy={policy}
              level={level}
              index={index}
              client={client}
              track={track}
              roles={roles}
              groups={groups}
              fields={fields}
              said={said}
              failed={failed}
              onDeleted={() => heading.current?.focus()}
            />
          ))}
        </ul>
      )}
      <form
        className="people-inline"
        aria-label={t('admin.visibility.addLevelTo', { name: policy.name })}
        onSubmit={addLevel}
      >
        <div className="form-field">
          <label htmlFor={`${id}-level`} className="form-label">
            {t('admin.visibility.levelName')}
          </label>
          <input
            id={`${id}-level`}
            value={levelName}
            onChange={(e) => setLevelName(e.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.visibility.addLevel')}
        </button>
      </form>
      {mayUse && track && (
        <div className="sets-assign">
          <button
            type="button"
            className="button-secondary"
            aria-describedby={`${id}-use-hint`}
            onClick={() =>
              client.chooseFor(track.id, policy.id).then(async () => {
                await said(t('admin.visibility.usedFor', { key: track.key, name: policy.name }));
                // The button is gone with the change: the policy's heading takes the focus.
                heading.current?.focus();
              }, failed)
            }
          >
            {t('admin.visibility.useFor', { key: track.key })}
          </button>
          <p id={`${id}-use-hint`} className="form-hint">
            {t('admin.visibility.useHint')}
          </p>
        </div>
      )}
      <div className="people-actions">
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('admin.visibility.deletePolicy')}
          name={t('admin.visibility.deletePolicyOf', { name: policy.name })}
          outcome={t('admin.visibility.confirmDeletePolicy', { name: policy.name })}
          confirmLabel={t('admin.visibility.deletePolicyOf', { name: policy.name })}
          onConfirm={async () => {
            try {
              await client.deletePolicy(policy.id);
            } catch (error) {
              failed(error);
              throw error;
            }
            await said(t('admin.visibility.policyDeleted', { name: policy.name }));
            onDeleted();
          }}
        />
      </div>
    </section>
  );
}

function LevelRow({
  policy,
  level,
  index,
  client,
  track,
  roles,
  groups,
  fields,
  said,
  failed,
  onDeleted,
}: Feedback &
  Lists & {
    policy: VisibilityPolicy;
    level: VisibilityLevel;
    index: number;
    /** The level is gone: its policy's heading takes the focus. */
    onDeleted: () => void;
  }) {
  const t = useT();
  const id = useId();
  const row = useRef<HTMLLIElement>(null);
  const replaceSelect = useRef<HTMLSelectElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(level.name);
  const [description, setDescription] = useState(level.description);
  /** How many tickets need another level, once the server said the level is in use. */
  const [deleting, setDeleting] = useState<null | { tickets: number }>(null);
  const [replacement, setReplacement] = useState('none');
  const others = policy.levels.filter((l) => l.id !== level.id);
  // In use: the question closes and the choice of a level for its tickets takes the focus.
  useEffect(() => {
    if (deleting) replaceSelect.current?.focus();
  }, [deleting]);
  const remove = async (replaceWith?: number | 'none') => {
    try {
      await client.deleteLevel(policy.id, level.id, replaceWith);
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { ticketCount?: number }) : null;
      if (error instanceof ApiError && error.status === 409 && body?.ticketCount) {
        setDeleting({ tickets: body.ticketCount });
        return;
      }
      setDeleting(null);
      failed(error);
      throw error;
    }
    setDeleting(null);
    await said(t('admin.visibility.levelDeleted', { name: level.name }));
    onDeleted();
  };
  const move = (position: number) =>
    client
      .updateLevel(policy.id, level.id, { position })
      .then(() => said(t('admin.visibility.levelMoved', { name: level.name })), failed);
  return (
    <li ref={row} className="people-item people-group">
      <div className="people-main">
        <p className="people-name">
          {level.name}
          {policy.defaultLevelId === level.id && (
            <span className="people-badge">{t('admin.visibility.default')}</span>
          )}
        </p>
        {level.description && <p className="people-meta">{level.description}</p>}
        {level.members.length === 0 ? (
          <EmptyState compact title={t('admin.visibility.noMembers')} />
        ) : (
          <ul
            className="visibility-members"
            aria-label={t('admin.visibility.membersOf', { name: level.name })}
          >
            {level.members.map((member) => (
              <li key={member.id} className="visibility-member">
                <span>{memberName(t, member, fields)}</span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.visibility.removeMember', {
                    member: memberName(t, member, fields),
                    level: level.name,
                  })}
                  onClick={() => {
                    client.removeMember(policy.id, level.id, member.id).then(
                      () =>
                        said(
                          t('admin.visibility.memberRemoved', {
                            member: memberName(t, member, fields),
                            level: level.name,
                          }),
                        ),
                      failed,
                    );
                  }}
                >
                  {t('admin.visibility.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <AddMember
          level={level}
          client={client}
          track={track}
          roles={roles}
          groups={groups}
          // A shared policy names shared fields; a local-mode track's own, its track's too.
          fields={fields.filter((f) => f.trackId === null || f.trackId === policy.trackId)}
          onAdd={(member, label) =>
            client
              .addMember(policy.id, level.id, member)
              .then(
                () => said(t('admin.visibility.memberAdded', { member: label, level: level.name })),
                failed,
              )
          }
        />
        {editing && (
          <form
            className="people-inline"
            aria-label={t('admin.visibility.changeLevelOf', { name: level.name })}
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              client.updateLevel(policy.id, level.id, { name: trimmed, description }).then(() => {
                setEditing(false);
                said(t('admin.visibility.levelChanged', { name: trimmed }));
              }, failed);
            }}
          >
            <div className="form-field">
              <label htmlFor={`${id}-name`} className="form-label">
                {t('admin.visibility.levelName')}
              </label>
              <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-about`} className="form-label">
                {t('admin.visibility.levelDescription')}
              </label>
              <input
                id={`${id}-about`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <button type="submit" className="button-secondary">
              {t('admin.visibility.saveLevel')}
            </button>
          </form>
        )}
        {deleting && (
          <form
            className="people-inline"
            aria-label={t('admin.visibility.replaceLevelOf', { name: level.name })}
            onSubmit={(event) => {
              event.preventDefault();
              remove(replacement === 'none' ? 'none' : Number(replacement)).catch(() => {});
            }}
          >
            <p className="people-meta">
              {t('admin.visibility.levelInUse', { count: deleting.tickets, name: level.name })}
            </p>
            <div className="form-field">
              <label htmlFor={`${id}-replace`} className="form-label">
                {t('admin.visibility.replaceWith')}
              </label>
              <select
                ref={replaceSelect}
                id={`${id}-replace`}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              >
                <option value="none">{t('admin.visibility.replaceNone')}</option>
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="button-danger people-action">
              {t('admin.visibility.deleteLevel')}
            </button>
            <button
              type="button"
              className="button-secondary people-action"
              onClick={() => {
                setDeleting(null);
                // Back to the level's own Delete level.
                row.current?.querySelector<HTMLButtonElement>('.button-danger-quiet')?.focus();
              }}
            >
              {t('danger.cancel')}
            </button>
          </form>
        )}
      </div>
      <div className="people-actions">
        <button
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.visibility.moveUp', { name: level.name })}
          disabled={index === 0}
          onClick={() => void move(index - 1)}
        >
          {t('admin.visibility.up')}
        </button>
        <button
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.visibility.moveDown', { name: level.name })}
          disabled={index === policy.levels.length - 1}
          onClick={() => void move(index + 1)}
        >
          {t('admin.visibility.down')}
        </button>
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={editing}
          aria-label={t('admin.visibility.changeLevelOf', { name: level.name })}
          onClick={() => setEditing(!editing)}
        >
          {t('admin.visibility.change')}
        </button>
        {/* Asks first, saying what will happen (D13); a level in use asks where its tickets go. */}
        <DangerAction
          label={t('admin.visibility.deleteLevel')}
          name={t('admin.visibility.deleteLevelOf', { name: level.name })}
          outcome={t('admin.visibility.confirmDeleteLevel', { name: level.name })}
          confirmLabel={t('admin.visibility.deleteLevelOf', { name: level.name })}
          onConfirm={() => remove()}
        />
      </div>
    </li>
  );
}

function AddMember({
  level,
  client,
  track,
  roles,
  groups,
  fields,
  onAdd,
}: Lists & {
  level: VisibilityLevel;
  onAdd: (member: NewMember, label: string) => void;
}) {
  const t = useT();
  const id = useId();
  // A role or a group is offered only with one to choose: someone who runs a track but is no
  // administrator reads no groups (T-322).
  const kinds = MEMBER_KINDS.filter((g) =>
    g === 'role' ? roles.length > 0 : g === 'group' ? groups.length > 0 : true,
  );
  const [kind, setKind] = useState<Grantee>(() => kinds[0] ?? 'role');
  const ofKind = (of: Grantee) =>
    fields.filter((f) => f.type === (of === 'user_field' ? 'user' : 'group'));
  const firstTarget = (of: Grantee) =>
    of === 'role'
      ? String(roles[0]?.id ?? '')
      : of === 'group'
        ? String(groups[0]?.id ?? '')
        : of === 'user_field' || of === 'group_field'
          ? (ofKind(of)[0]?.key ?? '')
          : '';
  const [target, setTarget] = useState(() => firstTarget(kind));
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Named[]>([]);

  useEffect(() => {
    if (kind !== 'user' || query.trim() === '') {
      setPeople([]);
      return;
    }
    let live = true;
    client.findPeople(query.trim(), track).then(
      (found) => {
        if (!live) return;
        setPeople(found);
        setTarget(String(found[0]?.id ?? ''));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, kind, query, track]);

  const byField = kind === 'user_field' || kind === 'group_field';
  // Every target as a value and a name: a field's value is its key.
  const targets: { value: string; name: string }[] = byField
    ? ofKind(kind).map((f) => ({ value: f.key, name: f.name }))
    : (kind === 'role' ? roles : kind === 'group' ? groups : people).map((x) => ({
        value: String(x.id),
        name: x.name,
      }));
  const needsTarget = kind === 'role' || kind === 'group' || kind === 'user' || byField;
  return (
    <form
      className="people-inline"
      aria-label={t('admin.visibility.addMemberTo', { name: level.name })}
      onSubmit={(event) => {
        event.preventDefault();
        if (needsTarget && !target) return;
        const picked = targets.find((x) => x.value === target);
        onAdd(
          {
            grantee: kind,
            ...(kind === 'role' ? { roleId: Number(target) } : {}),
            ...(kind === 'group' ? { groupId: Number(target) } : {}),
            ...(kind === 'user' ? { userId: Number(target) } : {}),
            ...(byField ? { fieldKey: target } : {}),
          },
          t(`admin.permissions.grantee.${kind}` as MessageId, { name: picked?.name ?? '' }),
        );
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-kind`} className="form-label">
          {t('admin.visibility.memberKind')}
        </label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as Grantee;
            setKind(next);
            setTarget(firstTarget(next));
          }}
        >
          {kinds.map((g) => (
            <option key={g} value={g}>
              {t(`admin.permissions.granteeKind.${g}` as MessageId)}
            </option>
          ))}
        </select>
      </div>
      {kind === 'user' && (
        <div className="form-field">
          <label htmlFor={`${id}-find`} className="form-label">
            {t('admin.permissions.findPerson')}
          </label>
          <input
            id={`${id}-find`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {needsTarget && (
        <div className="form-field">
          <label htmlFor={`${id}-target`} className="form-label">
            {t(
              kind === 'role'
                ? 'admin.permissions.pickRole'
                : kind === 'group'
                  ? 'admin.permissions.pickGroup'
                  : kind === 'user_field'
                    ? 'admin.permissions.pickUserField'
                    : kind === 'group_field'
                      ? 'admin.permissions.pickGroupField'
                      : 'admin.permissions.pickPerson',
            )}
          </label>
          <select id={`${id}-target`} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.length === 0 && (
              <option value="">
                {t(
                  byField
                    ? 'admin.permissions.pickFieldEmpty'
                    : 'admin.permissions.pickPersonEmpty',
                )}
              </option>
            )}
            {targets.map((x) => (
              <option key={x.value} value={x.value}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button type="submit" className="button-secondary">
        {t('admin.visibility.addMember')}
      </button>
    </form>
  );
}
