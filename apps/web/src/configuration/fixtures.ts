import { ApiError } from '../api/client';
import type {
  ConfigurationClient,
  MappingImpact,
  Named,
  RoleActors,
  StatusMigration,
  Track,
  TrackBoard,
  TypeStatusMapping,
  WorkflowMap,
} from './client';

export const WORKFLOWS: Named[] = [
  { id: 1, name: 'Default workflow' },
  { id: 2, name: 'Bug workflow' },
];
export const TYPES: Named[] = [
  { id: 5, name: 'Bug' },
  { id: 6, name: 'Task' },
  { id: 7, name: 'Story' },
];
export const ROLES: Named[] = [
  { id: 7, name: 'Administrators' },
  { id: 8, name: 'Members' },
  { id: 9, name: 'Viewers' },
];

/**
 * What a change of map does when tickets need a mapping (T-320): Bug tickets in two statuses the
 * Bug workflow lacks, which offers Open, Fixing and Closed.
 */
export const MAPPING_IMPACT: MappingImpact = {
  ticketCount: 15,
  lostStatuses: [
    {
      ticketType: { id: 5, name: 'Bug' },
      status: { id: 3, name: 'In review' },
      ticketCount: 12,
      workflow: { id: 2, name: 'Bug workflow' },
    },
    {
      ticketType: { id: 5, name: 'Bug' },
      status: { id: 4, name: 'Waiting' },
      ticketCount: 3,
      workflow: { id: 2, name: 'Bug workflow' },
    },
  ],
  targetWorkflows: [
    {
      id: 2,
      name: 'Bug workflow',
      statuses: [
        { id: 10, name: 'Open' },
        { id: 11, name: 'Fixing' },
        { id: 12, name: 'Closed' },
      ],
    },
  ],
};

const NO_IMPACT: MappingImpact = { ticketCount: 0, lostStatuses: [], targetWorkflows: [] };

export interface FakeConfigurationClient extends ConfigurationClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for stories and tests: it answers as the API would. */
export function fakeConfigurationClient(
  start: {
    /**
     * Tickets are in statuses the new workflows lack (WF-001): a preview names them, and a change
     * without a status mapping is refused.
     */
    refuseMapping?: boolean;
    /** The mapped tickets move in the background: the change answers before they have (T-320). */
    moving?: boolean;
    /** Tickets change after the preview, so the first change with a mapping is refused. */
    changedAfterPreview?: boolean;
    /** A sprint running in SHOP, so its sprints cannot be turned off (AGL-010). */
    runningSprint?: string;
  } = {},
): FakeConfigurationClient {
  let raced = false;
  /** The answer to a change of map: refused without a mapping, or the tickets it moves. */
  const remap = (typeStatusMapping?: TypeStatusMapping): StatusMigration | null => {
    if (!start.refuseMapping) return null;
    const refuse = () =>
      new ApiError(409, {
        error: 'status_mapping_required',
        statuses: MAPPING_IMPACT.lostStatuses.map((l) => ({
          ticketTypeId: l.ticketType.id,
          statusId: l.status.id,
          ticketCount: l.ticketCount,
          workflowId: l.workflow.id,
        })),
      });
    if (!typeStatusMapping) throw refuse();
    if (start.changedAfterPreview && !raced) {
      raced = true;
      throw refuse();
    }
    const total = MAPPING_IMPACT.ticketCount;
    return start.moving
      ? { id: 77, status: 'running', total, migrated: 0 }
      : { id: 77, status: 'done', total, migrated: total };
  };
  let tracks: Track[] = [
    {
      id: 3,
      key: 'SHOP',
      name: 'Shop',
      description: '',
      mode: 'shared',
      workflowMapId: null,
      archived: false,
      features: { sprints: true },
    },
    {
      id: 4,
      key: 'OPS',
      name: 'Operations',
      description: '',
      mode: 'local',
      workflowMapId: 21,
      archived: false,
      features: { sprints: false },
    },
    {
      id: 9,
      key: 'OLD',
      name: 'Old site',
      description: '',
      mode: 'shared',
      workflowMapId: null,
      archived: true,
    },
  ];
  /** Each track's board (ADR-116): SHOP's is Scrum, OPS's Kanban, and OLD has none. */
  const boards: Record<number, TrackBoard> = {
    3: { id: 30, kind: 'scrum' },
    4: { id: 40, kind: 'kanban' },
  };
  let maps: WorkflowMap[] = [
    {
      id: 20,
      name: 'Default workflow map',
      description: '',
      isDefault: true,
      defaultWorkflow: WORKFLOWS[0] as Named,
      entries: [],
      tracks: [{ id: 3, key: 'SHOP', name: 'Shop' }],
    },
    {
      id: 22,
      name: 'Bugs apart',
      description: '',
      isDefault: false,
      defaultWorkflow: WORKFLOWS[0] as Named,
      entries: [{ ticketType: TYPES[0] as Named, workflow: WORKFLOWS[1] as Named }],
      tracks: [],
    },
  ];
  const actors: Record<number, RoleActors[]> = {
    3: [
      {
        roleId: 7,
        roleName: 'Administrators',
        users: [{ id: 1, name: 'Ada Lovelace' }],
        groups: [],
      },
      {
        roleId: 8,
        roleName: 'Members',
        users: [{ id: 3, name: 'Grace Hopper' }],
        groups: [{ id: 11, name: 'Approvers' }],
      },
    ],
  };
  let next = 100;
  const calls: FakeConfigurationClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const named = (list: Named[], id: number) => list.find((x) => x.id === id) as Named;
  return {
    calls,
    tracks: async () => structuredClone(tracks),
    createTrack: async (body) => {
      log('createTrack', body);
      if (tracks.some((t) => t.key === body.key)) throw new ApiError(409, { error: 'key_taken' });
      const source = tracks.find((t) => t.id === body.copyFrom);
      // A Scrum template's track has sprints; Blank's are on until its first board, a Kanban one.
      const scrum = body.template === 'scrum';
      const made: Track = {
        id: ++next,
        key: body.key,
        name: body.name,
        mode: body.mode,
        description: '',
        workflowMapId: source?.workflowMapId ?? null,
        archived: false,
        features: { sprints: scrum || !body.template || body.template === 'blank' },
      };
      tracks = [...tracks, made];
      // Every template but Blank makes a board named after the track (M1-054).
      const board =
        body.template && body.template !== 'blank' ? { id: ++next, name: body.name } : undefined;
      if (board) boards[made.id] = { id: board.id, kind: scrum ? 'scrum' : 'kanban' };
      return structuredClone({ track: made, ...(board ? { board } : {}) });
    },
    updateTrack: async (id, change) => {
      log('updateTrack', id, change);
      const track = tracks.find((t) => t.id === id) as Track;
      if (change.features?.sprints === false && start.runningSprint && track.key === 'SHOP') {
        throw new ApiError(409, {
          error: 'sprint_running',
          sprintId: 41,
          sprintName: start.runningSprint,
        });
      }
      // Sprints go on only with a Scrum board, as the server says (ADR-116).
      const board = boards[id];
      if (change.features?.sprints === true && board?.kind !== 'scrum') {
        throw new ApiError(409, { error: 'not_scrum', boardId: board?.id ?? null });
      }
      const { features, ...rest } = change;
      Object.assign(track, rest, features ? { features: { ...track.features, ...features } } : {});
      return structuredClone(track);
    },
    archiveTrack: async (id, archive) => {
      log('archiveTrack', id, archive);
      Object.assign(tracks.find((t) => t.id === id) as Track, { archived: archive });
    },
    trackBoard: async (trackId) => structuredClone(boards[trackId] ?? null),
    roles: async () => structuredClone(ROLES),
    roleActors: async (trackId) => structuredClone(actors[trackId] ?? []),
    setRoleActor: async (trackId, roleId, kind, actorId, on) => {
      log('setRoleActor', trackId, roleId, kind, actorId, on);
      if (!actors[trackId]) actors[trackId] = [];
      const list = actors[trackId];
      let entry = list.find((a) => a.roleId === roleId);
      if (!entry) {
        entry = { roleId, roleName: named(ROLES, roleId).name, users: [], groups: [] };
        list.push(entry);
      }
      const people = [
        { id: 1, name: 'Ada Lovelace' },
        { id: 2, name: 'Bo Rivera' },
        { id: 3, name: 'Grace Hopper' },
      ];
      const groups = [
        { id: 11, name: 'Approvers' },
        { id: 12, name: 'Support' },
      ];
      const target = kind === 'users' ? entry.users : entry.groups;
      const actor = (kind === 'users' ? people : groups).find((a) => a.id === actorId) as Named;
      if (on && !target.some((a) => a.id === actorId)) target.push(actor);
      if (!on)
        target.splice(
          target.findIndex((a) => a.id === actorId),
          1,
        );
    },
    findPeople: async (query) =>
      [
        { id: 1, name: 'Ada Lovelace' },
        { id: 2, name: 'Bo Rivera' },
        { id: 3, name: 'Grace Hopper' },
      ].filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    groups: async () => [
      { id: 11, name: 'Approvers' },
      { id: 12, name: 'Support' },
    ],
    workflowMaps: async () =>
      maps.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isDefault: m.isDefault,
        defaultWorkflow: m.defaultWorkflow,
        entryCount: m.entries.length,
        trackCount: m.tracks.length,
      })),
    workflowMap: async (id) => structuredClone(maps.find((m) => m.id === id) as WorkflowMap),
    createWorkflowMap: async (body) => {
      log('createWorkflowMap', body);
      if (maps.some((m) => m.name === body.name)) throw new ApiError(409, { error: 'name_taken' });
      const made: WorkflowMap = {
        id: ++next,
        name: body.name,
        description: '',
        isDefault: false,
        defaultWorkflow: named(WORKFLOWS, body.defaultWorkflowId),
        entries: [],
        tracks: [],
      };
      maps = [...maps, made];
      return structuredClone(made);
    },
    updateWorkflowMap: async (id, change) => {
      log('updateWorkflowMap', id, change);
      const map = maps.find((m) => m.id === id) as WorkflowMap;
      const statusMigration = map.tracks.length > 0 ? remap(change.typeStatusMapping) : null;
      if (change.defaultWorkflowId)
        map.defaultWorkflow = named(WORKFLOWS, change.defaultWorkflowId);
      if (change.entries) {
        map.entries = change.entries.map((e) => ({
          ticketType: named(TYPES, e.ticketTypeId),
          workflow: named(WORKFLOWS, e.workflowId),
        }));
      }
      return structuredClone({ workflowMap: map, statusMigration });
    },
    deleteWorkflowMap: async (id) => {
      log('deleteWorkflowMap', id);
      maps = maps.filter((m) => m.id !== id);
    },
    workflows: async () => structuredClone(WORKFLOWS),
    ticketTypes: async () => structuredClone(TYPES),
    trackMapImpact: async (trackId, workflowMapId) => {
      log('trackMapImpact', trackId, workflowMapId);
      return structuredClone(start.refuseMapping ? MAPPING_IMPACT : NO_IMPACT);
    },
    workflowMapImpact: async (id, change) => {
      log('workflowMapImpact', id, change);
      const map = maps.find((m) => m.id === id) as WorkflowMap;
      return structuredClone(
        start.refuseMapping && map.tracks.length > 0 ? MAPPING_IMPACT : NO_IMPACT,
      );
    },
    switchWorkflowMap: async (trackId, workflowMapId, typeStatusMapping) => {
      log('switchWorkflowMap', trackId, workflowMapId, typeStatusMapping);
      const statusMigration = remap(typeStatusMapping);
      const track = tracks.find((t) => t.id === trackId) as Track;
      track.workflowMapId = workflowMapId;
      for (const m of maps) {
        m.tracks = m.tracks.filter((x) => x.id !== trackId);
        if (m.id === workflowMapId || (workflowMapId === null && m.isDefault)) {
          m.tracks.push({ id: track.id, key: track.key, name: track.name });
        }
      }
      return structuredClone({ track, statusMigration });
    },
    // A migration in the background has moved every ticket by the time it is read again.
    statusMigration: async (id) => {
      const total = MAPPING_IMPACT.ticketCount;
      return { id, status: 'done', total, migrated: total };
    },
  };
}
