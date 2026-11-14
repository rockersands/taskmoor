import type { MessageId } from '../i18n/messages.en';
import type { Lock } from '../locks/useLockText';

/**
 * The create form's data (M1-012; CORE-008, CORE-013): the layout the backend resolves for a
 * ticket type in a track, the values typed into it, the request body they make, and the
 * backend's field-level refusals mapped back onto the form.
 */

/** A field on the form, as `GET /api/v1/tracks/:id/layout` gives it. */
export interface FormField {
  key: string;
  required: boolean;
  description: string | null;
}
export interface FormSection {
  kind: 'main' | 'context';
  hideWhenEmpty: boolean;
  fields: FormField[];
}
export interface FormTab {
  name: string | null;
  sections: FormSection[];
}
export interface Option {
  id: number;
  value: string;
  children?: Option[];
}
/** A custom field the form shows, with what its context offers. */
export interface CustomField {
  id: number;
  name: string;
  description: string;
  type: string;
  multiple: boolean;
  options?: Option[];
  /**
   * A person field whose context offers only a group's or a track role's people (CORE-009 (2)):
   * its picker asks the field for them. Absent in older fixtures.
   */
  restricted?: boolean;
}
export interface TicketForm {
  layout: { operation: string; tabs: FormTab[] };
  customFields: CustomField[];
  /** What the person may not set here, and why (M1-029); absent in older fixtures. */
  locks?: Lock[];
  /** The track's priority set: what a new ticket takes, and what it offers (CORE-014 (2)). */
  priorities?: { defaultId: number | null; offered: number[] };
  /**
   * Fields of a create form the person lacks the track permission to set (Assign tickets,
   * Schedule tickets and so on; IAM-010). Absent in older fixtures and other operations.
   */
  withheld?: string[];
}

/** System fields: the key rules and layouts use, and the body key that writes it. */
export const SYSTEM_FIELDS: Readonly<Record<string, { body: string; label: MessageId }>> = {
  summary: { body: 'summary', label: 'workflow.field.summary' },
  description: { body: 'description', label: 'workflow.field.description' },
  environment: { body: 'environment', label: 'workflow.field.environment' },
  assignee: { body: 'assigneeId', label: 'workflow.field.assignee' },
  requester: { body: 'requesterId', label: 'workflow.field.requester' },
  parent: { body: 'parent', label: 'workflow.field.parent' },
  priority: { body: 'priorityId', label: 'workflow.field.priority' },
  closeReason: { body: 'closeReasonId', label: 'workflow.field.closeReason' },
  labels: { body: 'labels', label: 'workflow.field.labels' },
  startDate: { body: 'startDate', label: 'workflow.field.startDate' },
  dueDate: { body: 'dueDate', label: 'workflow.field.dueDate' },
  targetRelease: { body: 'targetReleaseIds', label: 'workflow.field.targetRelease' },
  foundInRelease: { body: 'foundInReleaseIds', label: 'workflow.field.foundInRelease' },
  area: { body: 'areaIds', label: 'workflow.field.area' },
  originalEstimate: { body: 'originalEstimate', label: 'workflow.field.originalEstimate' },
  remainingEstimate: { body: 'remainingEstimate', label: 'workflow.field.remainingEstimate' },
};

/** The system fields this form edits; the others are set on the ticket once it exists. */
export const EDITABLE_SYSTEM = new Set([
  'summary',
  'description',
  'environment',
  'priority',
  'labels',
  'startDate',
  'dueDate',
  'originalEstimate',
  'remainingEstimate',
]);
/**
 * System fields this form sets with a picker (T-253, T-265): people, the parent, releases and
 * areas. A ticket template's assignee, releases and areas fill these pickers in (`fillForm`).
 */
export const PICKED_SYSTEM = new Set([
  'assignee',
  'requester',
  'parent',
  'targetRelease',
  'foundInRelease',
  'area',
]);
/** Custom field types this form sets with a picker: people, groups, teams, releases, areas. */
export const PICKED_CUSTOM = new Set(['user', 'group', 'team', 'release', 'area']);
/** Fields whose value is one id: people and the parent. */
const ID_VALUES = new Set(['assignee', 'requester', 'parent']);
/** Fields whose values are lists of ids: releases and areas. */
const ID_LISTS = new Set(['targetRelease', 'foundInRelease', 'area']);

/** Custom field types this form edits. */
export const EDITABLE_CUSTOM = new Set([
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'select',
  'cascading-select',
  'labels',
  'url',
]);

const CUSTOM_KEY = /^cf\[(\d+)\]$/;
export function customId(key: string): number | null {
  const m = CUSTOM_KEY.exec(key);
  return m ? Number(m[1]) : null;
}

/** What has been typed or chosen, by field key; a cascade's child is under `${key}/child`. */
export type FormValues = Record<string, string | string[]>;

/** Plain text as a rich text document: one paragraph a line; null when there is no text. */
export function textDocument(text: string): unknown {
  if (text.trim() === '') return null;
  return {
    type: 'doc',
    content: text
      .split('\n')
      .map((line) =>
        line === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  };
}

/** Labels as typed: a label holds no spaces (CORE-016), so spaces and commas both separate. */
export const splitLabels = (text: string) => text.split(/[\s,]+/).filter((w) => w !== '');

/** The value a custom field takes from what was typed; undefined for nothing. */
function customValue(
  field: CustomField,
  values: FormValues,
  key: string,
  rich: Readonly<Record<string, unknown>>,
): unknown {
  if (field.type === 'paragraph' && key in rich) return rich[key] ?? undefined;
  const raw = values[key];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.length === 0 ? undefined : raw.map(Number);
  if (raw.trim() === '') return undefined;
  switch (field.type) {
    case 'paragraph':
      return textDocument(raw) ?? undefined;
    case 'datetime':
      // A local date and time from the browser, sent as the instant it names.
      return new Date(raw).toISOString();
    case 'select':
    case 'user':
    case 'group':
    case 'team':
    case 'release':
    case 'area':
      return Number(raw);
    case 'cascading-select': {
      const child = values[`${key}/child`];
      return {
        parent: Number(raw),
        ...(typeof child === 'string' && child !== '' ? { child: Number(child) } : {}),
      };
    }
    case 'labels':
      return splitLabels(raw);
    default:
      return raw;
  }
}

/**
 * The create request a form makes: values left empty are not sent. Rich text fields come as
 * the editor's documents (`rich`, by field key; null when empty), or as plain text in `values`.
 */
export function createBody(
  track: string,
  ticketTypeId: number,
  form: TicketForm,
  values: FormValues,
  rich: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { track, ticketTypeId };
  const custom: Record<string, unknown> = {};
  for (const key of form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields))) {
    const id = customId(key.key);
    if (id !== null) {
      const field = form.customFields.find((f) => f.id === id);
      const value = field ? customValue(field, values, key.key, rich) : undefined;
      if (value !== undefined) custom[id] = value;
      continue;
    }
    const name = SYSTEM_FIELDS[key.key]?.body ?? key.key;
    if ((key.key === 'description' || key.key === 'environment') && key.key in rich) {
      const doc = rich[key.key];
      if (doc != null) body[name] = doc;
      continue;
    }
    const raw = values[key.key];
    if (ID_LISTS.has(key.key)) {
      // Releases and areas: the ids chosen, none sent when none is.
      if (Array.isArray(raw) && raw.length > 0) body[name] = raw.map(Number);
      continue;
    }
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (ID_VALUES.has(key.key)) body[name] = Number(raw);
    else if (key.key === 'description' || key.key === 'environment') body[name] = textDocument(raw);
    else if (key.key === 'labels') body[name] = splitLabels(raw);
    else if (key.key === 'priority') body[name] = Number(raw);
    else body[name] = key.key === 'summary' ? raw : raw.trim();
  }
  if (Object.keys(custom).length > 0) body.fields = custom;
  return body;
}

/** The backend's field refusals (`invalid_fields`), by field key. */
export function fieldErrors(fields: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [body, code] of Object.entries(fields ?? {})) {
    const custom = /^fields\.(\d+)$/.exec(body);
    const key = custom
      ? `cf[${custom[1]}]`
      : (Object.entries(SYSTEM_FIELDS).find(([, f]) => f.body === body)?.[0] ?? body);
    out[key] = code;
  }
  return out;
}

const ERRORS: Record<string, MessageId> = {
  required: 'tickets.error.required',
  hidden: 'tickets.error.hidden',
  not_on_layout: 'tickets.error.notOnLayout',
  invalid: 'tickets.error.invalid',
  too_long: 'tickets.error.tooLong',
  too_many: 'tickets.error.tooMany',
  out_of_range: 'tickets.error.outOfRange',
  not_found: 'tickets.error.notFound',
  not_allowed: 'tickets.error.notAllowed',
  disabled_option: 'tickets.error.disabledOption',
  read_only: 'tickets.error.readOnly',
  not_assignable: 'tickets.error.notAssignable',
  wrong_level: 'tickets.error.wrongLevel',
  other_track: 'tickets.error.otherTrack',
  // A release or area archived since it was offered (the create route's placement check; T-276).
  archived: 'tickets.error.archived',
};
export const errorMessage = (code: string): MessageId => ERRORS[code] ?? 'tickets.error.other';
