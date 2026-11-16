import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { trackHref } from '../tracks/TrackLayout';
import {
  type ConfigurationClient,
  configurationClient,
  type MappingImpact,
  type Named,
  type RoleActors,
  type StatusMigration,
  type Track,
  type TrackBoard,
  type TypeStatusMapping,
  type WorkflowMapSummary,
} from './client';
import { NewTrackForm, trackRefusal } from './NewTrackForm';
import {
  MigrationProgress,
  movedText,
  needsMapping,
  StatusMappingPanel,
} from './StatusMappingPanel';

export interface TracksAdminPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ConfigurationClient;
}

/**
 * Tracks (CORE-001, CORE-025, WF-001), for administrators: add a track, rename it, choose its
 * workflow map, give roles to people and groups, archive and restore. A map change that would
 * leave tickets in statuses their new workflow lacks asks first where they go (T-320).
 */
export function TracksAdminPage({ client = configurationClient }: TracksAdminPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; tracks: Track[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const creating = useNewForm();
  const [message, setMessage] = useState('');
  /** The board the last template made, to open from here (M1-054). */
  const [board, setBoard] = useState<{ id: number; key: string } | null>(null);
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

  const refusal = useCallback((error: unknown) => trackRefusal(t, error), [t]);
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.tracks.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('settings.tracksHint'),
              about: t('admin.tracks.intro'),
              actions: (
                <NewButton
                  label={t('admin.tracks.new')}
                  open={creating.open}
                  onToggle={creating.toggle}
                  ref={creating.button}
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.tracks.forbidden')}</p>
      ) : (
        <>
          {creating.open && (
            <NewTrackForm
              card
              client={client}
              tracks={state.status === 'loaded' ? state.tracks : []}
              label={t('admin.tracks.add')}
              actions={
                <button type="button" className="button-secondary" onClick={creating.close}>
                  {t('admin.tracks.cancelNew')}
                </button>
              }
              onAdded={(track, board) => {
                said(
                  t(board ? 'admin.tracks.addedWithBoard' : 'admin.tracks.added', {
                    key: track.key,
                  }),
                );
                setBoard(board ? { id: board.id, key: track.key } : null);
                setOpen(track.id);
                creating.close();
              }}
              onProblem={(error) => setProblem(refusal(error))}
            />
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {board && (
            <p className="page-note">
              <a href={routeHref(`#/boards/${board.id}`)}>
                {t('admin.tracks.openBoard', { key: board.key })}
              </a>
            </p>
          )}
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
          {state.status === 'loaded' && state.tracks.length === 0 && (
            <EmptyState title={t('tracks.emptyTitle')}>{t('tracks.emptyMayCreate')}</EmptyState>
          )}
          {state.status === 'loaded' && state.tracks.length > 0 && (
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

/** The running sprint a refusal to turn sprints off names (AGL-010), or null for another error. */
function runningSprint(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'sprint_running') return null;
  const name = (error.body as { sprintName?: unknown } | null)?.sprintName;
  return typeof name === 'string' ? name : '';
}

/**
 * The board a refusal to turn sprints on names (ADR-116): Kanban, or none yet (null); undefined for
 * another error.
 */
function notScrum(error: unknown): TrackBoard | null | undefined {
  if (!(error instanceof ApiError) || error.code !== 'not_scrum') return undefined;
  const boardId = (error.body as { boardId?: unknown } | null)?.boardId;
  return typeof boardId === 'number' ? { id: boardId, kind: 'kanban' } : null;
}

/**
 * Whether the track has sprints (CORE-002). Only a Scrum board has them (ADR-116), so the box is
 * there only for a track whose board is Scrum; elsewhere the page says why, with the way to the
 * board's kind. Turning them off while a sprint runs is refused (AGL-010), as a board cannot go
 * Kanban then: the refusal names the sprint and leads to the track's board, where it can be
 * completed.
 */
function SprintsSetting({
  track,
  on: stored,
  client,
  onChanged,
  onProblem,
}: {
  track: Track;
  on: boolean;
  client: ConfigurationClient;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [on, setOn] = useState(stored);
  const [running, setRunning] = useState<string | null>(null);
  /** The track's board; 'unread' when it could not be read, and the server alone decides. */
  const [board, setBoard] = useState<TrackBoard | 'none' | 'reading' | 'unread'>('reading');
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    client.trackBoard(track.id).then(
      (read) => live && setBoard(read ?? 'none'),
      () => live && setBoard('unread'),
    );
    return () => {
      live = false;
    };
  }, [client, track.id]);
  const turn = async (next: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await client.updateTrack(track.id, { features: { sprints: next } });
      setOn(next);
      setRunning(null);
      onChanged(
        t(next ? 'admin.tracks.sprintsOnSaid' : 'admin.tracks.sprintsOffSaid', { key: track.key }),
      );
    } catch (error) {
      const sprint = runningSprint(error);
      const kanban = notScrum(error);
      // The board changed since it was read: say why there are no sprints instead.
      if (kanban !== undefined) setBoard(kanban ?? 'none');
      else if (sprint === null) onProblem(error);
      else setRunning(sprint);
    } finally {
      busy.current = false;
    }
  };
  if (board === 'reading') return null;
  if (board === 'none' || (board !== 'unread' && board.kind !== 'scrum')) {
    const none = board === 'none';
    return (
      <>
        <p className="form-hint">
          {t(none ? 'admin.tracks.sprintsNoBoard' : 'admin.tracks.sprintsKanban', {
            key: track.key,
          })}
        </p>
        <p className="page-note">
          <a
            href={routeHref(
              board === 'none' ? trackHref(track.key, 'board') : `#/boards/${board.id}/settings`,
            )}
          >
            {t(none ? 'admin.tracks.sprintsNoBoardLink' : 'admin.tracks.sprintsKanbanLink', {
              key: track.key,
            })}
          </a>
        </p>
      </>
    );
  }
  // The panel lays its parts out on a grid: these join it as they are.
  return (
    <>
      <div className="form-field form-field-inline">
        <input
          id={`${id}-sprints`}
          type="checkbox"
          checked={on}
          aria-describedby={`${id}-hint${running === null ? '' : ` ${id}-problem`}`}
          aria-invalid={running === null ? undefined : true}
          onChange={(event) => void turn(event.target.checked)}
        />
        <label htmlFor={`${id}-sprints`}>{t('admin.tracks.sprints', { key: track.key })}</label>
      </div>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.tracks.sprintsHint')}
      </p>
      {running !== null && (
        <>
          <p id={`${id}-problem`} role="alert" className="form-error">
            {t('admin.tracks.sprintRunning', { sprint: running, key: track.key })}
          </p>
          <p className="page-note">
            <a href={routeHref(trackHref(track.key, 'board'))}>
              {t('admin.tracks.sprintRunningLink', { key: track.key })}
            </a>
          </p>
        </>
      )}
    </>
  );
}

/**
 * A shared-mode track's workflow map (WF-001; T-320). Picking another map reads first what the
 * switch would do: with no ticket in a status the new workflows lack it switches at once;
 * otherwise the status mapping step asks where those tickets go, then switches and moves them,
 * showing their progress when some move in the background.
 */
function MapSwitch({
  track,
  maps,
  client,
  onChanged,
  onProblem,
}: {
  track: Track;
  maps: WorkflowMapSummary[];
  client: ConfigurationClient;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const current = track.workflowMapId ?? maps.find((m) => m.isDefault)?.id ?? '';
  const [mapId, setMapId] = useState(current);
  useEffect(() => setMapId(current), [current]);
  /** The map picked, while its preview is read or its mapping step is open. */
  const [picked, setPicked] = useState<WorkflowMapSummary | null>(null);
  const [mapping, setMapping] = useState<{ impact: MappingImpact; changed: boolean } | null>(null);
  const [migration, setMigration] = useState<StatusMigration | null>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const target = (map: WorkflowMapSummary) => (map.isDefault ? null : map.id);

  /** Closes the step, its focus back on the map's choice, and says why when it failed. */
  const stop = (error?: unknown) => {
    const open = mapping !== null;
    setPicked(null);
    setMapping(null);
    if (open) select.current?.focus();
    if (error !== undefined) onProblem(error);
  };
  const switchTo = async (map: WorkflowMapSummary, typeStatusMapping?: TypeStatusMapping) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const { statusMigration } = await client.switchWorkflowMap(
        track.id,
        target(map),
        typeStatusMapping,
      );
      setMapId(map.id);
      stop();
      setMigration(statusMigration && statusMigration.status !== 'done' ? statusMigration : null);
      onChanged(
        [
          t('admin.tracks.mapSaved', { key: track.key, map: map.name }),
          movedText(t, statusMigration),
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (error) {
      if (!needsMapping(error)) stop(error);
      else {
        // Tickets changed since the preview: read it again and ask again.
        await client.trackMapImpact(track.id, map.isDefault ? 'default' : map.id).then(
          (impact) => setMapping({ impact, changed: true }),
          (again) => stop(again),
        );
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const pick = async (map: WorkflowMapSummary) => {
    setPicked(map);
    setMapping(null);
    setMigration(null);
    try {
      const impact = await client.trackMapImpact(track.id, map.isDefault ? 'default' : map.id);
      if (impact.ticketCount === 0) await switchTo(map);
      else setMapping({ impact, changed: false });
    } catch (error) {
      stop(error);
    }
  };

  return (
    <>
      <div className="form-field" data-tutorial="track-workflow-map">
        <label htmlFor={`${id}-map`} className="form-label">
          {t('admin.tracks.workflowMap')}
        </label>
        <select
          ref={select}
          id={`${id}-map`}
          value={picked?.id ?? mapId}
          onChange={(event) => {
            const map = maps.find((m) => String(m.id) === event.target.value);
            if (!map) return;
            if (map.id === mapId) stop();
            else void pick(map);
          }}
        >
          {maps.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {picked && mapping && (
        <StatusMappingPanel
          impact={mapping.impact}
          title={t('admin.tracks.mappingTitle', { key: track.key, map: picked.name })}
          confirmLabel={t('admin.tracks.mappingConfirm')}
          changed={mapping.changed}
          busy={saving}
          onConfirm={(typeStatusMapping) => void switchTo(picked, typeStatusMapping)}
          onCancel={() => stop()}
        />
      )}
      {migration && <MigrationProgress migration={migration} read={client.statusMigration} />}
    </>
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
        <MapSwitch
          track={track}
          maps={maps}
          client={client}
          onChanged={onChanged}
          onProblem={onProblem}
        />
      )}

      {!track.archived && track.features?.sprints !== undefined && (
        <SprintsSetting
          track={track}
          on={track.features.sprints}
          client={client}
          onChanged={onChanged}
          onProblem={onProblem}
        />
      )}

      {!track.archived && (
        <p className="page-note">
          <a href={routeHref(`#/admin/track-sets?track=${track.id}`)}>
            {t('admin.tracks.setsLink', { key: track.key })}
          </a>
        </p>
      )}

      <h2 className="facts-title">{t('admin.tracks.members', { key: track.key })}</h2>
      <p className="page-note">
        <a href={routeHref(`#/manage/tracks/${track.id}`)}>
          {t('admin.tracks.people', { key: track.key })}
        </a>
      </p>
      {actors.length === 0 ? (
        <EmptyState compact title={t('admin.tracks.noMembers')} />
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
              data-tutorial="track-role-group"
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
