import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import type { Grantee, Named } from './client';
import {
  type NewMember,
  type VisibilityClient,
  type VisibilityLevel,
  type VisibilityMember,
  type VisibilityPolicy,
  visibilityClient,
} from './visibilityClient';

/** Who a level can name from this page; people and groups in a field go through the API. */
const MEMBER_KINDS: readonly Grantee[] = [
  'role',
  'group',
  'user',
  'track_owner',
  'requester',
  'assignee',
  'any_user',
  'anyone',
];

type Translate = ReturnType<typeof useT>;

function memberName(t: Translate, member: VisibilityMember): string {
  const name =
    member.role?.name ?? member.group?.name ?? member.user?.name ?? member.fieldKey ?? '';
  return t(`admin.permissions.grantee.${member.grantee}` as MessageId, { name });
}

interface Feedback {
  /** Says what happened and loads the page again; the promise settles once it is loaded. */
  said: (text: string) => Promise<void>;
  failed: (error: unknown) => void;
}

interface Lists {
  roles: Named[];
  groups: Named[];
  client: VisibilityClient;
}

/**
 * Visibility policies and levels (IAM-011): which tickets only some people see. A track uses one
 * policy; a level names its members, and a ticket at a level shows only to them.
 */
export function VisibilityPage({ client = visibilityClient }: { client?: VisibilityClient }) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; policies: VisibilityPolicy[]; roles: Named[]; groups: Named[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const creating = useNewForm();

  const load = useCallback(async () => {
    try {
      const [policies, roles, groups] = await Promise.all([
        client.policies(),
        client.roles(),
        client.groups(),
      ]);
      setState({ status: 'loaded', policies, roles, groups });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    return load();
  };
  const failed = (error: unknown) => {
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
                : t('admin.visibility.problem.other'),
    );
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.visibility.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('admin.visibility.purpose'),
              about: t('admin.visibility.about'),
              actions: (
                <NewButton
                  label={t('admin.visibility.newPolicy')}
                  open={creating.open}
                  onToggle={creating.toggle}
                  ref={creating.button}
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.visibility.forbidden')}</p>
      ) : (
        <>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && (
            <p className="page-note">{t('admin.visibility.loading')}</p>
          )}
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
                  {t('admin.visibility.empty')}
                </EmptyState>
              ) : (
                state.policies.map((policy) => (
                  <PolicyPanel
                    key={policy.id}
                    policy={policy}
                    client={client}
                    roles={state.roles}
                    groups={state.groups}
                    said={said}
                    failed={failed}
                    onDeleted={() => title.current?.focus()}
                  />
                ))
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function AddPolicy({
  client,
  said,
  failed,
  onCancel,
}: Feedback & { client: VisibilityClient; onCancel: () => void }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    client.createPolicy({ name: trimmed }).then(() => {
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
  roles,
  groups,
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
              roles={roles}
              groups={groups}
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
  roles,
  groups,
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
                <span>{memberName(t, member)}</span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.visibility.removeMember', {
                    member: memberName(t, member),
                    level: level.name,
                  })}
                  onClick={() => {
                    client.removeMember(policy.id, level.id, member.id).then(
                      () =>
                        said(
                          t('admin.visibility.memberRemoved', {
                            member: memberName(t, member),
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
          roles={roles}
          groups={groups}
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
  roles,
  groups,
  onAdd,
}: Lists & {
  level: VisibilityLevel;
  onAdd: (member: NewMember, label: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [kind, setKind] = useState<Grantee>('role');
  const firstTarget = (of: Grantee) =>
    of === 'role' ? String(roles[0]?.id ?? '') : of === 'group' ? String(groups[0]?.id ?? '') : '';
  const [target, setTarget] = useState(() => firstTarget('role'));
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Named[]>([]);

  useEffect(() => {
    if (kind !== 'user' || query.trim() === '') {
      setPeople([]);
      return;
    }
    let live = true;
    client.findPeople(query.trim()).then(
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
  }, [client, kind, query]);

  const targets = kind === 'role' ? roles : kind === 'group' ? groups : people;
  const needsTarget = kind === 'role' || kind === 'group' || kind === 'user';
  return (
    <form
      className="people-inline"
      aria-label={t('admin.visibility.addMemberTo', { name: level.name })}
      onSubmit={(event) => {
        event.preventDefault();
        if (needsTarget && !target) return;
        const picked = targets.find((x) => String(x.id) === target);
        onAdd(
          {
            grantee: kind,
            ...(kind === 'role' ? { roleId: Number(target) } : {}),
            ...(kind === 'group' ? { groupId: Number(target) } : {}),
            ...(kind === 'user' ? { userId: Number(target) } : {}),
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
          {MEMBER_KINDS.map((g) => (
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
                  : 'admin.permissions.pickPerson',
            )}
          </label>
          <select id={`${id}-target`} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.length === 0 && (
              <option value="">{t('admin.permissions.pickPersonEmpty')}</option>
            )}
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
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
