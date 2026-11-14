import type { PmJson } from '@taskmoor/richtext';
import { ApiError } from '../../api/client';
import type { MessageId } from '../../i18n/messages.en';
import { errorMessage, splitLabels } from '../form';
import type {
  FieldChoice,
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
 * track's lists and lets a person remove one, but offers none to add (T-291).
 */
export const TRACK_VALUE_TYPES: ReadonlySet<string> = new Set(['release', 'area']);

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
  assignee: Named | null;
  areaIds: number[];
  targetReleaseIds: number[];
  foundInReleaseIds: number[];
  /** Values by field id. */
  fields: Record<string, string | string[]>;
  /** The releases or areas a custom release or area field holds, as ids by field id. */
  trackValues: Record<string, number[]>;
  subtickets: { summary: string; ticketTypeId: string }[];
}

const asText = (value: number | undefined) => (value === undefined ? '' : String(value));

/** The ids a custom release or area value holds: an id, or ids for a multiple field. */
function idsOf(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
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
  for (const [id, value] of Object.entries(defaults.fields ?? {})) {
    const field = fields.find((f) => String(f.id) === id);
    if (field && FORM_FIELD_TYPES.has(field.type) && value != null) {
      values[id] = fieldText(field, value);
    } else if (field && TRACK_VALUE_TYPES.has(field.type) && idsOf(value).length > 0) {
      trackValues[id] = idsOf(value);
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
    assignee: saved?.assignee ?? null,
    areaIds: defaults.areaIds ?? [],
    targetReleaseIds: defaults.targetReleaseIds ?? [],
    foundInReleaseIds: defaults.foundInReleaseIds ?? [],
    fields: values,
    trackValues,
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

/** Whether the form shows a custom field's value: a control for it, or its releases or areas. */
function shown(field: FieldChoice | undefined): boolean {
  return (
    field !== undefined && (FORM_FIELD_TYPES.has(field.type) || TRACK_VALUE_TYPES.has(field.type))
  );
}

/**
 * The defaults a draft makes. What the form does not show stays as saved: custom fields of types
 * it has no control for, and an assignee on a template for every track. A custom release or area
 * field keeps the values the form still lists, as an id or ids as the field takes them.
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
    if (!shown(field)) custom[id] = value;
  }
  for (const [id, ids] of Object.entries(draft.trackValues)) {
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
  return Object.keys(saved?.defaults.fields ?? {}).filter(
    (id) => !shown(fields.find((f) => String(f.id) === id)),
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

/**
 * A problem's message. The create route's codes read as they do on the create form (T-291):
 * an archived release or area, one the track does not offer, a value that is gone.
 */
function problemMessage(path: string, code: string): MessageId {
  if (path === 'name' && code === 'taken') return 'tickets.templates.problem.nameTaken';
  if (code === 'track_only') return 'tickets.templates.problem.trackOnly';
  return errorMessage(code);
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
 * it does not show, keeps the general line.
 */
export function saveRefusalOf(error: unknown, draft: TemplateDraft): Refusal {
  const body = error instanceof ApiError && error.status === 400 ? error.body : null;
  const fields = (body as { fields?: Record<string, string> } | null)?.fields;
  if (!fields) return { message: refusalOf(error), at: {} };
  const at: Record<ProblemSpot, MessageId> = {};
  let unplaced = false;
  for (const [path, code] of Object.entries(fields)) {
    const spot = spotOf(path, draft);
    if (spot === null) unplaced = true;
    else at[spot] ??= problemMessage(path, code);
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
