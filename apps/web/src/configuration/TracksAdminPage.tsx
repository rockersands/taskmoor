import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type ConfigurationClient,
  configurationClient,
  type MappingNeeded,
  type Named,
  type RoleActors,
  type Track,
  type WorkflowMapSummary,
} from './client';

export interface TracksAdminPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ConfigurationClient;
}

/**
 * Tracks (CORE-001, CORE-025, WF-001), for administrators: add a track, rename it, choose its
 * workflow map, give roles to people and groups, archive and restore. A map change that would
 * leave tickets in statuses their new workflow lacks is refused here with the counts; the
 * mapping is given through the API (or a later version of this page).
 */
export function TracksAdminPage({ client = configurationClient }: TracksAdminPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; tracks: Track[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', tracks: await client.tracks() });
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
      if (!(error instanceof ApiError)) return t('admin.tracks.problem.other');
      const body = error.body as {
        error?: string;
        problem?: string;
        statuses?: MappingNeeded[];
      } | null;
      if (body?.error === 'status_mapping_required') {
        const needed = body.statuses ?? [];
        const tickets = needed.reduce((n, m) => n + m.ticketCount, 0);
        return t('admin.tracks.problem.mapping', { tickets });
      }
      if (body?.error === 'status_migration_running') return t('admin.tracks.problem.migrating');
      if (body?.error === 'key_taken' || body?.error === 'invalid_key') {
        return t('admin.tracks.problem.key');
      }
      if (error.status === 403) return t('admin.tracks.problem.forbidden');
      return t('admin.tracks.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <h1 id={titleId} className="page-title">
        {t('admin.tracks.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.tracks.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.tracks.intro')}</p>
          <AddTrack
            client={client}
            onAdded={(track) => {
              said(t('admin.tracks.added', { key: track.key }));
              setOpen(track.id);
            }}
            onProblem={(error) => setProblem(refusal(error))}
          />
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.tracks.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.tracks.failed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <ul className="people-list">
              {state.tracks.map((track) => (
                <li key={track.id} className="people-item people-group">
                  <div className="people-main">
                    <p className="people-name">
                      {track.key} · {track.name}
                      {track.archived && (
                        <span className="people-badge">{t('admin.tracks.archived')}</span>
                      )}
                    </p>
                    <p className="people-meta">
                      {t(track.mode === 'local' ? 'admin.tracks.local' : 'admin.tracks.shared')}
                    </p>
                  </div>
                  <div className="people-actions">
                    <button
                      type="button"
                      className="button-secondary people-action"
                      aria-expanded={open === track.id}
                      aria-label={t('admin.tracks.manageOf', { key: track.key })}
                      onClick={() => setOpen(open === track.id ? null : track.id)}
                    >
                      {t('admin.tracks.manage')}
                    </button>
                  </div>
                  {open === track.id && (
                    <TrackPanel
                      track={track}
                      client={client}
                      onChanged={said}
                      onProblem={(error) => setProblem(refusal(error))}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function AddTrack({
  client,
  onAdded,
  onProblem,
}: {
  client: ConfigurationClient;
  onAdded: (track: Track) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'shared' | 'local'>('shared');
  return (
    <form
      className="people-form"
      aria-label={t('admin.tracks.add')}
      onSubmit={(event) => {
        event.preventDefault();
        client
          .createTrack({ key: key.trim().toUpperCase(), name: name.trim(), mode })
          .then((track) => {
            onAdded(track);
            setKey('');
            setName('');
          }, onProblem);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-key`} className="form-label">
          {t('admin.tracks.key')}
        </label>
        <input
          id={`${id}-key`}
          type="text"
          required
          autoComplete="off"
          value={key}
          aria-describedby={`${id}-key-hint`}
          onChange={(event) => setKey(event.target.value)}
        />
        <p id={`${id}-key-hint`} className="form-hint">
          {t('admin.tracks.keyHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.tracks.name')}
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
        <label htmlFor={`${id}-mode`} className="form-label">
          {t('admin.tracks.mode')}
        </label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(event) => setMode(event.target.value as 'shared' | 'local')}
        >
          <option value="shared">{t('admin.tracks.shared')}</option>
          <option value="local">{t('admin.tracks.local')}</option>
        </select>
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.tracks.add')}
        </button>
      </div>
    </form>
  );
}

function TrackPanel({
  track,
  client,
  onChanged,
  onProblem,
}: {
  track: Track;
  client: ConfigurationClient;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(track.name);
  const [maps, setMaps] = useState<WorkflowMapSummary[]>([]);
  const [roles, setRoles] = useState<Named[]>([]);
  const [actors, setActors] = useState<RoleActors[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Named[]>([]);
  const [group, setGroup] = useState('');
  const [confirming, setConfirming] = useState(false);

  const loadActors = useCallback(async () => {
    try {
      setActors(await client.roleActors(track.id));
    } catch (error) {
      onProblem(error);
    }
  }, [client, track.id, onProblem]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per track
  useEffect(() => {
    void loadActors();
    void Promise.allSettled([client.workflowMaps(), client.roles(), client.groups()]).then(
      ([m, r, g]) => {
        if (m.status === 'fulfilled') setMaps(m.value);
        if (r.status === 'fulfilled') {
          setRoles(r.value);
          setRole(String(r.value[0]?.id ?? ''));
        }
        if (g.status === 'fulfilled') setGroups(g.value);
      },
    );
  }, [track.id]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.findPeople(q).then(
        (people) => live && setFound(people),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search]);

  const run = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      await loadActors();
      onChanged(message);
    } catch (error) {
      onProblem(error);
    }
  };
  const roleName = roles.find((r) => String(r.id) === role)?.name ?? '';

  return (
    <div className="people-panel">
      <form
        className="people-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () => client.updateTrack(track.id, { name: name.trim() }),
            t('admin.tracks.saved', { key: track.key }),
          );
        }}
      >
        <div className="form-field">
          <label htmlFor={`${id}-name`} className="form-label">
            {t('admin.tracks.name')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="button-secondary">
            {t('admin.tracks.rename')}
          </button>
        </div>
      </form>

      {track.mode === 'shared' && maps.length > 0 && (
        <div className="form-field">
          <label htmlFor={`${id}-map`} className="form-label">
            {t('admin.tracks.workflowMap')}
          </label>
          <select
            id={`${id}-map`}
            value={track.workflowMapId ?? maps.find((m) => m.isDefault)?.id ?? ''}
            onChange={(event) => {
              const picked = maps.find((m) => String(m.id) === event.target.value);
              if (!picked) return;
              void run(
                () =>
                  client.updateTrack(track.id, {
                    workflowMapId: picked.isDefault ? null : picked.id,
                  }),
                t('admin.tracks.mapSaved', { key: track.key, map: picked.name }),
              );
            }}
          >
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <h2 className="facts-title">{t('admin.tracks.members', { key: track.key })}</h2>
      {actors.length === 0 ? (
        <p className="page-note">{t('admin.tracks.noMembers')}</p>
      ) : (
        <ul className="people-sublist">
          {actors.flatMap((a) => [
            ...a.users.map((u) => (
              <li key={`r${a.roleId}u${u.id}`}>
                <span>{t('admin.tracks.inRole', { name: u.name, role: a.roleName })}</span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.tracks.removeActor', { name: u.name, role: a.roleName })}
                  onClick={() =>
                    void run(
                      () => client.setRoleActor(track.id, a.roleId, 'users', u.id, false),
                      t('admin.tracks.actorRemoved', { name: u.name, role: a.roleName }),
                    )
                  }
                >
                  {t('admin.tracks.remove')}
                </button>
              </li>
            )),
            ...a.groups.map((g) => (
              <li key={`r${a.roleId}g${g.id}`}>
                <span>{t('admin.tracks.groupInRole', { name: g.name, role: a.roleName })}</span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.tracks.removeActor', { name: g.name, role: a.roleName })}
                  onClick={() =>
                    void run(
                      () => client.setRoleActor(track.id, a.roleId, 'groups', g.id, false),
                      t('admin.tracks.actorRemoved', { name: g.name, role: a.roleName }),
                    )
                  }
                >
                  {t('admin.tracks.remove')}
                </button>
              </li>
            )),
          ])}
        </ul>
      )}
      {roles.length > 0 && (
        <>
          <div className="form-field">
            <label htmlFor={`${id}-role`} className="form-label">
              {t('admin.tracks.role')}
            </label>
            <select
              id={`${id}-role`}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-person`} className="form-label">
              {t('admin.tracks.addPerson')}
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
              {found.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <button
                    type="button"
                    className="button-secondary people-action"
                    aria-label={t('admin.tracks.addActor', { name: p.name, role: roleName })}
                    onClick={() =>
                      void run(
                        async () => {
                          await client.setRoleActor(track.id, Number(role), 'users', p.id, true);
                          setSearch('');
                        },
                        t('admin.tracks.actorAdded', { name: p.name, role: roleName }),
                      )
                    }
                  >
                    {t('admin.tracks.addShort')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {groups.length > 0 && (
            <form
              className="people-inline"
              onSubmit={(event) => {
                event.preventDefault();
                const picked = groups.find((g) => String(g.id) === group);
                if (!picked) return;
                void run(
                  async () => {
                    await client.setRoleActor(track.id, Number(role), 'groups', picked.id, true);
                    setGroup('');
                  },
                  t('admin.tracks.actorAdded', { name: picked.name, role: roleName }),
                );
              }}
            >
              <div className="form-field">
                <label htmlFor={`${id}-group`} className="form-label">
                  {t('admin.tracks.addGroup')}
                </label>
                <select
                  id={`${id}-group`}
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                >
                  <option value="">{t('admin.tracks.pickGroup')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-actions">
                <button type="submit" className="button-secondary" disabled={!group}>
                  {t('admin.tracks.addShort')}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="form-actions">
        {confirming ? (
          <>
            <span className="people-confirm">
              {t(track.archived ? 'admin.tracks.confirmRestore' : 'admin.tracks.confirmArchive', {
                key: track.key,
              })}
            </span>
            <button
              type="button"
              className="button-primary"
              onClick={() =>
                void client.archiveTrack(track.id, !track.archived).then(() => {
                  setConfirming(false);
                  onChanged(
                    t(track.archived ? 'admin.tracks.restored' : 'admin.tracks.archivedSaid', {
                      key: track.key,
                    }),
                  );
                }, onProblem)
              }
            >
              {t('admin.tracks.confirmYes')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setConfirming(false)}>
              {t('admin.tracks.confirmNo')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button-secondary"
            aria-label={t(track.archived ? 'admin.tracks.restoreOf' : 'admin.tracks.archiveOf', {
              key: track.key,
            })}
            onClick={() => setConfirming(true)}
          >
            {t(track.archived ? 'admin.tracks.restore' : 'admin.tracks.archive')}
          </button>
        )}
      </div>
    </div>
  );
}
