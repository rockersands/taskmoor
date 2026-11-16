import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type GroupDetail,
  type GroupSummary,
  type PeopleClient,
  peopleClient,
  type ServiceAccountChoice,
  type User,
} from './client';

export interface GroupsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PeopleClient;
}

/**
 * Groups (IAM-008), for site administrators: make, rename and delete groups, add and remove
 * people and service accounts (IAM-007), and put groups inside groups (a member of an inner group
 * counts in every group around it; a loop is refused). Groups a directory keeps (M1-082) are
 * changed there, and say so.
 */
export function GroupsPage({ client = peopleClient }: GroupsPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; groups: GroupSummary[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const creating = useNewForm();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', groups: await client.groups('') });
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
      const code =
        error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
      if (code === 'name_taken') return t('admin.groups.problem.nameTaken');
      if (code === 'cycle' || code === 'nesting_cycle') return t('admin.groups.problem.cycle');
      if (code === 'directory_managed' || code === 'read_only') {
        return t('admin.groups.problem.directory');
      }
      return t('admin.groups.problem.other');
    },
    [t],
  );
  /** Says what was done and reads the list again; resolves once it is read. */
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    return load();
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.groups.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('settings.groupsHint'),
              about: t('admin.groups.intro'),
              actions: (
                <NewButton
                  label={t('admin.groups.new')}
                  open={creating.open}
                  onToggle={creating.toggle}
                  ref={creating.button}
                  data-tutorial="admin-group-new"
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.groups.forbidden')}</p>
      ) : (
        <>
          {creating.open && (
            <AddGroup
              client={client}
              onAdded={(name, id) => {
                creating.close();
                void said(t('admin.groups.added', { name }));
                setOpen(id);
              }}
              onCancel={creating.close}
              onProblem={(error) => setProblem(refusal(error))}
            />
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.groups.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.groups.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            (state.groups.length === 0 ? (
              <EmptyState title={t('admin.groups.none')}>{t('empty.groups.body')}</EmptyState>
            ) : (
              <ul className="people-list">
                {state.groups.map((g) => (
                  <li key={g.id} className="people-item people-group">
                    <div className="people-main">
                      <p className="people-name">{g.name}</p>
                      <p className="people-meta">
                        {t('admin.groups.counts', { members: g.memberCount, groups: g.childCount })}
                        {g.description ? ` · ${g.description}` : ''}
                      </p>
                    </div>
                    <div className="people-actions">
                      <button
                        type="button"
                        className="button-secondary people-action"
                        aria-expanded={open === g.id}
                        aria-label={t('admin.groups.manageOf', { name: g.name })}
                        onClick={() => setOpen(open === g.id ? null : g.id)}
                      >
                        {t('admin.groups.manage')}
                      </button>
                    </div>
                    {open === g.id && (
                      <GroupPanel
                        id={g.id}
                        client={client}
                        groups={state.groups}
                        onChanged={said}
                        onDeleted={(name) => {
                          // The group's row goes: the page's heading takes the focus.
                          setOpen(null);
                          void said(t('admin.groups.deleted', { name }));
                          title.current?.focus();
                        }}
                        onProblem={(error) => setProblem(refusal(error))}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </section>
  );
}

function AddGroup({
  client,
  onAdded,
  onCancel,
  onProblem,
}: {
  client: PeopleClient;
  onAdded: (name: string, id: number) => void;
  onCancel: () => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="glass-card people-card people-form"
      aria-label={t('admin.groups.add')}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client.createGroup({ name: wanted, description: description.trim() }).then((made) => {
          onAdded(wanted, made.id);
          setName('');
          setDescription('');
        }, onProblem);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.groups.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`} className="form-label">
          {t('admin.groups.description')}
        </label>
        <input
          id={`${id}-description`}
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.groups.add')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.groups.cancelNew')}
        </button>
      </div>
    </form>
  );
}

function GroupPanel({
  id,
  client,
  groups,
  onChanged,
  onDeleted,
  onProblem,
}: {
  id: number;
  client: PeopleClient;
  groups: GroupSummary[];
  /** Says what was done; resolves once the list is read again. */
  onChanged: (message: string) => Promise<void>;
  onDeleted: (name: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const formId = useId();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<User[]>([]);
  const [child, setChild] = useState('');
  const [accounts, setAccounts] = useState<ServiceAccountChoice[]>([]);
  const [account, setAccount] = useState('');

  const load = useCallback(async () => {
    try {
      setDetail(await client.group(id));
    } catch (error) {
      onProblem(error);
    }
  }, [client, id, onProblem]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per group
  useEffect(() => {
    void load();
    // Service accounts are not in the people list, so they have a choice of their own (T-320).
    client.serviceAccounts().then(setAccounts, () => setAccounts([]));
  }, [id]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.users(q, 'active').then(
        (r) => live && setFound(r.users.slice(0, 8)),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search]);

  /** True once the work is done and the group and the list are read again. */
  const run = async (work: () => Promise<void>, message: string) => {
    try {
      await work();
      await load();
      await onChanged(message);
      return true;
    } catch (error) {
      onProblem(error);
      return false;
    }
  };

  if (!detail) return <p className="page-note people-panel">{t('admin.groups.loading')}</p>;
  const name = detail.group.name;
  const memberIds = new Set(detail.members.map((m) => m.id));
  const childIds = new Set(detail.children.map((c) => c.id));
  const others = groups.filter((g) => g.id !== id && !childIds.has(g.id));
  // A directory's group takes its members from the directory, where no service account is.
  const addable = detail.directory ? [] : accounts.filter((a) => !memberIds.has(a.id));

  return (
    <div className="people-panel">
      <GroupDetails
        group={detail.group}
        directory={detail.directory?.name ?? null}
        onSave={(change) =>
          run(
            () => client.renameGroup(id, change),
            t('admin.groups.saved', { name: change.name ?? name }),
          )
        }
      />
      <h2 className="facts-title">{t('admin.groups.membersOf', { name })}</h2>
      {detail.members.length === 0 ? (
        <EmptyState compact title={t('admin.groups.noMembers')} />
      ) : (
        <ul className="people-sublist">
          {detail.members.map((m) => (
            <li key={m.id}>
              <span>
                {m.name} · {m.email}
                {m.kind === 'service' && (
                  <>
                    {' '}
                    <span className="people-badge">{t('admin.groups.serviceAccount')}</span>
                  </>
                )}
              </span>
              <button
                type="button"
                className="button-secondary people-action"
                aria-label={t('admin.groups.removeMember', { person: m.name, group: name })}
                onClick={() =>
                  void run(
                    () => client.removeMember(id, m.id),
                    t('admin.groups.memberRemoved', { person: m.name, group: name }),
                  )
                }
              >
                {t('admin.groups.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-field" data-tutorial="admin-group-member">
        <label htmlFor={`${formId}-search`} className="form-label">
          {t('admin.groups.addPerson')}
        </label>
        <input
          id={`${formId}-search`}
          type="search"
          value={search}
          aria-describedby={`${formId}-search-hint`}
          onChange={(event) => setSearch(event.target.value)}
        />
        <p id={`${formId}-search-hint`} className="form-hint">
          {t('admin.groups.addPersonHint')}
        </p>
      </div>
      {found.length > 0 && (
        <ul className="people-sublist">
          {found
            .filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <li key={u.id}>
                <span>
                  {u.name} · {u.email}
                </span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.groups.addMember', { person: u.name, group: name })}
                  onClick={() =>
                    void run(
                      async () => {
                        await client.addMember(id, u.id);
                        setSearch('');
                      },
                      t('admin.groups.memberAdded', { person: u.name, group: name }),
                    )
                  }
                >
                  {t('admin.groups.addShort')}
                </button>
              </li>
            ))}
        </ul>
      )}

      {addable.length > 0 && (
        <form
          className="people-inline"
          onSubmit={(event) => {
            event.preventDefault();
            const picked = addable.find((a) => String(a.id) === account);
            if (!picked) return;
            void run(
              async () => {
                await client.addMember(id, picked.id);
                setAccount('');
              },
              t('admin.groups.memberAdded', { person: picked.name, group: name }),
            );
          }}
        >
          <div className="form-field">
            <label htmlFor={`${formId}-account`} className="form-label">
              {t('admin.groups.addServiceAccount')}
            </label>
            <select
              id={`${formId}-account`}
              value={account}
              aria-describedby={`${formId}-account-hint`}
              onChange={(event) => setAccount(event.target.value)}
            >
              <option value="">{t('admin.groups.pickServiceAccount')}</option>
              {addable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <p id={`${formId}-account-hint`} className="form-hint">
              {t('admin.groups.addServiceAccountHint')}
            </p>
          </div>
          <div className="form-actions">
            <button type="submit" className="button-secondary" disabled={!account}>
              {t('admin.groups.addServiceAccountShort')}
            </button>
          </div>
        </form>
      )}

      <h2 className="facts-title">{t('admin.groups.childrenOf', { name })}</h2>
      {detail.children.length === 0 ? (
        <EmptyState compact title={t('admin.groups.noChildren')} />
      ) : (
        <ul className="people-sublist">
          {detail.children.map((c) => (
            <li key={c.id}>
              <span>{c.name}</span>
              <button
                type="button"
                className="button-secondary people-action"
                aria-label={t('admin.groups.removeChild', { child: c.name, group: name })}
                onClick={() =>
                  void run(
                    () => client.removeChild(id, c.id),
                    t('admin.groups.childRemoved', { child: c.name, group: name }),
                  )
                }
              >
                {t('admin.groups.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <form
          className="people-inline"
          onSubmit={(event) => {
            event.preventDefault();
            const picked = others.find((g) => String(g.id) === child);
            if (!picked) return;
            void run(
              async () => {
                await client.addChild(id, picked.id);
                setChild('');
              },
              t('admin.groups.childAdded', { child: picked.name, group: name }),
            );
          }}
        >
          <div className="form-field">
            <label htmlFor={`${formId}-child`} className="form-label">
              {t('admin.groups.addChild')}
            </label>
            <select
              id={`${formId}-child`}
              value={child}
              onChange={(event) => setChild(event.target.value)}
            >
              <option value="">{t('admin.groups.pickGroup')}</option>
              {others.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="button-secondary" disabled={!child}>
              {t('admin.groups.addShort')}
            </button>
          </div>
        </form>
      )}
      {detail.parents.length > 0 && (
        <p className="page-note">
          {t('admin.groups.inside', { groups: detail.parents.map((p) => p.name).join(', ') })}
        </p>
      )}

      <div className="form-actions">
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('admin.groups.delete')}
          name={t('admin.groups.deleteOf', { name })}
          outcome={t('admin.groups.confirmDelete', { name })}
          confirmLabel={t('admin.groups.deleteOf', { name })}
          onConfirm={async () => {
            try {
              await client.deleteGroup(id);
            } catch (error) {
              onProblem(error);
              throw error;
            }
            onDeleted(name);
          }}
        />
      </div>
    </div>
  );
}

/**
 * A group's name and description (IAM-008; T-320). A directory owns the name of a group it keeps,
 * so only its description changes here, and the form says where the name is changed.
 */
function GroupDetails({
  group,
  directory,
  onSave,
}: {
  group: { name: string; description: string };
  directory: string | null;
  /** True once saved and the lists are read again. */
  onSave: (change: { name?: string; description: string }) => Promise<boolean>;
}) {
  const t = useT();
  const id = useId();
  const save = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  /** Saved: Save takes the keyboard back once the page has drawn what was read again. */
  const [saved, setSaved] = useState(false);
  // The form stays, so the keyboard stays in it; it starts again from what was saved.
  useEffect(() => {
    setName(group.name);
    setDescription(group.description);
  }, [group.name, group.description]);
  // A new name can move the group's row in the list, which takes the keyboard from the form.
  useEffect(() => {
    if (!saved) return;
    save.current?.focus();
    setSaved(false);
  }, [saved]);
  return (
    <form
      className="people-inline"
      aria-label={t('admin.groups.editOf', { name: group.name })}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (directory === null && !wanted) return;
        void onSave({
          ...(directory === null ? { name: wanted } : {}),
          description: description.trim(),
        }).then((done) => done && setSaved(true));
      }}
    >
      {directory === null ? (
        <div className="form-field">
          <label htmlFor={`${id}-name`} className="form-label">
            {t('admin.groups.name')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      ) : (
        <p className="page-note">{t('admin.groups.directoryName', { directory })}</p>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-description`} className="form-label">
          {t('admin.groups.description')}
        </label>
        <input
          id={`${id}-description`}
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button ref={save} type="submit" className="button-secondary">
          {t('admin.groups.save')}
        </button>
      </div>
    </form>
  );
}
