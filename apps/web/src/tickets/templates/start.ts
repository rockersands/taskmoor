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
import type { Named } from './client';

/**
 * A template's starting values on the create form (CORE-030; ADR-113). The form shows what it can
 * edit, so the person can review it. What the backend will refuse for them (a field a rule hides,
 * off the layout, locked) is not shown at all: it stays out of the body, the backend leaves it out
 * and says so. The template's assignee, releases and areas fill the form's pickers in when it
 * has them (T-265), and so do its custom person, group, team, release and area values (T-276),
 * so a value chosen there takes the template's place. The values kept out of view are those on
 * the layout with no control here, releases or areas the picker does not offer (archived since,
 * or a list that did not load), and people, groups or teams the template start could not name
 * for this person (one they may not see): the template picker lists them so that they can be
 * turned off.
 */
export interface FormFill {
  values: FormValues;
  docs: Record<string, PmJson | null>;
  /** People the template chose, by field key, for the form's person pickers. */
  picks: Record<string, Named[]>;
  /** Body keys the template sets that this form shows but cannot edit. */
  extras: string[];
  /** Body keys whose values went into the form's pickers. */
  picked: string[];
}

/**
 * What the form's pickers can take from a template: their field keys (custom ones as `cf[12]`),
 * who it assigns, the ids each release or area picker offers, by field key (absent while its
 * list loads), and the names of the people, groups and teams its custom values name, by body
 * key, as the template start gave them (T-276).
 */
export interface TemplatePickers {
  keys: ReadonlySet<string>;
  assignee: Named | null;
  offered?: Readonly<Record<string, readonly number[]>>;
  names?: Readonly<Record<string, readonly Named[]>>;
}

/** System fields a template fills into a picker: the assignee, releases and areas. */
const ID_LIST_KEYS = new Set(['targetRelease', 'foundInRelease', 'area']);
/** Custom field types whose values a picker shows by name: people, groups and teams. */
const NAMED_CUSTOM = new Set(['user', 'group', 'team']);
/** Custom field types whose values come from the track's lists: releases and areas. */
const LISTED_CUSTOM = new Set(['release', 'area']);

const fieldKeyOf = (bodyKey: string): string | null =>
  Object.entries(SYSTEM_FIELDS).find(([, f]) => f.body === bodyKey)?.[0] ?? null;

function onLayout(form: TicketForm): Set<string> {
  return new Set(
    form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key))),
  );
}

/**
 * Whether the person may set a field here: on the layout, not locked to others, and not one their
 * permissions withhold at create (IAM-010). Others are left out and the backend reports them.
 */
function settable(form: TicketForm, shown: ReadonlySet<string>, key: string): boolean {
  return shown.has(key) && lockOfField(form.locks, key) === null && !form.withheld?.includes(key);
}

function customField(form: TicketForm, id: number): CustomField | undefined {
  return form.customFields.find((f) => f.id === id);
}

function editableCustom(field: CustomField | undefined): boolean {
  return field !== undefined && EDITABLE_CUSTOM.has(field.type);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as a local date and time, as `datetime-local` takes it. */
export function localDateTime(value: string): string {
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

/**
 * Puts a template's value into the picker of `key`, as the form holds it; false when no picker
 * takes it. The assignee needs the person's name, which the template gives with its id. Releases
 * and areas go in only when the picker offers every one of them: one it does not list (archived
 * since the template was saved) would be sent without a checkbox to see or untick it.
 */
function pickedValue(
  key: string,
  value: unknown,
  pickers: TemplatePickers,
  fill: FormFill,
): boolean {
  if (!pickers.keys.has(key)) return false;
  if (key === 'assignee') {
    const person = pickers.assignee;
    if (!person || person.id !== value) return false;
    fill.picks.assignee = [{ id: person.id, name: person.name }];
    return true;
  }
  if (!ID_LIST_KEYS.has(key) || !Array.isArray(value)) return false;
  const offered = pickers.offered?.[key];
  if (!offered || !value.every((id) => offered.includes(Number(id)))) return false;
  fill.values[key] = value.map(String);
  return true;
}

/**
 * Puts a template's custom person, group, team, release or area value into the picker of `key`
 * (T-276); false when it cannot. People, groups and teams go in only when the template start
 * named every one of them for this person: one they may not see has no name, and is left in
 * the list. Releases and areas go in only when the picker offers every one, as for the system
 * fields. A field that holds one value takes one.
 */
function pickedCustom(
  field: CustomField,
  key: string,
  value: unknown,
  pickers: TemplatePickers,
  fill: FormFill,
): boolean {
  if (!pickers.keys.has(key)) return false;
  const ids = (Array.isArray(value) ? value : [value]).map(Number);
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) return false;
  if (!field.multiple && ids.length > 1) return false;
  if (NAMED_CUSTOM.has(field.type)) {
    const named = pickers.names?.[`fields.${field.id}`] ?? [];
    const chosen = ids.map((id) => named.find((n) => n.id === id));
    if (chosen.some((n) => n === undefined)) return false;
    fill.picks[key] = (chosen as Named[]).map((n) => ({ id: n.id, name: n.name }));
    return true;
  }
  if (!LISTED_CUSTOM.has(field.type)) return false;
  const offered = pickers.offered?.[key];
  if (!offered || !ids.every((id) => offered.includes(id))) return false;
  fill.values[key] = field.multiple ? ids.map(String) : String(ids[0]);
  return true;
}

/**
 * The form's values from a template's `start`, for one laid-out form; `pickers` says which of
 * the form's pickers can take the template's people, groups, teams, releases and areas (none by
 * default).
 */
export function fillForm(
  start: Record<string, unknown>,
  form: TicketForm,
  pickers: TemplatePickers = { keys: new Set(), assignee: null },
): FormFill {
  const fill: FormFill = { values: {}, docs: {}, picks: {}, extras: [], picked: [] };
  const shown = onLayout(form);
  const free = (key: string) => settable(form, shown, key);
  for (const [bodyKey, value] of Object.entries(start)) {
    if (bodyKey === 'fields') {
      for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
        const key = `cf[${id}]`;
        if (!free(key)) continue;
        const field = customField(form, Number(id));
        if (field && editableCustom(field)) fillCustom(field, key, v, fill);
        else if (field && pickedCustom(field, key, v, pickers, fill)) {
          fill.picked.push(`fields.${id}`);
        } else fill.extras.push(`fields.${id}`);
      }
      continue;
    }
    const key = fieldKeyOf(bodyKey);
    if (key === null || !free(key)) continue;
    if (pickedValue(key, value, pickers, fill)) fill.picked.push(bodyKey);
    else if (!EDITABLE_SYSTEM.has(key)) fill.extras.push(bodyKey);
    else if (key === 'description' || key === 'environment') fill.docs[key] = value as PmJson;
    else if (key === 'labels') fill.values[key] = (value as string[]).join(' ');
    else fill.values[key] = String(value);
  }
  return fill;
}

/**
 * The template's values to leave out when the ticket is made: those the person cleared on the
 * form or in its pickers (`picked`, the body keys `fillForm` put there), and those they turned
 * off in the picker's list. A body that lacks a value otherwise takes the template's.
 */
export function omitKeys(
  start: Record<string, unknown>,
  form: TicketForm,
  body: Record<string, unknown>,
  turnedOff: ReadonlySet<string>,
  picked: readonly string[] = [],
): string[] {
  const out = new Set(turnedOff);
  const shown = onLayout(form);
  const free = (key: string) => settable(form, shown, key);
  const given = (body.fields ?? {}) as Record<string, unknown>;
  for (const [bodyKey, value] of Object.entries(start)) {
    if (bodyKey === 'fields') {
      for (const id of Object.keys(value as Record<string, unknown>)) {
        const formHeld =
          editableCustom(customField(form, Number(id))) || picked.includes(`fields.${id}`);
        if (free(`cf[${id}]`) && formHeld && !(id in given)) out.add(`fields.${id}`);
      }
      continue;
    }
    const key = fieldKeyOf(bodyKey);
    const formHeld = key !== null && (EDITABLE_SYSTEM.has(key) || picked.includes(bodyKey));
    if (key !== null && free(key) && formHeld && !(bodyKey in body)) out.add(bodyKey);
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
