import type { PmJson } from '@taskmoor/richtext';
import type { MessageId } from '../../i18n/messages.en';
import { lockOfField } from '../../locks/useLockText';
import {
  type CustomField,
  customId,
  EDITABLE_CUSTOM,
  EDITABLE_SYSTEM,
  type FormValues,
  SYSTEM_FIELDS,
  type TicketForm,
} from '../form';

/**
 * A template's starting values on the create form (CORE-030; ADR-113). The form shows what it can
 * edit, so the person can review it. What the backend will refuse for them (a field a rule hides,
 * off the layout, locked) is not shown at all: it stays out of the body, the backend leaves it out
 * and says so. The only values kept out of view are those on the layout with no control here
 * (people, areas, releases), which the picker lists so that they can be turned off.
 */
export interface FormFill {
  values: FormValues;
  docs: Record<string, PmJson | null>;
  /** Body keys the template sets that this form shows but cannot edit. */
  extras: string[];
}

const fieldKeyOf = (bodyKey: string): string | null =>
  Object.entries(SYSTEM_FIELDS).find(([, f]) => f.body === bodyKey)?.[0] ?? null;

function onLayout(form: TicketForm): Set<string> {
  return new Set(
    form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key))),
  );
}

function customField(form: TicketForm, id: number): CustomField | undefined {
  return form.customFields.find((f) => f.id === id);
}

function editableCustom(field: CustomField | undefined): boolean {
  return field !== undefined && EDITABLE_CUSTOM.has(field.type);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as a local date and time, as `datetime-local` takes it. */
function localDateTime(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A custom field's stored value as the form holds it. */
function fillCustom(field: CustomField, key: string, value: unknown, fill: FormFill): void {
  switch (field.type) {
    case 'paragraph':
      fill.docs[key] = value as PmJson;
      return;
    case 'select':
      if (Array.isArray(value)) fill.values[key] = value.map(String);
      else fill.values[key] = String(value);
      return;
    case 'cascading-select': {
      const chosen = value as { parent?: unknown; child?: unknown };
      if (chosen.parent != null) fill.values[key] = String(chosen.parent);
      if (chosen.child != null) fill.values[`${key}/child`] = String(chosen.child);
      return;
    }
    case 'labels':
      fill.values[key] = Array.isArray(value) ? value.join(' ') : String(value);
      return;
    case 'datetime':
      fill.values[key] = localDateTime(String(value));
      return;
    default:
      fill.values[key] = String(value);
  }
}

/** The form's values from a template's `start`, for one laid-out form. */
export function fillForm(start: Record<string, unknown>, form: TicketForm): FormFill {
  const fill: FormFill = { values: {}, docs: {}, extras: [] };
  const shown = onLayout(form);
  const free = (key: string) => shown.has(key) && lockOfField(form.locks, key) === null;
  for (const [bodyKey, value] of Object.entries(start)) {
    if (bodyKey === 'fields') {
      for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
        const key = `cf[${id}]`;
        if (!free(key)) continue;
        const field = customField(form, Number(id));
        if (field && editableCustom(field)) fillCustom(field, key, v, fill);
        else fill.extras.push(`fields.${id}`);
      }
      continue;
    }
    const key = fieldKeyOf(bodyKey);
    if (key === null || !free(key)) continue;
    if (!EDITABLE_SYSTEM.has(key)) fill.extras.push(bodyKey);
    else if (key === 'description' || key === 'environment') fill.docs[key] = value as PmJson;
    else if (key === 'labels') fill.values[key] = (value as string[]).join(' ');
    else fill.values[key] = String(value);
  }
  return fill;
}

/**
 * The template's values to leave out when the ticket is made: those the person cleared on the
 * form, and those they turned off in the picker's list. A body that lacks a value otherwise takes
 * the template's.
 */
export function omitKeys(
  start: Record<string, unknown>,
  form: TicketForm,
  body: Record<string, unknown>,
  turnedOff: ReadonlySet<string>,
): string[] {
  const out = new Set(turnedOff);
  const shown = onLayout(form);
  const free = (key: string) => shown.has(key) && lockOfField(form.locks, key) === null;
  const given = (body.fields ?? {}) as Record<string, unknown>;
  for (const [bodyKey, value] of Object.entries(start)) {
    if (bodyKey === 'fields') {
      for (const id of Object.keys(value as Record<string, unknown>)) {
        const editable = editableCustom(customField(form, Number(id)));
        if (free(`cf[${id}]`) && editable && !(id in given)) out.add(`fields.${id}`);
      }
      continue;
    }
    const key = fieldKeyOf(bodyKey);
    if (key !== null && free(key) && EDITABLE_SYSTEM.has(key) && !(bodyKey in body)) {
      out.add(bodyKey);
    }
  }
  return [...out];
}

/**
 * A body key as people call it: a message for a system field, a name for a custom field the form
 * knows. A custom field off this form has no name here, only its number.
 */
export function labelOfKey(
  bodyKey: string,
  form: TicketForm | null,
): { id: MessageId } | { name: string } | { fieldId: string } {
  const custom = customId(`cf[${bodyKey.replace(/^fields\./, '')}]`);
  if (bodyKey.startsWith('fields.') && custom !== null) {
    const name = form?.customFields.find((f) => f.id === custom)?.name;
    return name ? { name } : { fieldId: String(custom) };
  }
  const key = fieldKeyOf(bodyKey);
  const system = key ? SYSTEM_FIELDS[key] : undefined;
  return system ? { id: system.label } : { name: bodyKey };
}
