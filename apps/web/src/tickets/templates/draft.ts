import type { PmJson } from '@taskmoor/richtext';
import { ApiError } from '../../api/client';
import type { MessageId } from '../../i18n/messages.en';
import { splitLabels } from '../form';
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
  subtickets: { summary: string; ticketTypeId: string }[];
}

const asText = (value: number | undefined) => (value === undefined ? '' : String(value));

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
  for (const [id, value] of Object.entries(defaults.fields ?? {})) {
    const field = fields.find((f) => String(f.id) === id);
    if (field && FORM_FIELD_TYPES.has(field.type) && value != null) {
      values[id] = fieldText(field, value);
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
 * The defaults a draft makes. What the form does not show stays as saved: custom fields of types
 * it has no control for, and an assignee on a template for every track.
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
    if (!field || !FORM_FIELD_TYPES.has(field.type)) custom[id] = value;
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

/** How many of a saved template's custom field values the form has no control for. */
export function keptValues(saved: SavedTemplate | null, fields: readonly FieldChoice[]): number {
  return Object.keys(saved?.defaults.fields ?? {}).filter((id) => {
    const field = fields.find((f) => String(f.id) === id);
    return !field || !FORM_FIELD_TYPES.has(field.type);
  }).length;
}

/** A refusal from the API as a message. */
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
