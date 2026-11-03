import { ApiError } from '../../api/client';
import type {
  AppliedTemplate,
  FieldValueOption,
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
  areas: [{ id: 31, name: 'Checkout' }],
  releases: [{ id: 41, name: '1.0' }],
  fields: [
    { id: 7, name: 'Severity', type: 'select', multiple: false },
    { id: 9, name: 'Customer', type: 'text', multiple: false },
    { id: 99, name: 'Secret formula', type: 'formula', multiple: false },
  ],
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
}

const OPTIONS: Record<string, FieldValueOption[]> = {
  '7': [
    { id: 70, value: 'Blocker' },
    { id: 71, value: 'Minor' },
  ],
};

/** An in-memory backend; a second template with a name in use is refused, as the API does. */
export function fakeTemplateClient(
  start: SavedTemplate[] = [RELEASE_TEMPLATE, INCIDENT_TEMPLATE],
  { mayCreate = true, options = TEMPLATE_OPTIONS } = {},
): FakeTemplateClient {
  let rows = structuredClone(start);
  let next = 100;
  const saved: FakeTemplateClient['saved'] = [];
  const removed: number[] = [];
  const refuseTaken = (body: TemplateBody, id: number | null) => {
    if (rows.some((r) => r.name === body.name && r.id !== id)) {
      throw new ApiError(400, { error: 'invalid_fields', fields: { name: 'taken' } });
    }
  };
  return {
    saved,
    removed,
    list: async () => ({ templates: structuredClone(rows), mayCreate }),
    options: async () => options,
    fieldOptions: async (fieldId) => OPTIONS[String(fieldId)] ?? [],
    people: async (_track, query) =>
      [{ id: 21, name: 'Sam Rivera' }].filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()),
      ),
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
): FakePickerClient {
  const applied: FakePickerClient['applied'] = [];
  return {
    applied,
    list: async () => templates,
    start: async () => start,
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
