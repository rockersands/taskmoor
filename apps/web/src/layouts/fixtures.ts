import { ApiError } from '../api/client';
import type { RunTrack, ScopeTrack } from '../sets/trackScope';
import type {
  LayoutSet,
  LayoutsClient,
  Owned,
  Preview,
  PreviewField,
  PreviewRequest,
} from './client';
import { type LayoutDefinition, type LayoutEntry, SYSTEM_FIELD_KEYS } from './model';

/** Ticket types: Feature, Bug and Chore are shared; Runbook belongs to the OPS track. */
export const LAYOUT_TYPES: Owned[] = [
  { id: 1, name: 'Feature', trackId: null },
  { id: 2, name: 'Bug', trackId: null },
  { id: 3, name: 'Chore', trackId: null },
  { id: 9, name: 'Runbook', trackId: 4 },
];

export const LAYOUT_FIELDS: Owned[] = [
  { id: 12, name: 'Severity', trackId: null },
  { id: 13, name: 'Customer', trackId: null },
  { id: 40, name: 'Ops notes', trackId: 4 },
  { id: 41, name: 'Lab notes', trackId: 6 },
];

/**
 * The tracks: SHOP is in shared mode; OPS and LAB are local-mode tracks with their own type sets,
 * OPS's offering Feature, Bug and its own Runbook (not Chore).
 */
export const LAYOUT_TRACKS: ScopeTrack[] = [
  {
    id: 3,
    key: 'SHOP',
    name: 'Shop',
    mode: 'shared',
    archived: false,
    typeSetId: 1,
    fieldRuleSetId: null,
    layoutSetId: null,
  },
  {
    id: 4,
    key: 'OPS',
    name: 'Operations',
    mode: 'local',
    archived: false,
    typeSetId: 30,
    fieldRuleSetId: null,
    layoutSetId: 5,
  },
  {
    id: 6,
    key: 'LAB',
    name: 'Lab',
    mode: 'local',
    archived: false,
    typeSetId: 31,
    fieldRuleSetId: null,
    layoutSetId: 7,
  },
];
const TYPE_SETS: Record<number, number[]> = { 1: [1, 2, 3], 30: [1, 2, 9], 31: [1, 3] };

/** The tracks the person of the track administrator's stories runs: OPS and SHOP, not LAB. */
export const RUN_TRACKS: RunTrack[] = LAYOUT_TRACKS.filter((t) => t.key !== 'LAB').map(
  ({ id, key, name, mode }) => ({ id, key, name, mode }),
);

const DETAILS: LayoutDefinition = {
  tabs: [
    {
      name: 'Details',
      sections: [
        { kind: 'main', hideWhenEmpty: false, fields: ['summary', 'description', 'priority'] },
        { kind: 'context', hideWhenEmpty: true, fields: ['assignee', 'dueDate'] },
      ],
    },
  ],
  others: 'show',
};

/** The default set lays out every type's create form; SHOP uses it. */
export function layoutSetsFixture(): LayoutSet[] {
  return [
    {
      id: 1,
      name: 'Default layouts',
      description: '',
      trackId: null,
      isDefault: true,
      usedBy: [{ id: 3, key: 'SHOP', name: 'Shop' }],
      layouts: [{ ticketTypeId: null, operation: 'create', definition: DETAILS }],
    },
    {
      id: 2,
      name: 'Support layouts',
      description: '',
      trackId: null,
      isDefault: false,
      usedBy: [],
      layouts: [],
    },
    {
      id: 5,
      name: 'Ops layouts',
      description: '',
      trackId: 4,
      isDefault: false,
      usedBy: [{ id: 4, key: 'OPS', name: 'Operations' }],
      layouts: [],
    },
    {
      id: 7,
      name: 'Lab layouts',
      description: '',
      trackId: 6,
      isDefault: false,
      usedBy: [{ id: 6, key: 'LAB', name: 'Lab' }],
      layouts: [],
    },
  ];
}

/**
 * The field rules the fake server applies: Environment is hidden everywhere, the due date is
 * required on Bugs, and SHOP also hides Customer.
 */
function ruleOf(key: string, typeId: number, trackId: number | null) {
  if (key === 'summary') return { required: true, hidden: false };
  if (key === 'environment') return { required: false, hidden: true };
  if (key === 'cf[13]' && trackId === 3) return { required: false, hidden: true };
  if (key === 'dueDate' && typeId === 2) return { required: true, hidden: false };
  return { required: false, hidden: false };
}

/** The checks a save makes, enough of them for the page's tests: each field once, known fields. */
function problemOf(layouts: readonly LayoutEntry[], ownerTrackId: number | null): string | null {
  for (const [i, l] of layouts.entries()) {
    // The schema first, as the server says it: the place in the request, then English words.
    for (const [j, tab] of l.definition.tabs.entries()) {
      if (!tab.name.trim()) {
        return `layouts.${i}.definition.tabs.${j}.name: Too small: expected string to have >=1 characters`;
      }
    }
    const all = l.definition.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields));
    if (new Set(all).size !== all.length) return `layouts.${i}.definition: each field once`;
    for (const key of all) {
      const id = /^cf\[(\d+)\]$/.exec(key)?.[1];
      const field = id ? LAYOUT_FIELDS.find((f) => f.id === Number(id)) : null;
      if (id && !field) return `unknown field ${key}`;
      if (field && field.trackId !== null && field.trackId !== ownerTrackId) {
        return `${key} belongs to another track`;
      }
    }
  }
  return null;
}

/** The form a draft gives, resolved as the server resolves it (`fields/layouts.ts`). */
export function fakePreview(set: LayoutSet, body: PreviewRequest): Preview {
  const problem = problemOf(body.layouts, set.trackId);
  if (problem) throw new ApiError(400, { error: 'invalid_request', detail: problem });
  const own = body.layouts.find(
    (l) => l.ticketTypeId === body.ticketTypeId && l.operation === body.operation,
  );
  const every = body.layouts.find((l) => l.ticketTypeId === null && l.operation === body.operation);
  const chosen = own ?? every ?? null;
  const applicable = [
    ...SYSTEM_FIELD_KEYS,
    ...LAYOUT_FIELDS.filter((f) => f.trackId === null || f.trackId === body.trackId).map(
      (f) => `cf[${f.id}]`,
    ),
  ] as string[];
  const reasonOf = (key: string) => {
    if (!applicable.includes(key)) return 'not_applicable' as const;
    if (ruleOf(key, body.ticketTypeId, body.trackId).hidden) return 'hidden' as const;
    return null;
  };
  const field = (key: string): PreviewField | null =>
    reasonOf(key)
      ? null
      : {
          key,
          required: ruleOf(key, body.ticketTypeId, body.trackId).required,
          description: key === 'cf[12]' ? 'How bad it is' : null,
        };
  const definition = chosen?.definition ?? { tabs: [], others: 'show' as const };
  const placed = new Set(definition.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields)));
  const tabs: Preview['layout']['tabs'] = definition.tabs.map((tab) => ({
    name: tab.name,
    sections: tab.sections.map((s) => ({
      kind: s.kind,
      hideWhenEmpty: s.hideWhenEmpty,
      fields: s.fields.map(field).filter((f): f is PreviewField => f !== null),
    })),
  }));
  const rest = applicable
    .filter((key) => !placed.has(key))
    .map(field)
    .filter((f): f is PreviewField => f !== null)
    .filter((f) => definition.others === 'show' || f.required);
  if (rest.length > 0) {
    tabs.push({ name: null, sections: [{ kind: 'main', hideWhenEmpty: false, fields: rest }] });
  }
  const leftOut = [...placed].flatMap((key) => {
    const reason = reasonOf(key);
    return reason ? [{ field: key, reason }] : [];
  });
  return {
    source: own ? 'type' : every ? 'every_type' : 'none',
    layout: { operation: body.operation, tabs },
    leftOut,
    customFields: LAYOUT_FIELDS.map((f) => ({ id: f.id, name: f.name })),
  };
}

export interface FakeLayoutsClient extends LayoutsClient {
  sets: LayoutSet[];
  saved: { id: number; change: { name?: string; layouts?: LayoutEntry[] } }[];
  previews: PreviewRequest[];
  /** What was made, with the track that owns it. */
  made: { name: string; trackId?: number }[];
  /** Each track and the set it was made to use. */
  assigned: { trackId: number; setId: number }[];
  tracks: ScopeTrack[];
}

/** An in-memory backend for the layout editor's stories and tests. */
export function fakeLayoutsClient(
  sets: LayoutSet[] = layoutSetsFixture(),
  options: { failPreview?: boolean; runs?: RunTrack[] } = {},
): FakeLayoutsClient {
  const find = (id: number) => {
    const set = client.sets.find((s) => s.id === id);
    if (!set) throw new ApiError(404, { error: 'not_found' });
    return set;
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const client: FakeLayoutsClient = {
    sets,
    saved: [],
    previews: [],
    made: [],
    assigned: [],
    tracks: structuredClone(LAYOUT_TRACKS),
    ticketTypes: async (trackId) =>
      LAYOUT_TYPES.filter((t) => t.trackId === null || t.trackId === trackId),
    typeSetTypes: async (typeSetId) =>
      LAYOUT_TYPES.filter((t) => (TYPE_SETS[typeSetId] ?? []).includes(t.id)),
    customFields: async (trackId) =>
      LAYOUT_FIELDS.filter((f) => trackId === null || f.trackId === null || f.trackId === trackId),
    layoutSets: async (trackId) =>
      client.sets
        .filter((s) => trackId === null || s.trackId === null || s.trackId === trackId)
        .map(({ id, name, description, trackId: owner, isDefault }) => ({
          id,
          name,
          description,
          trackId: owner,
          isDefault,
        })),
    layoutSet: async (id) => copy(find(id)),
    createLayoutSet: async ({ name, trackId }) => {
      client.made.push({ name, ...(trackId === undefined ? {} : { trackId }) });
      if (client.sets.some((s) => s.name === name)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const made: LayoutSet = {
        id: Math.max(0, ...client.sets.map((s) => s.id)) + 1,
        name,
        description: '',
        trackId: trackId ?? null,
        isDefault: false,
        usedBy: [],
        layouts: [],
      };
      client.sets = [...client.sets, made];
      return copy(made);
    },
    updateLayoutSet: async (id, change) => {
      const set = find(id);
      if (change.layouts) {
        const problem = problemOf(change.layouts, set.trackId);
        if (problem) throw new ApiError(400, { error: 'invalid_request', detail: problem });
      }
      client.saved.push({ id, change: copy(change) });
      const next = {
        ...set,
        ...(change.name ? { name: change.name } : {}),
        ...(change.layouts ? { layouts: copy(change.layouts) } : {}),
      };
      client.sets = client.sets.map((s) => (s.id === id ? next : s));
      return copy(next);
    },
    deleteLayoutSet: async (id) => {
      const set = find(id);
      if (set.isDefault) throw new ApiError(409, { error: 'default' });
      if (set.usedBy.length > 0) {
        throw new ApiError(409, { error: 'in_use', trackCount: set.usedBy.length });
      }
      client.sets = client.sets.filter((s) => s.id !== id);
    },
    preview: async (id, body) => {
      client.previews.push(copy(body));
      if (options.failPreview) throw new ApiError(500, { error: 'internal' });
      return fakePreview(find(id), body);
    },
    assignLayoutSet: async (trackId, setId) => {
      const set = find(setId);
      const track = client.tracks.find((t) => t.id === trackId);
      if (!track) throw new ApiError(404, { error: 'not_found' });
      if (set.trackId !== null && set.trackId !== trackId) {
        throw new ApiError(400, { error: 'invalid_request', detail: 'layoutSetId' });
      }
      client.assigned.push({ trackId, setId });
      track.layoutSetId = setId;
      const named = { id: track.id, key: track.key, name: track.name };
      client.sets = client.sets.map((s) => ({
        ...s,
        usedBy:
          s.id === setId
            ? [...s.usedBy.filter((u) => u.id !== trackId), named]
            : s.usedBy.filter((u) => u.id !== trackId),
      }));
    },
    track: async (id) => {
      const track = client.tracks.find((t) => t.id === id);
      if (!track) throw new ApiError(404, { error: 'not_found' });
      return copy(track);
    },
    managedTracks: async () => copy(options.runs ?? RUN_TRACKS),
  };
  return client;
}
