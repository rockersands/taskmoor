import type { PmJson } from '@taskmoor/richtext';
import { ApiError } from '../../api/client';
import type { MessageId } from '../../i18n/messages.en';
import { errorMessage, splitLabels, trackThingOf } from '../form';
import type {
  FieldChoice,
  FieldRule,
  Named,
  SavedTemplate,
  TemplateBody,
  TemplateDefaults,
  TemplateSubticket,
} from './client';

/** Custom field types the template form holds a value for; the API takes the others. */
export const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'date',
  'url',
  'select',
  'labels',
]);

/**
 * Custom field types whose values are the track's releases or areas: the form names them from the
 * track's lists, lets a person remove one (T-291) and add one of the track's open ones (T-299).
 */
export const TRACK_VALUE_TYPES: ReadonlySet<string> = new Set(['release', 'area']);

/**
 * Custom field types whose values are people, groups or teams: the form names them as the create
 * form's pickers do, lets a person remove one (T-299) and find one to add with the create form's
 * searches (T-350).
 */
export const NAMED_VALUE_TYPES: ReadonlySet<string> = new Set(['user', 'group', 'team']);

/** Custom field types the form lists by id: the track's lists, and the named ones. */
const LISTED_TYPES: ReadonlySet<string> = new Set([...TRACK_VALUE_TYPES, ...NAMED_VALUE_TYPES]);

/**
 * The context a field takes for a ticket of a type in a track, as the server picks it: the one
 * that names both, then the track's for every type, then the type's in every track, then the one
 * for everything (CORE-009).
 */
function ruleFor(rules: readonly FieldRule[], trackId: number, typeId: number): FieldRule | null {
  const covers = (list: number[] | null, id: number, named: boolean) =>
    named ? list?.includes(id) === true : list === null;
  for (const [track, type] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const) {
    const found = rules.find(
      (r) => covers(r.trackIds, trackId, track) && covers(r.ticketTypeIds, typeId, type),
    );
    if (found) return found;
  }
  return null;
}

/**
 * Where a template's custom person field finds people to add (T-350):
 * - `anyone`: the track's people, as the create form's person picker finds them, or, on a
 *   template for every track, anyone active in the site;
 * - `allowed`: only those the field allows (CORE-009 (2)), asked for with one ticket type per
 *   context that limits it among the types the template fits; a person must be allowed by each,
 *   since the ticket can be of any of them;
 * - `none`: no search can say, because the field allows only some people in a context and the
 *   template is for every track, whose people the server finds per track only.
 */
export type PersonSearch =
  | { kind: 'anyone' }
  | { kind: 'allowed'; typeIds: number[] }
  | { kind: 'none' };

export function personSearchOf(
  rules: readonly FieldRule[],
  trackId: number | null,
  typeIds: readonly number[],
): PersonSearch {
  if (trackId === null) {
    return rules.some((r) => r.restricted) ? { kind: 'none' } : { kind: 'anyone' };
  }
  const byRule = new Map<number, number>();
  for (const typeId of typeIds) {
    const rule = ruleFor(rules, trackId, typeId);
    if (rule?.restricted && !byRule.has(rule.id)) byRule.set(rule.id, typeId);
  }
  return byRule.size === 0
    ? { kind: 'anyone' }
    : { kind: 'allowed', typeIds: [...byRule.values()] };
}

/** Those found by every one of several searches, in the first one's order. */
export function foundByEach(lists: readonly Named[][]): Named[] {
  const [first = [], ...rest] = lists;
  return first.filter((n) => rest.every((list) => list.some((m) => m.id === n.id)));
}

/** A subticket-level type's rank (spec 01a section 1.2). */
export const SUBTICKET_RANK = -1;

/** A template as the form holds it, typed values as text. */
export interface TemplateDraft {
  name: string;
  purpose: string;
  ticketTypeIds: number[];
  summary: string;
  description: PmJson | null;
  priorityId: string;
  labels: string;
  startInDays: string;
  dueInDays: string;
  /**
   * Who it assigns; with no name when the reader may not see them named, or they are gone
   * (T-283).
   */
  assignee: Named | null;
  areaIds: number[];
  targetReleaseIds: number[];
  foundInReleaseIds: number[];
  /** Values by field id. */
  fields: Record<string, string | string[]>;
  /** The releases or areas a custom release or area field holds, as ids by field id. */
  trackValues: Record<string, number[]>;
  /** The people, groups or teams a custom person, group or team field holds, as ids by field id. */
  namedValues: Record<string, number[]>;
  subtickets: { summary: string; ticketTypeId: string }[];
}

const asText = (value: number | undefined) => (value === undefined ? '' : String(value));

const MAX_ID = 2_147_483_647;

/** A release or area id as the API reads one: a number, a string of digits, or `{"id": n}`. */
function idOf(input: unknown): number | null {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'id' in input) {
    return idOf((input as { id: unknown }).id);
  }
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 && input <= MAX_ID ? input : null;
  }
  if (typeof input === 'string' && /^[1-9][0-9]{0,9}$/.test(input)) {
    const n = Number(input);
    return n <= MAX_ID ? n : null;
  }
  return null;
}

/**
 * The ids a custom release or area value holds (an id, or ids for a multiple field; none for an
 * empty list), or null when the form cannot read every one of them: such a value stays as saved,
 * as one the form does not show, so that a save never drops what it could not list.
 */
function idsOf(value: unknown): number[] | null {
  const list = Array.isArray(value) ? value : [value];
  const ids: number[] = [];
  for (const item of list) {
    const id = idOf(item);
    if (id === null) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function fieldText(field: FieldChoice, value: unknown): string | string[] {
  if (Array.isArray(value)) {
    return field.type === 'labels' ? value.join(' ') : value.map(String);
  }
  if (field.type === 'select' && field.multiple) return [String(value)];
  return String(value);
}

export function draftOf(
  saved: SavedTemplate | null,
  fields: readonly FieldChoice[],
): TemplateDraft {
  const defaults = saved?.defaults ?? {};
  const values: TemplateDraft['fields'] = {};
  const trackValues: TemplateDraft['trackValues'] = {};
  const namedValues: TemplateDraft['namedValues'] = {};
  for (const [id, value] of Object.entries(defaults.fields ?? {})) {
    const field = fields.find((f) => String(f.id) === id);
    if (field && FORM_FIELD_TYPES.has(field.type) && value != null) {
      values[id] = fieldText(field, value);
    } else if (field && LISTED_TYPES.has(field.type)) {
      const ids = idsOf(value);
      const into = TRACK_VALUE_TYPES.has(field.type) ? trackValues : namedValues;
      if (ids && ids.length > 0) into[id] = ids;
    }
  }
  return {
    name: saved?.name ?? '',
    purpose: saved?.purpose ?? '',
    ticketTypeIds: saved?.ticketTypeIds ?? [],
    summary: saved?.summary ?? '',
    description: saved?.description ?? null,
    priorityId: asText(defaults.priorityId),
    labels: (defaults.labels ?? []).join(' '),
    startInDays: asText(defaults.startInDays),
    dueInDays: asText(defaults.dueInDays),
    // An assignee the API does not name keeps its id, so a save never drops it (T-283).
    assignee:
      saved?.assignee ??
      (defaults.assigneeId === undefined ? null : { id: defaults.assigneeId, name: '' }),
    areaIds: defaults.areaIds ?? [],
    targetReleaseIds: defaults.targetReleaseIds ?? [],
    foundInReleaseIds: defaults.foundInReleaseIds ?? [],
    fields: values,
    trackValues,
    namedValues,
    subtickets: (saved?.subtickets ?? []).map((s) => ({
      summary: s.summary,
      ticketTypeId: s.ticketTypeId == null ? '' : String(s.ticketTypeId),
    })),
  };
}

function fieldValue(field: FieldChoice, raw: string | string[]): unknown {
  if (Array.isArray(raw)) return raw.length === 0 ? undefined : raw.map(Number);
  if (raw.trim() === '') return undefined;
  if (field.type === 'number' || field.type === 'select') return Number(raw);
  if (field.type === 'labels') return splitLabels(raw);
  return raw.trim();
}

/**
 * Whether the form shows a saved custom field value: a control for it, or its releases, areas,
 * people, groups or teams when it can read each of their ids.
 */
function shown(field: FieldChoice | undefined, value: unknown): boolean {
  if (field === undefined) return false;
  if (FORM_FIELD_TYPES.has(field.type)) return true;
  return LISTED_TYPES.has(field.type) && (value == null || idsOf(value) !== null);
}

/**
 * The defaults a draft makes. What the form does not show stays as saved: custom fields of types
 * it has no control for, and an assignee on a template for every track. A custom release, area,
 * person, group or team field keeps the values the form still lists, as an id or ids as the field
 * takes them.
 */
function defaultsOf(
  draft: TemplateDraft,
  saved: SavedTemplate | null,
  fields: readonly FieldChoice[],
  inTrack: boolean,
): TemplateDefaults {
  const out: TemplateDefaults = {};
  const before = saved?.defaults ?? {};
  if (draft.priorityId !== '') out.priorityId = Number(draft.priorityId);
  const labels = splitLabels(draft.labels);
  if (labels.length > 0) out.labels = labels;
  if (draft.startInDays !== '') out.startInDays = Number(draft.startInDays);
  if (draft.dueInDays !== '') out.dueInDays = Number(draft.dueInDays);
  if (inTrack) {
    if (draft.assignee) out.assigneeId = draft.assignee.id;
    if (draft.areaIds.length > 0) out.areaIds = draft.areaIds;
    if (draft.targetReleaseIds.length > 0) out.targetReleaseIds = draft.targetReleaseIds;
    if (draft.foundInReleaseIds.length > 0) out.foundInReleaseIds = draft.foundInReleaseIds;
  } else if (before.assigneeId !== undefined) {
    out.assigneeId = before.assigneeId;
  }
  const custom: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(before.fields ?? {})) {
    const field = fields.find((f) => String(f.id) === id);
    if (!shown(field, value)) custom[id] = value;
  }
  for (const [id, ids] of Object.entries({ ...draft.trackValues, ...draft.namedValues })) {
    const field = fields.find((f) => String(f.id) === id);
    if (!field || ids.length === 0) continue;
    custom[id] = field.multiple ? ids : ids[0];
  }
  for (const [id, raw] of Object.entries(draft.fields)) {
    const field = fields.find((f) => String(f.id) === id);
    const value = field ? fieldValue(field, raw) : undefined;
    if (value !== undefined) custom[id] = value;
  }
  if (Object.keys(custom).length > 0) out.fields = custom;
  return out;
}

/** What a draft saves as. */
export function bodyOf(
  draft: TemplateDraft,
  saved: SavedTemplate | null,
  fields: readonly FieldChoice[],
  track: string | null,
): TemplateBody {
  const subtickets: TemplateSubticket[] = draft.subtickets
    .filter((s) => s.summary.trim() !== '')
    .map((s) => ({
      summary: s.summary.trim(),
      ...(s.ticketTypeId === '' ? {} : { ticketTypeId: Number(s.ticketTypeId) }),
    }));
  return {
    ...(saved ? { version: saved.version } : { track }),
    name: draft.name.trim(),
    purpose: draft.purpose.trim(),
    ticketTypeIds: draft.ticketTypeIds,
    summary: draft.summary,
    description: draft.description,
    defaults: defaultsOf(draft, saved, fields, track !== null),
    subtickets,
  };
}

/** How many of a saved template's custom field values the form does not show. */
export function keptValues(saved: SavedTemplate | null, fields: readonly FieldChoice[]): number {
  return Object.entries(saved?.defaults.fields ?? {}).filter(
    ([id, value]) =>
      !shown(
        fields.find((f) => String(f.id) === id),
        value,
      ),
  ).length;
}

/**
 * Where the form shows a problem: a control's own name (`name`, `priority`, `areaIds`), a custom
 * field's `field:<id>`, or a subticket row's `subticket:<index in the draft>` (with `:type` for
 * its type).
 */
export type ProblemSpot = string;

/** A refused save: the message for the whole form, and the problems by where they show. */
export interface Refusal {
  message: MessageId;
  at: Record<ProblemSpot, MessageId>;
}

/** Body paths of the template's own values and of its defaults, by the spot that shows them. */
const SPOTS: Record<string, ProblemSpot> = {
  name: 'name',
  purpose: 'purpose',
  summary: 'summary',
  description: 'description',
  ticketTypeIds: 'ticketTypeIds',
  'defaults.priorityId': 'priority',
  'defaults.labels': 'labels',
  'defaults.startInDays': 'startInDays',
  'defaults.dueInDays': 'dueInDays',
  'defaults.assigneeId': 'assignee',
  'defaults.areaIds': 'areaIds',
  'defaults.targetReleaseIds': 'targetReleaseIds',
  'defaults.foundInReleaseIds': 'foundInReleaseIds',
};

/** The spot a body path's problem shows at, or null for one the form does not place. */
function spotOf(path: string, draft: TemplateDraft): ProblemSpot | null {
  const custom = /^defaults\.fields\.(\d+)(\.|$)/.exec(path);
  if (custom) return `field:${custom[1]}`;
  const sub = /^subtickets\.(\d+)(?:\.(\w+))?$/.exec(path);
  if (sub) {
    // The body leaves out rows with no summary: its index counts the rows it kept.
    const rows = draft.subtickets.flatMap((s, i) => (s.summary.trim() === '' ? [] : [i]));
    const row = rows[Number(sub[1])];
    if (row === undefined) return null;
    return sub[2] === 'ticketTypeId' ? `subticket:${row}:type` : `subticket:${row}`;
  }
  // `defaults.areaIds.2` is the third area: the problem shows at the list.
  const key = Object.keys(SPOTS).find((p) => path === p || path.startsWith(`${p}.`));
  return key === undefined ? null : (SPOTS[key] ?? null);
}

/** A field's id and type, for the words of its refusal. */
type TypedField = Pick<FieldChoice, 'id' | 'type'>;

/**
 * A problem's message. The create route's codes read as they do on the create form (T-291):
 * an archived release or area, one the track does not offer, a value that is gone. A release or
 * area the track does not have says which it is (T-286): the system lists by their path, a custom
 * field by its type in `fields`.
 */
function problemMessage(path: string, code: string, fields: readonly TypedField[]): MessageId {
  if (path === 'name' && code === 'taken') return 'tickets.templates.problem.nameTaken';
  if (code === 'track_only') return 'tickets.templates.problem.trackOnly';
  const custom = /^defaults\.fields\.(\d+)(\.|$)/.exec(path);
  const type = custom ? fields.find((f) => f.id === Number(custom[1]))?.type : undefined;
  const system = /^defaults\.(\w+)/.exec(path)?.[1] ?? '';
  return errorMessage(code, trackThingOf(custom ? '' : system, type));
}

/** A refusal from the API as one message: a delete's, or a save's line for the whole form. */
export function refusalOf(error: unknown): MessageId {
  if (!(error instanceof ApiError)) return 'tickets.templates.problem.other';
  const body = error.body as { error?: string; fields?: Record<string, string> } | null;
  if (body?.fields?.name === 'taken') return 'tickets.templates.problem.nameTaken';
  if (body?.error === 'version_conflict') return 'tickets.templates.problem.conflict';
  if (body?.error === 'limit_reached') return 'tickets.templates.problem.limit';
  if (body?.error === 'track_archived') return 'tickets.templates.problem.archived';
  if (error.status === 400) return 'tickets.templates.problem.invalid';
  if (error.status === 403) return 'tickets.templates.problem.forbidden';
  return 'tickets.templates.problem.other';
}

/**
 * A refused save (T-291): a refused value's reason next to the control it belongs to, with a
 * line for the form that says to look there. A problem the form has no spot for, such as a value
 * it does not show, keeps the general line. `fieldTypes` gives custom fields' types, so a release or
 * area field's refusal names what it holds (T-286).
 */
export function saveRefusalOf(
  error: unknown,
  draft: TemplateDraft,
  fieldTypes: readonly TypedField[] = [],
): Refusal {
  const body = error instanceof ApiError && error.status === 400 ? error.body : null;
  const fields = (body as { fields?: Record<string, string> } | null)?.fields;
  if (!fields) return { message: refusalOf(error), at: {} };
  const at: Record<ProblemSpot, MessageId> = {};
  let unplaced = false;
  for (const [path, code] of Object.entries(fields)) {
    const spot = spotOf(path, draft);
    if (spot === null) unplaced = true;
    else at[spot] ??= problemMessage(path, code, fieldTypes);
  }
  const placed = Object.keys(at).length;
  if (placed === 1 && at.name === 'tickets.templates.problem.nameTaken' && !unplaced) {
    return { message: 'tickets.templates.problem.nameTaken', at: {} };
  }
  return {
    message:
      unplaced || placed === 0
        ? 'tickets.templates.problem.invalid'
        : 'tickets.templates.problem.marked',
    at,
  };
}

/** The draft's own values by the spot that shows their problems. */
const DRAFT_SPOTS: Partial<Record<keyof TemplateDraft, ProblemSpot>> = {
  name: 'name',
  purpose: 'purpose',
  ticketTypeIds: 'ticketTypeIds',
  summary: 'summary',
  description: 'description',
  priorityId: 'priority',
  labels: 'labels',
  startInDays: 'startInDays',
  dueInDays: 'dueInDays',
  assignee: 'assignee',
  areaIds: 'areaIds',
  targetReleaseIds: 'targetReleaseIds',
  foundInReleaseIds: 'foundInReleaseIds',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The ids of a record's entries that differ between two drafts. */
function changedIds(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => !same(before[id], after[id]));
}

/**
 * The spots whose values an edit changed (T-299): a control's own, a custom field's
 * `field:<id>`, a subticket row's summary or type.
 */
export function editedSpots(before: TemplateDraft, after: TemplateDraft): ProblemSpot[] {
  const out: ProblemSpot[] = [];
  for (const [key, spot] of Object.entries(DRAFT_SPOTS) as [keyof TemplateDraft, ProblemSpot][]) {
    if (!same(before[key], after[key])) out.push(spot);
  }
  for (const id of [
    ...changedIds(before.fields, after.fields),
    ...changedIds(before.trackValues, after.trackValues),
    ...changedIds(before.namedValues, after.namedValues),
  ]) {
    out.push(`field:${id}`);
  }
  const rows = Math.max(before.subtickets.length, after.subtickets.length);
  for (let i = 0; i < rows; i++) {
    const was = before.subtickets[i];
    const now = after.subtickets[i];
    if (was?.summary !== now?.summary) out.push(`subticket:${i}`);
    if (was?.ticketTypeId !== now?.ticketTypeId) out.push(`subticket:${i}:type`);
  }
  return out;
}

/**
 * A refusal once some values were edited (T-299): their reasons go, as the person is changing
 * what was refused. The line for the whole form goes with the last reason it pointed to, and a
 * name in use goes once the name changes; a problem the form could not place keeps its line.
 */
export function clearedRefusal(refusal: Refusal | null, edited: ProblemSpot[]): Refusal | null {
  if (refusal === null || edited.length === 0) return refusal;
  if (refusal.message === 'tickets.templates.problem.nameTaken' && edited.includes('name')) {
    return null;
  }
  const at = Object.fromEntries(
    Object.entries(refusal.at).filter(([spot]) => !edited.includes(spot)),
  );
  if (Object.keys(at).length === Object.keys(refusal.at).length) return refusal;
  if (Object.keys(at).length === 0 && refusal.message === 'tickets.templates.problem.marked') {
    return null;
  }
  return { ...refusal, at };
}
