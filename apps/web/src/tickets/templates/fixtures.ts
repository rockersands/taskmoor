import { ApiError } from '../../api/client';
import type {
  AppliedTemplate,
  FieldRule,
  FieldValueOption,
  Named,
  PickerClient,
  SavedTemplate,
  TemplateBody,
  TemplateClient,
  TemplateOptions,
} from './client';

/** Ticket templates for stories and tests: made up, one of a track and one for every track. */
const base = (id: number, name: string): SavedTemplate => ({
  id,
  name,
  purpose: '',
  track: null,
  ticketTypeIds: [],
  summary: '',
  description: null,
  defaults: {},
  assignee: null,
  subtickets: [],
  version: 1,
  mayEdit: true,
});

export const RELEASE_TEMPLATE: SavedTemplate = {
  ...base(11, 'Release checklist'),
  purpose: 'Everything a release needs',
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  ticketTypeIds: [3],
  summary: 'Release {track} {date}',
  defaults: {
    priorityId: 1,
    labels: ['release'],
    assigneeId: 21,
    dueInDays: 7,
    fields: { '7': 70, '99': 'kept' },
  },
  assignee: { id: 21, name: 'Sam Rivera' },
  subtickets: [{ summary: 'Write the notes' }, { summary: 'Announce it' }],
};

export const INCIDENT_TEMPLATE: SavedTemplate = {
  ...base(12, 'Incident report'),
  purpose: 'For anything that broke',
  summary: 'Incident on {date}',
  defaults: { labels: ['incident'] },
};

export const TEMPLATE_OPTIONS: TemplateOptions = {
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  types: [
    { id: 3, name: 'Bug', level: { rank: 0 } },
    { id: 4, name: 'Chore', level: { rank: 0 } },
    { id: 5, name: 'Subticket', level: { rank: -1 } },
    { id: 6, name: 'Checklist item', level: { rank: -1 } },
  ],
  priorities: [
    { id: 1, name: 'High' },
    { id: 2, name: 'Low' },
  ],
  areas: [
    { id: 31, name: 'Checkout' },
    { id: 32, name: 'Old storefront', archived: true },
    { id: 33, name: 'Payments' },
  ],
  releases: [
    { id: 41, name: '1.0' },
    { id: 42, name: '0.9', archived: true },
    { id: 43, name: '1.1' },
  ],
  fields: [
    { id: 7, name: 'Severity', type: 'select', multiple: false },
    { id: 9, name: 'Customer', type: 'text', multiple: false },
    { id: 99, name: 'Secret formula', type: 'formula', multiple: false },
    { id: 12, name: 'Fixed in', type: 'release', multiple: true },
    { id: 13, name: 'Owning area', type: 'area', multiple: false },
    { id: 14, name: 'Reviewer', type: 'user', multiple: false },
    { id: 15, name: 'Owners', type: 'group', multiple: true },
    { id: 16, name: 'Squad', type: 'team', multiple: false },
  ],
};

/**
 * A track template whose custom release and area fields name the track's own, an archived one
 * and one of another track (77), as only the API sets them (T-291); its Target release is an
 * archived one it already held.
 */
export const HOTFIX_TEMPLATE: SavedTemplate = {
  ...base(13, 'Hotfix'),
  purpose: 'A fix shipped on its own',
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  defaults: {
    targetReleaseIds: [42],
    fields: { '12': [41, 42, 77], '13': 31, '99': 'kept' },
  },
};

/**
 * A track template whose custom person, group and team fields were set through the API (T-299):
 * a group the reader may not see or that is gone (52) among them.
 */
export const PEOPLE_TEMPLATE: SavedTemplate = {
  ...base(14, 'Review'),
  purpose: 'A change someone reviews',
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  defaults: { fields: { '14': 21, '15': [51, 52], '16': 61 } },
};

/** The names the API gives for each template's people, groups and teams, by template id. */
export const TEMPLATE_NAMES: Record<number, Record<string, Named[]>> = {
  14: {
    'fields.14': [{ id: 21, name: 'Sam Rivera' }],
    'fields.15': [{ id: 51, name: 'Support' }],
    'fields.16': [{ id: 61, name: 'Checkout squad' }],
  },
};

export const EVERY_TRACK_OPTIONS: TemplateOptions = {
  ...TEMPLATE_OPTIONS,
  track: null,
  areas: [],
  releases: [],
};

export interface FakeTemplateClient extends TemplateClient {
  saved: { id: number | null; body: TemplateBody }[];
  removed: number[];
  /** The searches asked for, as `source:args:typed` (T-350). */
  searched: string[];
}

/** People to find: those of the track Shop, and one only the site's search finds (T-350). */
export const TRACK_PEOPLE: Named[] = [
  { id: 21, name: 'Sam Rivera' },
  { id: 22, name: 'Ana Ortiz' },
  { id: 23, name: 'Lee Park' },
];
const SITE_PEOPLE: Named[] = [...TRACK_PEOPLE, { id: 24, name: 'Kim Alvarez' }];
/** Whom a restricted person field allows, by ticket type: Bugs and Chores share Ana (T-350). */
const ALLOWED_BY_TYPE: Record<number, number[]> = { 3: [21, 22], 4: [22, 23] };
const GROUPS: Named[] = [
  { id: 51, name: 'Support' },
  { id: 53, name: 'Design' },
  { id: 54, name: 'Sales' },
];
const TEAMS: Named[] = [
  { id: 61, name: 'Checkout squad' },
  { id: 62, name: 'Search squad' },
];

/** A person field's contexts: one for everything that allows anyone. */
const ANYONE: FieldRule[] = [{ id: 140, trackIds: null, ticketTypeIds: null, restricted: false }];

/**
 * A person field that allows only some people for each type in Shop (T-350): a context for Bugs
 * and one for Chores, each limited to a group, and one for everything else that allows anyone.
 */
export const RESTRICTED_RULES: FieldRule[] = [
  { id: 141, trackIds: [1], ticketTypeIds: [3], restricted: true },
  { id: 142, trackIds: [1], ticketTypeIds: [4], restricted: true },
  { id: 143, trackIds: null, ticketTypeIds: null, restricted: false },
];

const matching = (list: Named[], typed: string) =>
  list.filter((n) => n.name.toLowerCase().includes(typed.toLowerCase()));

const OPTIONS: Record<string, FieldValueOption[]> = {
  '7': [
    { id: 70, value: 'Blocker' },
    { id: 71, value: 'Minor' },
  ],
};

/**
 * An in-memory backend; a second template with a name in use is refused, as the API does.
 * `refuse` makes every save answer with these problems by body path, as the API's
 * `invalid_fields` does (T-291).
 */
export function fakeTemplateClient(
  start: SavedTemplate[] = [RELEASE_TEMPLATE, INCIDENT_TEMPLATE],
  {
    mayCreate = true,
    options = TEMPLATE_OPTIONS,
    refuse = null as Record<string, string> | null,
    rules = {} as Record<string, FieldRule[]>,
  } = {},
): FakeTemplateClient {
  const searched: string[] = [];
  let rows = structuredClone(start);
  let next = 100;
  const saved: FakeTemplateClient['saved'] = [];
  const removed: number[] = [];
  const refuseTaken = (body: TemplateBody, id: number | null) => {
    if (refuse) throw new ApiError(400, { error: 'invalid_fields', fields: refuse });
    if (rows.some((r) => r.name === body.name && r.id !== id)) {
      throw new ApiError(400, { error: 'invalid_fields', fields: { name: 'taken' } });
    }
  };
  return {
    saved,
    removed,
    searched,
    list: async () => ({ templates: structuredClone(rows), mayCreate }),
    options: async () => options,
    fieldOptions: async (fieldId) => OPTIONS[String(fieldId)] ?? [],
    people: async (track, query) => {
      searched.push(`people:${track}:${query}`);
      return matching(TRACK_PEOPLE, query);
    },
    sitePeople: async (query) => {
      searched.push(`sitePeople:${query}`);
      return matching(SITE_PEOPLE, query);
    },
    fieldPeople: async (fieldId, track, ticketTypeId, query) => {
      searched.push(`fieldPeople:${fieldId}:${track}:${ticketTypeId}:${query}`);
      const allowed = ALLOWED_BY_TYPE[ticketTypeId] ?? [];
      return matching(TRACK_PEOPLE, query).filter((p) => allowed.includes(p.id));
    },
    groups: async (fieldId, query) => {
      searched.push(`groups:${fieldId}:${query}`);
      return matching(GROUPS, query);
    },
    teams: async (query) => {
      searched.push(`teams:${query}`);
      return matching(TEAMS, query);
    },
    fieldRules: async (fieldId) => structuredClone(rules[String(fieldId)] ?? ANYONE),
    names: async (id) => structuredClone(TEMPLATE_NAMES[id] ?? {}),
    create: async (body) => {
      refuseTaken(body, null);
      saved.push({ id: null, body });
      const row: SavedTemplate = {
        ...base(next++, body.name),
        ...body,
        track: options.track,
        assignee: null,
      };
      rows = [...rows, row];
      return row;
    },
    update: async (id, body) => {
      refuseTaken(body, id);
      saved.push({ id, body });
      const before = rows.find((r) => r.id === id) as SavedTemplate;
      const row: SavedTemplate = { ...before, ...body, track: before.track };
      rows = rows.map((r) => (r.id === id ? row : r));
      return row;
    },
    remove: async (id) => {
      removed.push(id);
      rows = rows.filter((r) => r.id !== id);
    },
  };
}

export interface FakePickerClient extends PickerClient {
  applied: { id: number; body: Record<string, unknown> }[];
}

/** The create form's side of the API. */
export function fakePickerClient(
  templates: SavedTemplate[] = [RELEASE_TEMPLATE],
  start: Record<string, unknown> = {
    summary: 'Release SHOP 2026-11-03',
    priorityId: 1,
    assigneeId: 21,
    dueDate: '2026-11-10',
    fields: { '7': 70 },
  },
  answer: Partial<AppliedTemplate> = {},
  names: Record<string, Named[]> = {},
): FakePickerClient {
  const applied: FakePickerClient['applied'] = [];
  return {
    applied,
    list: async () => templates,
    start: async () => ({ start, names }),
    apply: async (id, body) => {
      applied.push({ id, body });
      return {
        key: 'SHOP-9',
        left: [],
        subtickets: [
          { summary: 'Write the notes', key: 'SHOP-10', error: null },
          { summary: 'Announce it', key: 'SHOP-11', error: null },
        ],
        ...answer,
      };
    },
  };
}
