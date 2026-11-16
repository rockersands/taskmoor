import { ApiError } from '../api/client';
import type {
  ChildOption,
  Field,
  FieldContext,
  FieldOption,
  FieldsClient,
  FormulaCheck,
  Named,
  NamedTrack,
} from './client';

export interface FakeFieldsClient extends FieldsClient {
  calls: { action: string; args: unknown[] }[];
}

const TRACKS: NamedTrack[] = [
  { id: 1, key: 'PAY', name: 'Payments' },
  { id: 4, key: 'OPS', name: 'Operations' },
];
const TYPES: Named[] = [
  { id: 11, name: 'Bug' },
  { id: 12, name: 'Feature' },
  { id: 13, name: 'Subticket' },
];
const GROUPS: Named[] = [
  { id: 21, name: 'Reviewers' },
  { id: 22, name: 'Support' },
];
const ROLES: Named[] = [
  { id: 31, name: 'Administrators' },
  { id: 32, name: 'Members' },
];
const PEOPLE: Named[] = [
  { id: 41, name: 'Ana Ruiz' },
  { id: 42, name: 'Sam Lee' },
];
const TEAMS: Named[] = [{ id: 51, name: 'Platform' }];
/** Built-in fields a formula reads, by the names formulas use (`fields/formulas.ts`). */
const SYSTEM = new Map([
  ['summary', 'summary'],
  ['due date', 'dueDate'],
  ['start date', 'startDate'],
  ['created', 'created'],
]);
const READABLE = new Set([
  'number',
  'date',
  'datetime',
  'text',
  'read-only-text',
  'url',
  'formula',
]);

/** The fields the fake backend starts with, for stories that show one. */
export function sampleFields(): Field[] {
  return [
    {
      id: 1,
      name: 'Customer',
      description: 'Who asked for it.',
      type: 'text',
      multiple: false,
      config: {},
      trackId: null,
      contexts: [
        {
          id: 10,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: null,
        },
      ],
    },
    {
      id: 2,
      name: 'Severity',
      description: '',
      type: 'select',
      multiple: false,
      config: {},
      trackId: null,
      contexts: [
        {
          id: 20,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: { id: 201, value: 'Low' },
          options: [
            { id: 201, value: 'Low', disabled: false, children: [] },
            { id: 202, value: 'Medium', disabled: false, children: [] },
            { id: 203, value: 'Critical', disabled: true, children: [] },
          ],
        },
        {
          id: 21,
          name: 'Payments bugs',
          trackIds: [1],
          ticketTypeIds: [11],
          config: {},
          defaultValue: null,
          options: [{ id: 211, value: 'Blocker', disabled: false, children: [] }],
        },
      ],
    },
    {
      id: 3,
      name: 'Components',
      description: '',
      type: 'select',
      multiple: true,
      config: {},
      trackId: 4,
      contexts: [
        {
          id: 30,
          name: 'OPS',
          trackIds: [4],
          ticketTypeIds: null,
          config: {},
          defaultValue: null,
          options: [],
        },
      ],
    },
    {
      id: 5,
      name: 'Region',
      description: '',
      type: 'cascading-select',
      multiple: false,
      config: {},
      trackId: null,
      contexts: [
        {
          id: 50,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: null,
          options: [
            {
              id: 501,
              value: 'Europe',
              disabled: false,
              children: [
                { id: 511, value: 'Madrid', disabled: false },
                { id: 512, value: 'Lisbon', disabled: false },
              ],
            },
            { id: 502, value: 'Americas', disabled: false, children: [] },
          ],
        },
      ],
    },
    {
      id: 6,
      name: 'Reviewer',
      description: '',
      type: 'user',
      multiple: false,
      config: {},
      trackId: null,
      contexts: [
        {
          id: 60,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: { userGroupId: 21 },
          defaultValue: null,
        },
      ],
    },
    {
      id: 7,
      name: 'Cost',
      description: '',
      type: 'number',
      multiple: false,
      config: { format: 'currency', currency: 'EUR', decimals: 2 },
      trackId: null,
      contexts: [
        {
          id: 70,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: null,
        },
      ],
    },
    {
      id: 8,
      name: 'Days left',
      description: '',
      type: 'formula',
      multiple: false,
      config: { expression: 'daysBetween(today(), {Due date})', output: 'number' },
      trackId: null,
      contexts: [
        {
          id: 80,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: null,
        },
      ],
    },
    {
      id: 4,
      name: 'Office',
      description: '',
      type: 'cascading-select',
      multiple: false,
      config: {},
      trackId: null,
      contexts: [
        {
          id: 40,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          config: {},
          defaultValue: {
            id: 401,
            value: 'Madrid',
            child: { id: 4011, value: 'Floor 1' },
          },
          options: [
            {
              id: 401,
              value: 'Madrid',
              disabled: false,
              children: [
                { id: 4011, value: 'Floor 1', disabled: false },
                { id: 4012, value: 'Floor 2', disabled: false },
              ],
            },
            { id: 402, value: 'Lisbon', disabled: false, children: [] },
            {
              id: 403,
              value: 'Porto',
              disabled: false,
              children: [{ id: 4031, value: 'Quay', disabled: false }],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * An in-memory backend for stories and tests: it answers as the API would. Medium is on three
 * tickets, so deleting it, the field or its context is refused; so is Porto. Severity has a second
 * context for Payments bugs, and Low starts its new tickets; Region is a two-level list; Reviewer
 * a person field limited to a group; Cost a number shown as euros; Days left a formula; Office a
 * two-level list whose default is Madrid, Floor 1. Deleting an option a default names leaves the
 * context with none, as the server does.
 */
export function fakeFieldsClient(): FakeFieldsClient {
  let fields: Field[] = sampleFields();
  const inUse = new Set([202, 403]);
  let next = 1000;
  const calls: FakeFieldsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const find = (id: number) => {
    const field = fields.find((f) => f.id === id);
    if (!field) throw new ApiError(404, { error: 'not_found' });
    return field;
  };
  const contextOf = (fieldId: number, contextId: number): FieldContext => {
    const context = find(fieldId).contexts.find((c) => c.id === contextId);
    if (!context) throw new ApiError(404, { error: 'not_found' });
    return context;
  };
  const optionsOf = (fieldId: number, contextId: number) => {
    const context = contextOf(fieldId, contextId);
    context.options ??= [];
    return context.options;
  };
  const allOptions = (context: FieldContext): ChildOption[] =>
    (context.options ?? []).flatMap((o) => [o, ...(o.children ?? [])]);
  const level = (fieldId: number, contextId: number, parentId: number | null) => {
    const top = optionsOf(fieldId, contextId);
    if (parentId === null) return top;
    const parent = top.find((o) => o.id === parentId);
    if (!parent) throw new ApiError(400, { error: 'unknown_parent' });
    parent.children ??= [];
    return parent.children;
  };
  const view = (field: Field) => structuredClone(field);
  /** A default given as ids, as the REST form shows it. */
  const restDefault = (field: Field, context: FieldContext, input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    // As the server: only an option the context still offers.
    const option = (id: number) => {
      const found = allOptions(context).find((o) => o.id === id);
      if (!found || found.disabled) {
        throw new ApiError(400, { error: 'invalid_default', problem: 'not_found' });
      }
      return { id, value: found.value };
    };
    const person = (list: Named[], id: number) => {
      const found = list.find((p) => p.id === id);
      if (!found) throw new ApiError(400, { error: 'invalid_default', problem: 'not_found' });
      return { id, name: found.name };
    };
    const many = (one: (id: number) => unknown) =>
      field.multiple ? (input as number[]).map(one) : one(input as number);
    switch (field.type) {
      case 'select':
        return many(option);
      case 'cascading-select': {
        const { parent, child } = input as { parent: number; child?: number };
        return { ...option(parent), child: child === undefined ? null : option(child) };
      }
      case 'user':
        return many((id) => person(PEOPLE, id));
      case 'group':
        return many((id) => person(GROUPS, id));
      case 'team':
        return person(TEAMS, input as number);
      case 'number':
        return Number(input);
      default:
        return input;
    }
  };
  const overlaps = (
    field: Field,
    contextId: number,
    tracks: number[] | null,
    types: number[] | null,
  ) =>
    field.contexts.some((c) => {
      if (c.id === contextId) return false;
      const meets = (a: number[] | null, b: number[] | null) =>
        (a === null && b === null) || (a !== null && b !== null && a.some((x) => b.includes(x)));
      return meets(c.trackIds, tracks) && meets(c.ticketTypeIds, types);
    });
  const contextConfig = (config: { userGroupId?: number | null; userRoleId?: number | null }) =>
    Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null && v !== undefined));

  return {
    calls,
    fields: async () =>
      structuredClone(fields).map((f) => ({
        ...f,
        contexts: f.contexts.map(({ options: _, ...c }) => c),
      })),
    field: async (id) => view(find(id)),
    createField: async (body) => {
      log('createField', body);
      if (fields.some((f) => f.name === body.name))
        throw new ApiError(409, { error: 'name_taken' });
      if (body.type === 'formula' && (body.config?.expression ?? '').includes('{Pionts}')) {
        throw new ApiError(400, {
          error: 'invalid_formula',
          formula: problemAt(body.config?.expression ?? '', '{Pionts}', 'unknown_field'),
        });
      }
      const made: Field = {
        id: ++next,
        name: body.name,
        description: body.description ?? '',
        type: body.type,
        multiple: body.multiple ?? false,
        config: body.config ?? {},
        trackId: null,
        contexts: [
          {
            id: ++next,
            name: 'Default',
            trackIds: null,
            ticketTypeIds: null,
            config: {},
            defaultValue: null,
            ...(body.type === 'select' || body.type === 'cascading-select' ? { options: [] } : {}),
          },
        ],
      };
      fields = [...fields, made];
      return view(made);
    },
    updateField: async (id, change) => {
      log('updateField', id, change);
      Object.assign(find(id), change);
      return view(find(id));
    },
    deleteField: async (id) => {
      log('deleteField', id);
      const held = find(id).contexts.some((c) => allOptions(c).some((o) => inUse.has(o.id)));
      if (held) throw new ApiError(409, { error: 'in_use', ticketCount: 3 });
      fields = fields.filter((f) => f.id !== id);
    },
    addContext: async (fieldId, body) => {
      log('addContext', fieldId, body);
      const field = find(fieldId);
      if (field.contexts.some((c) => c.name === body.name))
        throw new ApiError(409, { error: 'name_taken' });
      if (overlaps(field, 0, body.trackIds, body.ticketTypeIds))
        throw new ApiError(409, { error: 'context_overlap' });
      field.contexts.push({
        id: ++next,
        name: body.name,
        trackIds: body.trackIds,
        ticketTypeIds: body.ticketTypeIds,
        config: contextConfig(body.config ?? {}),
        defaultValue: null,
        ...(field.type === 'select' || field.type === 'cascading-select' ? { options: [] } : {}),
      });
      return view(field);
    },
    updateContext: async (fieldId, contextId, change) => {
      log('updateContext', fieldId, contextId, change);
      const field = find(fieldId);
      const context = contextOf(fieldId, contextId);
      const tracks = change.trackIds === undefined ? context.trackIds : change.trackIds;
      const types =
        change.ticketTypeIds === undefined ? context.ticketTypeIds : change.ticketTypeIds;
      if (overlaps(field, contextId, tracks, types))
        throw new ApiError(409, { error: 'context_overlap' });
      if (change.name !== undefined) context.name = change.name;
      context.trackIds = tracks;
      context.ticketTypeIds = types;
      if (change.config !== undefined) {
        context.config = contextConfig({ ...context.config, ...change.config });
      }
      if (change.defaultValue !== undefined) {
        context.defaultValue = restDefault(field, context, change.defaultValue);
      }
      return view(field);
    },
    deleteContext: async (fieldId, contextId) => {
      log('deleteContext', fieldId, contextId);
      const field = find(fieldId);
      if (allOptions(contextOf(fieldId, contextId)).some((o) => inUse.has(o.id))) {
        throw new ApiError(409, { error: 'options_in_use', ticketCount: 3 });
      }
      field.contexts = field.contexts.filter((c) => c.id !== contextId);
    },
    addOption: async (fieldId, contextId, value, parentId) => {
      log('addOption', fieldId, contextId, value, ...(parentId === undefined ? [] : [parentId]));
      const list = level(fieldId, contextId, parentId ?? null);
      if (list.some((o) => o.value === value)) throw new ApiError(409, { error: 'value_taken' });
      const made: FieldOption = { id: ++next, value, disabled: false };
      if (parentId === undefined) made.children = [];
      list.push(made);
      return view(find(fieldId));
    },
    updateOption: async (fieldId, contextId, optionId, change) => {
      log('updateOption', fieldId, contextId, optionId, change);
      const option = allOptions(contextOf(fieldId, contextId)).find((o) => o.id === optionId);
      Object.assign(option ?? {}, change);
      return view(find(fieldId));
    },
    deleteOption: async (fieldId, contextId, optionId) => {
      log('deleteOption', fieldId, contextId, optionId);
      if (inUse.has(optionId)) throw new ApiError(409, { error: 'in_use', ticketCount: 3 });
      const context = contextOf(fieldId, contextId);
      const top = optionsOf(fieldId, contextId);
      // As the server: a default that names it, or a child of it, goes too.
      const gone = new Set([
        optionId,
        ...(top.find((o) => o.id === optionId)?.children ?? []).map((c) => c.id),
      ]);
      const named = [context.defaultValue ?? []].flat() as {
        id?: number;
        child?: { id?: number } | null;
      }[];
      if (named.some((v) => gone.has(v.id ?? 0) || gone.has(v.child?.id ?? 0))) {
        context.defaultValue = null;
      }
      context.options = top.filter((o) => o.id !== optionId);
      for (const o of context.options)
        o.children = (o.children ?? []).filter((c) => c.id !== optionId);
    },
    orderOptions: async (fieldId, contextId, parentId, optionIds) => {
      log('orderOptions', fieldId, contextId, parentId, optionIds);
      const list = level(fieldId, contextId, parentId);
      const sorted = optionIds.map((id) => list.find((o) => o.id === id) as FieldOption);
      list.splice(0, list.length, ...sorted);
      return view(find(fieldId));
    },
    checkFormula: async ({ expression, output }) => {
      log('checkFormula', expression, output);
      return check(expression, fields);
    },
    tracks: async () => structuredClone(TRACKS),
    ticketTypes: async () => structuredClone(TYPES),
    groups: async () => structuredClone(GROUPS),
    roles: async () => structuredClone(ROLES),
    findPeople: async (typed) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())),
    findTeams: async (typed) =>
      TEAMS.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())),
  };
}

/** Where `token` sits in `expression`, as the formula check names a problem. */
function problemAt(expression: string, token: string, code: string) {
  const start = expression.indexOf(token);
  const before = expression.slice(0, start).split('\n');
  return {
    code,
    message: 'English words the page does not show',
    start,
    end: start + token.length,
    line: before.length,
    column: (before.at(-1)?.length ?? 0) + 1,
  };
}

/** The live check, enough of it for stories and tests: names in braces, found or not. */
function check(expression: string, fields: readonly Field[]): FormulaCheck {
  if (expression.trim() === '') {
    return { ok: false, error: { code: 'empty', start: 0, end: 0, line: 1, column: 1 } };
  }
  const open = expression.lastIndexOf('{');
  if (open > expression.lastIndexOf('}')) {
    return {
      ok: false,
      error: problemAt(expression, expression.slice(open), 'unterminated_field'),
    };
  }
  const reads: string[] = [];
  for (const [token, name] of expression.matchAll(/\{([^}]*)\}/g)) {
    const lower = (name ?? '').trim().toLowerCase();
    const system = SYSTEM.get(lower);
    const custom = fields.find((f) => f.name.toLowerCase() === lower && READABLE.has(f.type));
    if (system) reads.push(system);
    else if (custom) reads.push(`cf[${custom.id}]`);
    else return { ok: false, error: problemAt(expression, token, 'unknown_field') };
  }
  return { ok: true, type: 'number', reads, childReads: [] };
}
