import type { PmJson } from '@taskmoor/richtext';
import { type CustomField, customId, type FormValues, type TicketForm } from './form';
import type { PickedPerson } from './PersonPicker';
import { localDateTime } from './templates/start';

/**
 * The create form's defaults (CORE-009; T-320): each custom field starts with its context's
 * default, as the form model gives it (`GET /tracks/:id/layout`, the REST form of a value), so the
 * form shows what the ticket would get. A field the person empties is sent as null, since the
 * server fills in the default for a field the request leaves out.
 */
export interface FormDefaults {
  values: FormValues;
  docs: Record<string, PmJson | null>;
  picks: Record<string, PickedPerson[]>;
}

export const NO_DEFAULTS: FormDefaults = { values: {}, docs: {}, picks: {} };

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const idOf = (value: unknown): number | null => {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : null;
};

/** One field's default as the form holds it, or nothing when the form cannot show it. */
function fill(field: CustomField, key: string, value: unknown, out: FormDefaults): void {
  switch (field.type) {
    case 'paragraph':
      out.docs[key] = value as PmJson;
      return;
    case 'datetime': {
      const local = localDateTime(String(value));
      if (local !== '') out.values[key] = local;
      return;
    }
    case 'labels':
      out.values[key] = listOf(value).map(String).join(' ');
      return;
    case 'select': {
      // Only options the form offers: one disabled since is left out, as the server leaves it.
      const offered = new Set((field.options ?? []).map((o) => o.id));
      const ids = listOf(value)
        .map(idOf)
        .filter((id): id is number => id !== null && offered.has(id))
        .map(String);
      if (ids.length === 0) return;
      out.values[key] = field.multiple ? ids : (ids[0] as string);
      return;
    }
    case 'cascading-select': {
      const parentId = idOf(value);
      const parent = (field.options ?? []).find((o) => o.id === parentId);
      if (!parent) return;
      out.values[key] = String(parent.id);
      const childId = idOf((value as { child?: unknown }).child);
      if ((parent.children ?? []).some((c) => c.id === childId)) {
        out.values[`${key}/child`] = String(childId);
      }
      return;
    }
    case 'user':
    case 'group':
    case 'team': {
      const people = listOf(value).flatMap((v) => {
        const named = v as { id?: unknown; name?: unknown };
        return typeof named.id === 'number' && typeof named.name === 'string'
          ? [{ id: named.id, name: named.name }]
          : [];
      });
      if (people.length > 0) out.picks[key] = field.multiple ? people : people.slice(0, 1);
      return;
    }
    default:
      out.values[key] = String(value);
  }
}

/** The defaults of the fields `keys` names (the custom fields the form sets), as it holds values. */
export function formDefaults(form: TicketForm, keys: ReadonlySet<string>): FormDefaults {
  const out: FormDefaults = { values: {}, docs: {}, picks: {} };
  for (const key of keys) {
    const id = customId(key);
    const field = id === null ? undefined : form.customFields.find((f) => f.id === id);
    if (!field || field.defaultValue === null || field.defaultValue === undefined) continue;
    fill(field, key, field.defaultValue, out);
  }
  return out;
}

/**
 * Values put over the defaults, as a template or a ticket to start from gives them: a two-level
 * list's default child goes with its default option when the values choose another.
 */
export function overlay(defaults: FormValues, values: FormValues): FormValues {
  const out: FormValues = { ...defaults };
  for (const key of Object.keys(values)) delete out[`${key}/child`];
  return { ...out, ...values };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the form holds once another track or type's defaults replace `prev`: a value still as the
 * old default put it goes, and an empty one takes the new default. What the person typed stays.
 */
export function refill<V>(
  current: Readonly<Record<string, V>>,
  prev: Readonly<Record<string, V>>,
  next: Readonly<Record<string, V>>,
): Record<string, V> {
  const out: Record<string, V> = { ...current };
  for (const [key, value] of Object.entries(prev)) {
    if (key in out && same(out[key], value)) delete out[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (isEmpty(out[key])) out[key] = value;
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return Array.isArray(value) && value.length === 0;
}

/** The fields given a default whose value the person emptied: they are sent as null. */
export function emptiedDefaults(
  defaults: FormDefaults,
  values: FormValues,
  docs: Readonly<Record<string, unknown>>,
  picks: Readonly<Record<string, readonly unknown[]>>,
): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(defaults.values)) {
    if (!key.includes('/') && isEmpty(values[key])) out.add(key);
  }
  for (const key of Object.keys(defaults.docs)) if (isEmpty(docs[key])) out.add(key);
  for (const key of Object.keys(defaults.picks)) if (isEmpty(picks[key])) out.add(key);
  return out;
}
