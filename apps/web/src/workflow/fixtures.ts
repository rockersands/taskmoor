import { ApiError } from '../api/client';
import type {
  Impact,
  Imported,
  ImportProblem,
  Lookups,
  VersionEntry,
  WorkflowSummary,
  WorkflowsClient,
  WorkflowView,
} from './client';
import type { Stage, Status, WorkflowDefinition } from './definition';

/** Synthetic statuses and workflows for stories and tests (M1-030); every name is made up. */
const STAGES: [string, Stage][] = [
  ['Open', 'new'],
  ['New', 'new'],
  ['Backlog', 'new'],
  ['Selected for Development', 'new'],
  ['Active', 'active'],
  ['In Review', 'active'],
  ['Under review', 'active'],
  ['Approved', 'closed'],
  ['Rejected', 'closed'],
  ['Cancelled', 'closed'],
  ['Draft', 'new'],
  ['Published', 'closed'],
  ['Closed', 'closed'],
];

export const STATUSES: Status[] = STAGES.map(([name, stage], i) => ({
  id: i + 1,
  name,
  description: '',
  stage,
  order: i + 1,
}));

export const S = Object.fromEntries(STATUSES.map((s) => [s.name, s.id])) as Record<string, number>;

/** The seeded default workflow: New, Active, In Review and Closed. */
export const DEFAULT_DEFINITION: WorkflowDefinition = {
  initialStatusId: S.New as number,
  statuses: [S.New, S.Active, S['In Review'], S.Closed].map((statusId) => ({
    statusId: statusId as number,
  })),
  transitions: [
    { id: 1, name: 'Start', from: [S.New as number], to: S.Active as number },
    { id: 2, name: 'Send to review', from: [S.Active as number], to: S['In Review'] as number },
    { id: 3, name: 'Back to active', from: [S['In Review'] as number], to: S.Active as number },
    {
      id: 4,
      name: 'Close',
      from: 'any',
      to: S.Closed as number,
      layout: ['close-reason'],
      checks: [{ type: 'field-required', field: 'close-reason' }],
    },
    {
      id: 5,
      name: 'Reopen',
      from: [S.Closed as number],
      to: S.New as number,
      effects: [{ type: 'clear-field', field: 'close-reason' }],
    },
  ],
};

/** A support workflow with rules of every kind and a status no transition reaches. */
export const SUPPORT_DEFINITION: WorkflowDefinition = {
  initialStatusId: S.Open as number,
  statuses: [S.Open, S.Active, S['Under review'], S.Approved, S.Rejected, S.Draft].map(
    (statusId) => ({ statusId: statusId as number }),
  ),
  transitions: [
    {
      id: 1,
      name: 'Take',
      from: [S.Open as number],
      to: S.Active as number,
      guards: {
        all: [
          { type: 'permission', permission: 'transition_tickets' },
          { any: [{ type: 'only-assignee' }, { type: 'user-in-role', role: '2' }] },
        ],
      },
      effects: [{ type: 'assign-to-current-user' }],
    },
    {
      id: 2,
      name: 'Ask for review',
      from: [S.Active as number],
      to: S['Under review'] as number,
      layout: ['assignee'],
      checks: [
        { type: 'field-required', field: 'assignee', message: 'Name a reviewer first.' },
        { type: 'regex', field: 'summary', pattern: '^[A-Z]' },
      ],
      properties: { 'review.queue': 'support' },
    },
    {
      id: 3,
      name: 'Approve',
      from: [S['Under review'] as number],
      to: S.Approved as number,
      guards: { type: 'separation-of-duties', transition: '2' },
      effects: [
        { type: 'update-system-field', field: 'close-reason', value: '1' },
        { type: 'webhook', url: 'https://hooks.example.test/approved' },
      ],
      event: 'support-approved',
    },
    { id: 4, name: 'Reject', from: 'any', to: S.Rejected as number },
    { id: 5, name: 'Rework', from: [S['Under review'] as number], to: S.Active as number },
  ],
  rules: { '1': [{ type: 'assign', to: 'current-user' }] },
};

const view = (
  id: number,
  name: string,
  definition: WorkflowDefinition,
  over: Partial<WorkflowView> = {},
): WorkflowView => ({
  id,
  name,
  description: '',
  isDefault: false,
  published: {
    version: 1,
    definition,
    createdAt: '2026-10-20T09:00:00.000Z',
    publishedAt: '2026-10-20T09:00:00.000Z',
  },
  draft: null,
  tracks: [],
  ...over,
});

export const DEFAULT_WORKFLOW = view(1, 'Default workflow', DEFAULT_DEFINITION, {
  description: 'New, Active, In Review, Closed',
  isDefault: true,
  tracks: [
    { id: 1, key: 'PAY', name: 'Payments' },
    { id: 2, key: 'WEB', name: 'Website' },
  ],
});

export const SUPPORT_WORKFLOW = view(2, 'Support', SUPPORT_DEFINITION, {
  description: 'Requests with a review step',
  published: {
    version: 2,
    definition: SUPPORT_DEFINITION,
    createdAt: '2026-10-21T09:00:00.000Z',
    publishedAt: '2026-10-21T10:00:00.000Z',
  },
  tracks: [{ id: 3, key: 'HELP', name: 'Help desk' }],
});

export const LOOKUPS: Lookups = {
  roles: [
    { id: 1, name: 'Administrators' },
    { id: 2, name: 'Agents' },
    { id: 3, name: 'Reviewers' },
  ],
  groups: [
    { id: 1, name: 'Support staff' },
    { id: 2, name: 'Change board' },
  ],
  permissions: ['browse_track', 'edit_tickets', 'transition_tickets', 'close_tickets'],
};

interface VersionRecord {
  definition: WorkflowDefinition;
  published: boolean;
  at: string;
}

interface Stored {
  view: WorkflowView;
  versions: Map<number, VersionRecord>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * An in-memory backend with the API's rules: drafts after the published version, impact of
 * dropped statuses, publish with a mapping, versions and restore, status CRUD and order.
 * `ticketsIn` says how many tickets sit in a status, for the publish mapping.
 */
export function fakeWorkflowsClient(
  options: {
    workflows?: WorkflowView[];
    statuses?: Status[];
    ticketsIn?: Record<number, number>;
    lookups?: Lookups;
    /** What an import reports as not found here (M1-127). */
    importProblems?: ImportProblem[];
  } = {},
): WorkflowsClient & { calls: string[] } {
  const calls: string[] = [];
  let statuses = clone(options.statuses ?? STATUSES);
  const ticketsIn = options.ticketsIn ?? {};
  const store = new Map<number, Stored>();
  for (const w of clone(options.workflows ?? [DEFAULT_WORKFLOW, SUPPORT_WORKFLOW])) {
    const versions = new Map<number, VersionRecord>();
    for (let v = 1; v <= w.published.version; v++) {
      versions.set(v, {
        definition: clone(w.published.definition),
        published: true,
        at: w.published.createdAt,
      });
    }
    if (w.draft) {
      versions.set(w.draft.version, {
        definition: clone(w.draft.definition),
        published: false,
        at: w.draft.createdAt,
      });
    }
    store.set(w.id, { view: w, versions });
  }
  let nextId = 100;
  const find = (id: number) => {
    const found = store.get(id);
    if (!found) throw new ApiError(404, { error: 'not_found' });
    return found;
  };
  const now = () => new Date('2026-10-28T12:00:00.000Z').toISOString();
  const summary = (s: Stored): WorkflowSummary => ({
    id: s.view.id,
    name: s.view.name,
    description: s.view.description,
    isDefault: s.view.isDefault,
    publishedVersion: s.view.published.version,
    draftVersion: s.view.draft?.version ?? null,
    trackCount: s.view.tracks.length,
  });
  const removed = (s: Stored) => {
    if (!s.view.draft) return [];
    const kept = new Set(s.view.draft.definition.statuses.map((x) => x.statusId));
    return s.view.published.definition.statuses
      .map((x) => x.statusId)
      .filter((id) => !kept.has(id))
      .sort((a, b) => a - b);
  };
  const saveDraft = (s: Stored, definition: WorkflowDefinition) => {
    const version = s.view.draft?.version ?? s.view.published.version + 1;
    s.versions.set(version, { definition: clone(definition), published: false, at: now() });
    s.view = {
      ...s.view,
      draft: { version, definition: clone(definition), createdAt: now(), publishedAt: null },
    };
    return clone(s.view);
  };

  /**
   * A workflow file's definition here: statuses by name, created when missing (only the
   * statuses are mapped; the real server maps everything the file names).
   */
  const fromFile = (document: unknown) => {
    const file = document as {
      format?: string;
      workflow: { name: string; description: string };
      statuses: { id: number; name: string; stage: Stage }[];
      definition: WorkflowDefinition;
    };
    if (file?.format !== 'taskmoor-workflow') {
      throw new ApiError(400, { error: 'not_a_workflow_document' });
    }
    const ids = new Map<number, number>();
    const report: Imported['report'] = {
      statuses: [],
      problems: clone(options.importProblems ?? []),
    };
    for (const entry of file.statuses) {
      let found = statuses.find((x) => x.name.toLowerCase() === entry.name.toLowerCase());
      const outcome = found ? 'matched' : 'created';
      if (!found) {
        found = {
          id: nextId++,
          name: entry.name,
          description: '',
          stage: entry.stage,
          order: statuses.length + 1,
        };
        statuses = [...statuses, found];
      }
      ids.set(entry.id, found.id);
      report.statuses.push({
        name: entry.name,
        stage: entry.stage,
        statusId: found.id,
        outcome,
        ...(found.stage !== entry.stage ? { stageHere: found.stage } : {}),
      });
    }
    const id = (x: number) => ids.get(x) ?? x;
    const d = file.definition;
    const definition: WorkflowDefinition = {
      ...d,
      initialStatusId: id(d.initialStatusId),
      statuses: d.statuses.map((x) => ({ ...x, statusId: id(x.statusId) })),
      transitions: d.transitions.map((x) => ({
        ...x,
        from: x.from === 'any' ? 'any' : x.from.map(id),
        to: id(x.to),
      })),
    };
    return { file, definition, report };
  };

  return {
    calls,
    exportHref: (id) => `/api/v1/admin/workflows/${id}/export`,
    importNew: async (document, name) => {
      calls.push('importNew');
      const { file, definition, report } = fromFile(document);
      const workflowName = name ?? file.workflow.name;
      if ([...store.values()].some((x) => x.view.name === workflowName)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const id = nextId++;
      const created = view(id, workflowName, clone(definition), {
        description: file.workflow.description,
        published: {
          version: 1,
          definition: clone(definition),
          createdAt: now(),
          publishedAt: now(),
        },
      });
      store.set(id, {
        view: created,
        versions: new Map([[1, { definition: clone(definition), published: true, at: now() }]]),
      });
      return { workflow: clone(created), report };
    },
    importDraft: async (id, document) => {
      calls.push(`importDraft ${id}`);
      const { definition, report } = fromFile(document);
      return { workflow: saveDraft(find(id), definition), report };
    },
    list: async () => {
      calls.push('list');
      return [...store.values()]
        .sort((a, b) => Number(b.view.isDefault) - Number(a.view.isDefault))
        .map(summary);
    },
    get: async (id) => {
      calls.push(`get ${id}`);
      return clone(find(id).view);
    },
    create: async (input) => {
      calls.push('create');
      if ([...store.values()].some((s) => s.view.name === input.name)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const id = nextId++;
      const created = view(id, input.name, clone(input.definition), {
        description: input.description ?? '',
        published: {
          version: 1,
          definition: clone(input.definition),
          createdAt: now(),
          publishedAt: now(),
        },
      });
      store.set(id, {
        view: created,
        versions: new Map([
          [1, { definition: clone(input.definition), published: true, at: now() }],
        ]),
      });
      return clone(created);
    },
    update: async (id, changes) => {
      calls.push(`update ${id}`);
      const s = find(id);
      s.view = { ...s.view, ...changes };
      return clone(s.view);
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      const s = find(id);
      if (s.view.isDefault) throw new ApiError(409, { error: 'default_workflow' });
      if (s.view.tracks.length > 0) {
        throw new ApiError(409, { error: 'workflow_in_use', tracks: s.view.tracks });
      }
      store.delete(id);
    },
    saveDraft: async (id, definition) => {
      calls.push(`saveDraft ${id}`);
      return saveDraft(find(id), definition);
    },
    discardDraft: async (id) => {
      calls.push(`discardDraft ${id}`);
      const s = find(id);
      if (!s.view.draft) throw new ApiError(409, { error: 'no_draft' });
      s.versions.delete(s.view.draft.version);
      s.view = { ...s.view, draft: null };
    },
    impact: async (id): Promise<Impact> => {
      calls.push(`impact ${id}`);
      const s = find(id);
      if (!s.view.draft) throw new ApiError(409, { error: 'no_draft' });
      return {
        removedStatuses: removed(s).map((statusId) => ({
          statusId,
          ticketCount: ticketsIn[statusId] ?? 0,
        })),
        tracks: clone(s.view.tracks),
      };
    },
    publish: async (id, statusMapping) => {
      calls.push(`publish ${id} ${JSON.stringify(statusMapping)}`);
      const s = find(id);
      const draft = s.view.draft;
      if (!draft) throw new ApiError(409, { error: 'no_draft' });
      const needed = removed(s).filter((statusId) => (ticketsIn[statusId] ?? 0) > 0);
      if (needed.some((statusId) => !(String(statusId) in statusMapping))) {
        throw new ApiError(409, {
          error: 'status_mapping_required',
          statuses: needed.map((statusId) => ({ statusId, ticketCount: ticketsIn[statusId] })),
        });
      }
      const entry = s.versions.get(draft.version);
      if (entry) entry.published = true;
      s.view = {
        ...s.view,
        published: { ...draft, publishedAt: now() },
        draft: null,
      };
      return clone(s.view);
    },
    versions: async (id): Promise<VersionEntry[]> => {
      calls.push(`versions ${id}`);
      const s = find(id);
      return [...s.versions.entries()]
        .sort(([a], [b]) => b - a)
        .map(([version, v]) => ({
          version,
          state:
            version === s.view.published.version
              ? 'published'
              : version === s.view.draft?.version
                ? 'draft'
                : 'earlier',
          createdAt: v.at,
          createdBy: { id: 1, name: 'Kalo Admin' },
          publishedAt: v.published ? v.at : null,
          publishedBy: v.published ? { id: 1, name: 'Kalo Admin' } : null,
        }));
    },
    restore: async (id, version) => {
      calls.push(`restore ${id} ${version}`);
      const s = find(id);
      if (version === s.view.draft?.version) throw new ApiError(409, { error: 'is_draft' });
      const source = s.versions.get(version);
      if (!source) throw new ApiError(404, { error: 'not_found' });
      return saveDraft(s, source.definition);
    },
    statuses: async () => {
      calls.push('statuses');
      return clone(statuses);
    },
    createStatus: async (input) => {
      calls.push('createStatus');
      if (statuses.some((s) => s.name === input.name)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const created: Status = {
        id: nextId++,
        name: input.name,
        description: input.description ?? '',
        stage: input.stage,
        order: statuses.length + 1,
      };
      statuses = [...statuses, created];
      return clone(created);
    },
    updateStatus: async (id, changes) => {
      calls.push(`updateStatus ${id}`);
      const current = statuses.find((s) => s.id === id);
      if (!current) throw new ApiError(404, { error: 'not_found' });
      if (changes.stage && changes.stage !== current.stage && (ticketsIn[id] ?? 0) > 0) {
        throw new ApiError(409, { error: 'status_in_use', ticketCount: ticketsIn[id] });
      }
      const updated = { ...current, ...changes };
      statuses = statuses.map((s) => (s.id === id ? updated : s));
      return clone(updated);
    },
    deleteStatus: async (id) => {
      calls.push(`deleteStatus ${id}`);
      const users = [...store.values()].filter((s) =>
        [s.view.published, s.view.draft].some((v) =>
          v?.definition.statuses.some((x) => x.statusId === id),
        ),
      );
      if (users.length > 0 || (ticketsIn[id] ?? 0) > 0) {
        throw new ApiError(409, {
          error: 'status_in_use',
          workflows: users.map((s) => ({ id: s.view.id, name: s.view.name })),
          ticketCount: ticketsIn[id] ?? 0,
        });
      }
      statuses = statuses.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i + 1 }));
    },
    orderStatuses: async (ids) => {
      calls.push(`orderStatuses ${ids.join(',')}`);
      statuses = ids.map((id, i) => ({
        ...(statuses.find((s) => s.id === id) as Status),
        order: i + 1,
      }));
      return clone(statuses);
    },
    lookups: async () => clone(options.lookups ?? LOOKUPS),
  };
}
