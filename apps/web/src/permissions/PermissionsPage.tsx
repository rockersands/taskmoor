import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type Catalogue,
  type Grant,
  type Grantee,
  type Named,
  type NewGrant,
  type PermissionsClient,
  type Policy,
  type PolicySummary,
  permissionsClient,
  type Role,
} from './client';

export interface PermissionsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PermissionsClient;
}

/** Grantees a policy grant can name from this page; field grantees go through the API. */
const POLICY_GRANTEES: readonly Grantee[] = [
  'role',
  'group',
  'user',
  'track_owner',
  'requester',
  'assignee',
  'any_user',
  'anyone',
];
const GLOBAL_GRANTEES: readonly Grantee[] = ['group', 'user', 'any_user'];

type Translate = ReturnType<typeof useT>;

function permissionName(t: Translate, permission: string): string {
  return t(`permission.${permission}` as MessageId);
}

function granteeName(t: Translate, grant: Grant): string {
  const name = grant.roleName ?? grant.groupName ?? grant.userName ?? grant.fieldKey ?? '';
  return t(`admin.permissions.grantee.${grant.grantee}` as MessageId, { name });
}

/** Grants by permission, in the order the permissions come. */
function byPermission(grants: Grant[], order: string[]): [string, Grant[]][] {
  const map = new Map<string, Grant[]>();
  for (const grant of grants)
    map.set(grant.permission, [...(map.get(grant.permission) ?? []), grant]);
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/**
 * Permissions (IAM-009 to IAM-012), for site administrators: roles, access policies and their
 * grants, and global permissions. Grants to people in a field of the ticket are given through
 * the API for now.
 */
export function PermissionsPage({ client = permissionsClient }: PermissionsPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'loaded';
        catalogue: Catalogue;
        roles: Role[];
        policies: PolicySummary[];
        global: Grant[];
        groups: Named[];
      }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [catalogue, roles, policies, global, groups] = await Promise.all([
        client.catalogue(),
        client.roles(),
        client.policies(),
        client.globalGrants(),
        client.groups(),
      ]);
      setState({ status: 'loaded', catalogue, roles, policies, global, groups });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const refusal = useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError)) return t('admin.permissions.problem.other');
      const body = error.body as { error?: string; detail?: string } | null;
      if (body?.error === 'role_in_use') return t('admin.permissions.problem.roleInUse');
      if (body?.error === 'policy_in_use') return t('admin.permissions.problem.policyInUse');
      if (body?.error === 'name_taken') return t('admin.permissions.problem.nameTaken');
      if (body?.error === 'grant_exists') return t('admin.permissions.problem.grantExists');
      if (body?.detail === 'administration cannot go to everyone') {
        return t('admin.permissions.problem.everyone');
      }
      if (error.status === 403) return t('admin.permissions.problem.forbidden');
      return t('admin.permissions.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };
  const failed = (error: unknown) => setProblem(refusal(error));

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <h1 id={titleId} className="page-title">
        {t('admin.permissions.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.permissions.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.permissions.intro')}</p>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && (
            <p className="page-note">{t('admin.permissions.loading')}</p>
          )}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.permissions.failed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <>
              <RolesSection client={client} roles={state.roles} said={said} failed={failed} />
              <PoliciesSection
                client={client}
                catalogue={state.catalogue}
                roles={state.roles}
                groups={state.groups}
                policies={state.policies}
                said={said}
                failed={failed}
              />
              <GlobalSection
                client={client}
                catalogue={state.catalogue}
                groups={state.groups}
                grants={state.global}
                said={said}
                failed={failed}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

interface Feedback {
  said: (message: string) => void;
  failed: (error: unknown) => void;
}

function RolesSection({
  client,
  roles,
  said,
  failed,
}: Feedback & { client: PermissionsClient; roles: Role[] }) {
  const t = useT();
  const headingId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  return (
    <section aria-labelledby={headingId} className="people-page">
      <h2 id={headingId} className="facts-title">
        {t('admin.permissions.roles')}
      </h2>
      <form
        className="people-inline"
        aria-label={t('admin.permissions.addRole')}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted) return;
          client.createRole({ name: wanted }).then((made) => {
            setName('');
            said(t('admin.permissions.roleAdded', { name: made.name }));
          }, failed);
        }}
      >
        <div className="form-field">
          <label htmlFor={nameId} className="form-label">
            {t('admin.permissions.roleName')}
          </label>
          <input
            id={nameId}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.permissions.addRole')}
        </button>
      </form>
      <ul className="people-list">
        {roles.map((role) => (
          <RoleRow key={role.id} role={role} client={client} said={said} failed={failed} />
        ))}
      </ul>
    </section>
  );
}

function RoleRow({
  role,
  client,
  said,
  failed,
}: Feedback & { role: Role; client: PermissionsClient }) {
  const t = useT();
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  return (
    <li className="people-item people-group">
      <div className="people-main">
        <p className="people-name">{role.name}</p>
        {role.description && <p className="people-meta">{role.description}</p>}
      </div>
      <div className="people-actions">
        {confirming ? (
          <>
            <span className="people-confirm">
              {t('admin.permissions.confirmDeleteRole', { name: role.name })}
            </span>
            <button
              type="button"
              className="button-danger people-action"
              onClick={() => {
                setConfirming(false);
                client
                  .deleteRole(role.id)
                  .then(
                    () => said(t('admin.permissions.roleDeleted', { name: role.name })),
                    failed,
                  );
              }}
            >
              {t('admin.permissions.confirmYes')}
            </button>
            <button
              type="button"
              className="button-secondary people-action"
              onClick={() => setConfirming(false)}
            >
              {t('admin.permissions.confirmNo')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button-secondary people-action"
              aria-expanded={editing}
              aria-label={t('admin.permissions.editRoleOf', { name: role.name })}
              onClick={() => setEditing(!editing)}
            >
              {t('admin.permissions.editRole')}
            </button>
            <button
              type="button"
              className="button-secondary people-action"
              aria-label={t('admin.permissions.deleteRoleOf', { name: role.name })}
              onClick={() => setConfirming(true)}
            >
              {t('admin.permissions.deleteRole')}
            </button>
          </>
        )}
      </div>
      {editing && (
        <form
          className="people-panel"
          aria-label={t('admin.permissions.editRoleOf', { name: role.name })}
          onSubmit={(event) => {
            event.preventDefault();
            client.updateRole(role.id, { name: name.trim(), description }).then((saved) => {
              setEditing(false);
              said(t('admin.permissions.roleSaved', { name: saved.name }));
            }, failed);
          }}
        >
          <div className="form-field">
            <label htmlFor={`${formId}-name`} className="form-label">
              {t('admin.permissions.roleName')}
            </label>
            <input
              id={`${formId}-name`}
              type="text"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-description`} className="form-label">
              {t('admin.permissions.roleDescription')}
            </label>
            <input
              id={`${formId}-description`}
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="button-primary">
              {t('admin.permissions.saveRole')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setEditing(false)}>
              {t('admin.permissions.cancel')}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function PoliciesSection({
  client,
  catalogue,
  roles,
  groups,
  policies,
  said,
  failed,
}: Feedback & {
  client: PermissionsClient;
  catalogue: Catalogue;
  roles: Role[];
  groups: Named[];
  policies: PolicySummary[];
}) {
  const t = useT();
  const headingId = useId();
  const nameId = useId();
  const copyId = useId();
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  // Only shared policies are managed here; a local-mode track's own goes with the track.
  const shared = policies.filter((p) => p.ownerTrackId === null);
  return (
    <section aria-labelledby={headingId} className="people-page">
      <h2 id={headingId} className="facts-title">
        {t('admin.permissions.policies')}
      </h2>
      <form
        className="people-inline"
        aria-label={t('admin.permissions.addPolicy')}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted) return;
          client
            .createPolicy({ name: wanted, ...(copyFrom ? { copyFrom: Number(copyFrom) } : {}) })
            .then((made) => {
              setName('');
              setCopyFrom('');
              setOpen(made.id);
              said(t('admin.permissions.policyAdded', { name: made.name }));
            }, failed);
        }}
      >
        <div className="form-field">
          <label htmlFor={nameId} className="form-label">
            {t('admin.permissions.policyName')}
          </label>
          <input
            id={nameId}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={copyId} className="form-label">
            {t('admin.permissions.copyFrom')}
          </label>
          <select
            id={copyId}
            value={copyFrom}
            onChange={(event) => setCopyFrom(event.target.value)}
          >
            <option value="">{t('admin.permissions.copyNothing')}</option>
            {shared.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.permissions.addPolicy')}
        </button>
      </form>
      <ul className="people-list">
        {shared.map((p) => (
          <li key={p.id} className="people-item people-group">
            <div className="people-main">
              <p className="people-name">
                {p.name}
                {p.isDefault && (
                  <span className="people-badge">{t('admin.permissions.default')}</span>
                )}
              </p>
              <p className="people-meta">
                {t('admin.permissions.policySummary', {
                  grants: p.grantCount,
                  tracks: p.trackCount,
                })}
              </p>
            </div>
            <div className="people-actions">
              <button
                type="button"
                className="button-secondary people-action"
                aria-expanded={open === p.id}
                aria-label={t('admin.permissions.manageOf', { name: p.name })}
                onClick={() => setOpen(open === p.id ? null : p.id)}
              >
                {t('admin.permissions.manage')}
              </button>
            </div>
            {open === p.id && (
              <PolicyPanel
                id={p.id}
                client={client}
                catalogue={catalogue}
                roles={roles}
                groups={groups}
                said={said}
                failed={failed}
                onDeleted={(deleted) => {
                  setOpen(null);
                  said(t('admin.permissions.policyDeleted', { name: deleted }));
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PolicyPanel({
  id,
  client,
  catalogue,
  roles,
  groups,
  said,
  failed,
  onDeleted,
}: Feedback & {
  id: number;
  client: PermissionsClient;
  catalogue: Catalogue;
  roles: Role[];
  groups: Named[];
  onDeleted: (name: string) => void;
}) {
  const t = useT();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const reload = useCallback(() => client.policy(id).then(setPolicy, failed), [client, id, failed]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per policy
  useEffect(() => {
    void reload();
  }, [id]);

  if (!policy) return <p className="page-note people-panel">{t('admin.permissions.loading')}</p>;
  const order = Object.values(catalogue.track).flat();
  const name = policy.policy.name;
  return (
    <div className="people-panel">
      <GrantList
        grants={policy.grants}
        order={order}
        onRemove={(grant) =>
          client.removeGrant(id, grant.id).then(() => {
            void reload();
            said(
              t('admin.permissions.removed', {
                grantee: granteeName(t, grant),
                permission: permissionName(t, grant.permission),
              }),
            );
          }, failed)
        }
      />
      <GrantForm
        label={t('admin.permissions.addGrantTo', { name })}
        permissions={catalogue.track}
        grantees={POLICY_GRANTEES}
        roles={roles}
        groups={groups}
        client={client}
        onGive={(grant, grantee) =>
          client.addGrant(id, grant).then(() => {
            void reload();
            said(
              t('admin.permissions.granted', {
                permission: permissionName(t, grant.permission),
                grantee,
              }),
            );
          }, failed)
        }
      />
      {policy.tracks.length > 0 && (
        <p className="page-note">
          {t('admin.permissions.usedBy', { tracks: policy.tracks.map((tr) => tr.key).join(', ') })}
        </p>
      )}
      {!policy.policy.isDefault && (
        <div className="form-actions">
          {confirming ? (
            <>
              <span className="people-confirm">
                {t('admin.permissions.confirmDeletePolicy', { name })}
              </span>
              <button
                type="button"
                className="button-danger"
                onClick={() => {
                  setConfirming(false);
                  client.deletePolicy(id).then(() => onDeleted(name), failed);
                }}
              >
                {t('admin.permissions.confirmYes')}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirming(false)}
              >
                {t('admin.permissions.confirmNo')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-secondary"
              aria-label={t('admin.permissions.deletePolicyOf', { name })}
              onClick={() => setConfirming(true)}
            >
              {t('admin.permissions.deletePolicy')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GlobalSection({
  client,
  catalogue,
  groups,
  grants,
  said,
  failed,
}: Feedback & {
  client: PermissionsClient;
  catalogue: Catalogue;
  groups: Named[];
  grants: Grant[];
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="people-page">
      <h2 id={headingId} className="facts-title">
        {t('admin.permissions.global')}
      </h2>
      <GrantList
        grants={grants}
        order={catalogue.global}
        onRemove={(grant) =>
          client.removeGlobalGrant(grant.id).then(
            () =>
              said(
                t('admin.permissions.removed', {
                  grantee: granteeName(t, grant),
                  permission: permissionName(t, grant.permission),
                }),
              ),
            failed,
          )
        }
      />
      <GrantForm
        label={t('admin.permissions.addGlobal')}
        permissions={{ global: catalogue.global }}
        grantees={GLOBAL_GRANTEES}
        roles={[]}
        groups={groups}
        client={client}
        onGive={(grant, grantee) =>
          client.addGlobalGrant(grant).then(
            () =>
              said(
                t('admin.permissions.granted', {
                  permission: permissionName(t, grant.permission),
                  grantee,
                }),
              ),
            failed,
          )
        }
      />
    </section>
  );
}

/** Grants by permission, each grantee with a remove button. */
function GrantList({
  grants,
  order,
  onRemove,
}: {
  grants: Grant[];
  order: string[];
  onRemove: (grant: Grant) => void;
}) {
  const t = useT();
  if (grants.length === 0) return <p className="page-note">{t('admin.permissions.noGrants')}</p>;
  return (
    <dl className="permission-list">
      {byPermission(grants, order).map(([permission, list]) => (
        <div key={permission} className="permission-row">
          <dt>{permissionName(t, permission)}</dt>
          {list.map((grant) => (
            <dd key={grant.id} className="people-sublist-row">
              <span>{granteeName(t, grant)}</span>
              <button
                type="button"
                className="button-secondary people-action"
                aria-label={t('admin.permissions.removeOf', {
                  grantee: granteeName(t, grant),
                  permission: permissionName(t, permission),
                })}
                onClick={() => onRemove(grant)}
              >
                {t('admin.permissions.remove')}
              </button>
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}

/** Give a permission to a role, a group, a person or one of the fixed grantees. */
function GrantForm({
  label,
  permissions,
  grantees,
  roles,
  groups,
  client,
  onGive,
}: {
  label: string;
  permissions: Record<string, string[]>;
  grantees: readonly Grantee[];
  roles: Role[];
  groups: Named[];
  client: PermissionsClient;
  onGive: (grant: NewGrant, granteeName: string) => void;
}) {
  const t = useT();
  const formId = useId();
  const first = Object.values(permissions).flat()[0] ?? '';
  const [permission, setPermission] = useState(first);
  const [grantee, setGrantee] = useState<Grantee>(grantees[0] as Grantee);
  const firstTarget = (of: Grantee) =>
    of === 'role' ? String(roles[0]?.id ?? '') : of === 'group' ? String(groups[0]?.id ?? '') : '';
  const [target, setTarget] = useState(() => firstTarget(grantee));
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Named[]>([]);
  const ungrouped = Object.keys(permissions).length === 1;

  useEffect(() => {
    if (grantee !== 'user' || query.trim() === '') {
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
  }, [client, grantee, query]);

  const targets: Named[] = grantee === 'role' ? roles : grantee === 'group' ? groups : people;
  const needsTarget = grantee === 'role' || grantee === 'group' || grantee === 'user';
  return (
    <form
      className="people-inline"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        if (!permission || (needsTarget && !target)) return;
        const picked = targets.find((x) => String(x.id) === target);
        const grant: NewGrant = {
          permission,
          grantee,
          ...(grantee === 'role' ? { roleId: Number(target) } : {}),
          ...(grantee === 'group' ? { groupId: Number(target) } : {}),
          ...(grantee === 'user' ? { userId: Number(target) } : {}),
        };
        const name = t(`admin.permissions.grantee.${grantee}` as MessageId, {
          name: picked?.name ?? '',
        });
        onGive(grant, name);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${formId}-permission`} className="form-label">
          {t('admin.permissions.permission')}
        </label>
        <select
          id={`${formId}-permission`}
          value={permission}
          onChange={(event) => setPermission(event.target.value)}
        >
          {ungrouped
            ? Object.values(permissions)
                .flat()
                .map((p) => (
                  <option key={p} value={p}>
                    {permissionName(t, p)}
                  </option>
                ))
            : Object.entries(permissions).map(([group, list]) => (
                <optgroup key={group} label={t(`permissionGroup.${group}` as MessageId)}>
                  {list.map((p) => (
                    <option key={p} value={p}>
                      {permissionName(t, p)}
                    </option>
                  ))}
                </optgroup>
              ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${formId}-grantee`} className="form-label">
          {t('admin.permissions.grantee')}
        </label>
        <select
          id={`${formId}-grantee`}
          value={grantee}
          onChange={(event) => {
            const next = event.target.value as Grantee;
            setGrantee(next);
            setTarget(firstTarget(next));
          }}
        >
          {grantees.map((g) => (
            <option key={g} value={g}>
              {t(`admin.permissions.granteeKind.${g}` as MessageId)}
            </option>
          ))}
        </select>
      </div>
      {grantee === 'user' && (
        <div className="form-field">
          <label htmlFor={`${formId}-find`} className="form-label">
            {t('admin.permissions.findPerson')}
          </label>
          <input
            id={`${formId}-find`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {needsTarget && (
        <div className="form-field">
          <label htmlFor={`${formId}-target`} className="form-label">
            {t(
              grantee === 'role'
                ? 'admin.permissions.pickRole'
                : grantee === 'group'
                  ? 'admin.permissions.pickGroup'
                  : 'admin.permissions.pickPerson',
            )}
          </label>
          <select
            id={`${formId}-target`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
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
        {t('admin.permissions.give')}
      </button>
    </form>
  );
}
