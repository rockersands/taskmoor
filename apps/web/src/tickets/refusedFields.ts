import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { fieldName as seededFieldName } from '../shell/seededNames';
import { WORKFLOW_FIELD_LABELS } from '../workflow/refusal';
import { customId, errorMessage, SYSTEM_FIELDS } from './form';

/**
 * A ticket route's field refusals (`invalid_fields`, CORE-008 (3)) in the words people see
 * (T-292): each field by the label its control has, never the API key the server names it by
 * (`priorityId`, `fields.12`, `close-reason`), with the server's reason for it.
 */

/** Custom field names by id, from a field catalogue the page has read (T-297). */
export type CustomFieldNames = ReadonlyMap<number, string>;

/**
 * Every key the ticket routes name a system field by: the layout's (`priority`), the request
 * body's (`priorityId`), the workflow model's (`close-reason`), and the few the create, edit
 * and move routes name outside the layout.
 */
const LABELS: Readonly<Record<string, MessageId>> = {
  ...WORKFLOW_FIELD_LABELS,
  ...Object.fromEntries(Object.entries(SYSTEM_FIELDS).map(([key, field]) => [key, field.label])),
  ...Object.fromEntries(Object.values(SYSTEM_FIELDS).map((field) => [field.body, field.label])),
  ticketTypeId: 'tickets.create.type',
  statusId: 'ticketView.field.status',
  visibilityLevelId: 'ticketView.field.visibilityLevel',
  track: 'ticketView.field.track',
};

/** A custom field's id from the key a refusal or a layout names it by (`fields.12`, `cf[12]`). */
export function customFieldOf(key: string): number | null {
  const body = /^fields\.(\d+)$/.exec(key);
  return body ? Number(body[1]) : customId(key);
}

/**
 * A field's label from the API key a refusal names it by: a system field in the person's
 * language; a custom one by its name in `custom` (a seeded one translated), else as
 * `unnamedCustom` says it ('A custom field' by default); null for a key that names no field this
 * client knows, which is never shown as it is.
 */
export function refusedFieldLabel(
  t: Translate,
  key: string,
  custom?: CustomFieldNames,
  unnamedCustom: MessageId = 'refusal.field.custom',
): string | null {
  const id = Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
  if (id) return t(id);
  const customField = customFieldOf(key);
  if (customField === null) return null;
  const name = custom?.get(customField);
  return name === undefined ? t(unnamedCustom) : seededFieldName(t, name);
}

/**
 * The sentence for a refusal's fields: "Check these values." and then each field by its label
 * with the server's reason ("Priority: This track does not offer this choice. …"). Null when no
 * field can be named, so the caller says something general instead of showing keys.
 */
export function refusedFieldsMessage(
  t: Translate,
  fields: Readonly<Record<string, string>>,
  custom?: CustomFieldNames,
): string | null {
  const parts: string[] = [];
  for (const [key, code] of Object.entries(fields)) {
    const field = refusedFieldLabel(t, key, custom);
    if (field === null) continue;
    parts.push(t('tickets.create.fieldProblem', { field, problem: t(errorMessage(code)) }));
  }
  return parts.length === 0 ? null : t('ticketView.problem.fields', { fields: parts.join(' ') });
}

/** The keys of the fields a ticket route refused (`invalid_fields`), none for another error. */
export function refusedFieldKeys(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const fields = (error.body as { fields?: unknown } | null)?.fields;
  return fields && typeof fields === 'object' ? Object.keys(fields) : [];
}
