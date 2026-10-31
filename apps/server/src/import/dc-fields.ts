import type { JsonValue } from '@taskmoor/db';
import {
  type FieldConfig,
  type FieldShape,
  type FieldType,
  parseValue,
  TEXT_MAX,
} from '../fields/types';
import { checkLabels } from '../tickets/fields';
import { CASCADE_CHILD_KEY, CUSTOM_FIELD_KEY, SYSTEM_FIELD_TYPES } from './dc-backup/format';
import type {
  StagedContext,
  StagedField,
  StagedLayoutSet,
  StagedOption,
  StagedRuleItem,
  StagedRuleSet,
} from './dc-backup/stage-fields';
import type { StagedValue } from './dc-backup/stage-issues';
import type {
  FieldRuleSetCommand,
  FormField,
  LayoutSetCommand,
  Mapped,
  Ref,
  Warning,
} from './model';

/**
 * The Data Center backup's custom fields and forms in Taskmoor's terms (M1-089; IMP-004;
 * ADR-089): custom fields by type, contexts (field configuration schemes) with their scopes,
 * options with their defaults, field configurations as field rule sets, screens as layout sets,
 * and each issue's custom values in the stored form of `fields/types.ts`. What has no
 * equivalent is left out with a reason or a warning, never silently.
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** The built-in custom field types Taskmoor has a type for, by the key after the prefix. */
const TYPES: Readonly<Record<string, { type: FieldType; multiple?: true; config?: FieldConfig }>> =
  {
    textfield: { type: 'text' },
    textarea: { type: 'paragraph' },
    float: { type: 'number' },
    datepicker: { type: 'date' },
    datetime: { type: 'datetime' },
    select: { type: 'select' },
    multiselect: { type: 'select', multiple: true },
    radiobuttons: { type: 'select', config: { display: 'radio' } },
    multicheckboxes: { type: 'select', multiple: true, config: { display: 'checkboxes' } },
    cascadingselect: { type: 'cascading-select' },
    userpicker: { type: 'user' },
    multiuserpicker: { type: 'user', multiple: true },
    grouppicker: { type: 'group' },
    multigrouppicker: { type: 'group', multiple: true },
    labels: { type: 'labels' },
    url: { type: 'url' },
    readonlyfield: { type: 'read-only-text' },
  };

/** The Taskmoor shape of a backup's custom field type, or null when there is none. */
export function shapeOfType(typeKey: string | null): FieldShape | null {
  if (typeKey === null || !typeKey.startsWith(SYSTEM_FIELD_TYPES)) return null;
  const t = TYPES[typeKey.slice(SYSTEM_FIELD_TYPES.length)];
  return t ? { type: t.type, multiple: t.multiple === true, config: t.config ?? {} } : null;
}

/** A field of an app without an importer: read-only text holding its raw values (spec 02a). */
const APP_FIELD: FieldShape = { type: 'read-only-text', multiple: false, config: {} };
const isAppField = (typeKey: string | null) =>
  typeKey !== null && typeKey !== '' && shapeOfType(typeKey) === null;

/** What a backup field becomes: its type's shape, read-only text for an app's, or nothing. */
export function targetShape(typeKey: string | null): FieldShape | null {
  return shapeOfType(typeKey) ?? (isAppField(typeKey) ? APP_FIELD : null);
}

export function mapField(f: StagedField): Mapped {
  const shape = targetShape(f.typeKey);
  if (!shape) return { skip: 'unknown_field_type' };
  const warnings: Warning[] = isAppField(f.typeKey)
    ? [{ code: 'app_field_as_read_only_text', detail: f.typeKey }]
    : [];
  return {
    command: {
      kind: 'field',
      name: f.name,
      description: f.description,
      type: shape.type,
      multiple: shape.multiple,
      config: shape.config as Record<string, JsonValue>,
      track: null,
    },
    warnings,
  };
}

/** A default value stored as `<type>value</type>`, read for the field's shape. */
function defaultOf(shape: FieldShape, xml: string): JsonValue | undefined {
  const m = /^\s*<(string|double|long|date|timestamp)>([\s\S]*)<\/\1>\s*$/.exec(xml);
  if (!m) return undefined;
  const text = (m[2] as string).trim();
  const input =
    shape.type === 'number' ? Number(text) : shape.type === 'paragraph' ? plainDoc(text) : text;
  const parsed = parseValue(shape, input);
  return parsed.ok ? (parsed.value as JsonValue | undefined) : undefined;
}

export function mapContext(c: StagedContext): Mapped {
  const shape = targetShape(c.fieldType);
  if (!shape) return { skip: 'field_not_imported' };
  const warnings: Warning[] = c.droppedScopes.map((d) => ({
    code: 'context_scope_not_imported',
    detail: d,
  }));
  // A context that lost every project or type it had would apply more widely: refused.
  if (
    (c.projects !== null && c.projects.length === 0) ||
    (c.types !== null && c.types.length === 0)
  ) {
    return { fail: 'context_scope_not_imported', warnings };
  }
  const scopes: { track: Ref | null; type: Ref | null }[] = [];
  for (const p of c.projects ?? [null]) {
    for (const t of c.types ?? [null]) {
      scopes.push({
        track: p === null ? null : ref('track', p),
        type: t === null ? null : ref('ticket_type', t),
      });
    }
  }
  let defaultValue: JsonValue | null = null;
  const options = shape.type === 'select' || shape.type === 'cascading-select';
  if (c.defaultXml !== null && !options) {
    const value = defaultOf(shape, c.defaultXml);
    if (value === undefined) warnings.push({ code: 'default_not_imported', detail: c.field });
    else defaultValue = value;
  }
  return {
    command: {
      kind: 'field_context',
      field: ref('field', c.field),
      name: c.name,
      description: c.description,
      defaultValue,
      config: {},
      scopes,
    },
    warnings,
  };
}

export function mapOption(o: StagedOption): Mapped {
  const shape = targetShape(o.fieldType);
  if (!shape) return { skip: 'field_not_imported' };
  if (shape.type !== 'select' && shape.type !== 'cascading-select') {
    return { skip: 'field_has_no_options' };
  }
  if (o.context === null) return { fail: 'option_without_context' };
  return {
    command: {
      kind: 'field_option',
      context: ref('field_context', o.context),
      parent: o.parent === null ? null : ref('field_option', o.parent),
      value: o.value,
      sortOrder: o.sequence,
      disabled: o.disabled,
      ...(o.isDefault ? { default: true } : {}),
    },
  };
}

/**
 * The backup's system field ids to the fields rules and layouts name (`fields/form-model.ts`).
 * Time tracking is one field there and two here.
 */
const SYSTEM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  summary: ['summary'],
  description: ['description'],
  environment: ['environment'],
  assignee: ['assignee'],
  reporter: ['requester'],
  priority: ['priority'],
  resolution: ['closeReason'],
  labels: ['labels'],
  duedate: ['dueDate'],
  fixVersions: ['targetRelease'],
  versions: ['foundInRelease'],
  components: ['area'],
  timeoriginalestimate: ['originalEstimate'],
  timeestimate: ['remainingEstimate'],
  timetracking: ['originalEstimate', 'remainingEstimate'],
};

/** Fields every Taskmoor form has on its own: leaving them out is no loss. */
const BUILT_IN = new Set(['issuetype', 'project']);

/** The form fields a backup field id stands for; empty when it has none. */
function formFields(id: string): FormField[] {
  const custom = CUSTOM_FIELD_KEY.exec(id);
  if (custom) return [{ custom: ref('field', custom[1] as string) }];
  return (SYSTEM_FIELDS[id] ?? []).map((key) => ({ key }));
}

/** Each warning once per record. */
const unique = (warnings: Warning[]): Warning[] => {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}\u0000${w.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const said = (i: StagedRuleItem) => i.required || i.hidden || i.description !== null;
const same = (a: StagedRuleItem | undefined, b: StagedRuleItem | undefined) =>
  (a?.required ?? false) === (b?.required ?? false) &&
  (a?.hidden ?? false) === (b?.hidden ?? false) &&
  (a?.description ?? null) === (b?.description ?? null);

export function mapRuleSet(s: StagedRuleSet): Mapped {
  const warnings: Warning[] = s.missingLayouts.map((m) => ({
    code: 'field_rules_not_found',
    detail: m,
  }));
  const rules: FieldRuleSetCommand['rules'] = [];
  const general = s.entities.find((e) => e.type === null);
  const generalItems = new Map((general?.items ?? []).map((i) => [i.field, i]));
  for (const e of s.entities) {
    const items = new Map(e.items.map((i) => [i.field, i]));
    // Every type gets the general rules; a type's own configuration says where it differs,
    // including a field it shows that the general one hides.
    const fields =
      e.type === null
        ? [...items.values()].filter(said).map((i) => i.field)
        : [...new Set([...items.keys(), ...generalItems.keys()])].filter(
            (f) => !same(items.get(f), generalItems.get(f)),
          );
    for (const field of fields) {
      const item = items.get(field) ?? { field, required: false, hidden: false, description: null };
      if (field === 'summary' || BUILT_IN.has(field)) continue;
      const targets = formFields(field);
      if (targets.length === 0) {
        if (said(item) || e.type !== null) {
          warnings.push({ code: 'field_rule_not_mapped', detail: field });
        }
        continue;
      }
      for (const target of targets) {
        rules.push({
          type: e.type === null ? null : ref('ticket_type', e.type),
          field: target,
          required: item.required && !item.hidden,
          hidden: item.hidden,
          description: item.description,
        });
      }
    }
  }
  return {
    command: {
      kind: 'field_rule_set',
      name: s.name,
      description: s.description,
      rules,
      tracks: s.tracks.map((t) => ref('track', t)),
    },
    warnings: unique(warnings),
  };
}

export function mapLayoutSet(s: StagedLayoutSet): Mapped {
  const warnings: Warning[] = [];
  const layouts: LayoutSetCommand['layouts'] = [];
  for (const e of s.entities) {
    for (const { operation, screen } of e.screens) {
      if (screen === null) {
        warnings.push({ code: 'screen_not_found', detail: `${e.screenScheme}:${operation}` });
        continue;
      }
      layouts.push({
        type: e.type === null ? null : ref('ticket_type', e.type),
        operation,
        tabs: screen.tabs.map((t) => ({
          name: t.name,
          fields: t.fields.flatMap((id) => {
            const fields = formFields(id);
            if (fields.length === 0 && !BUILT_IN.has(id)) {
              warnings.push({ code: 'layout_field_not_mapped', detail: id });
            }
            return fields;
          }),
        })),
        // A screen shows what is on it and nothing else.
        others: 'omit',
      });
    }
  }
  return {
    command: {
      kind: 'layout_set',
      name: s.name,
      description: s.description,
      layouts,
      tracks: s.tracks.map((t) => ref('track', t)),
    },
    warnings: unique(warnings),
  };
}

/** Plain text as a rich text document: a paragraph per block, line breaks kept. */
export function plainDoc(text: string): JsonValue {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
  return {
    type: 'doc',
    content: (blocks.length === 0 ? [''] : blocks).map((block) => {
      const content: JsonValue[] = [];
      for (const [k, line] of block.split('\n').entries()) {
        if (k > 0) content.push({ type: 'hardBreak' });
        if (line !== '') content.push({ type: 'text', text: line });
      }
      return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
    }),
  };
}

/** A backup time (`YYYY-MM-DD HH:MM:SS.fff`, read as UTC) as an ISO instant. */
export function instantOf(time: string | null): string | null {
  if (time === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(time.trim());
  if (!m) return null;
  const ms = (m[3] ?? '.000').slice(0, 4).padEnd(4, '0');
  const at = new Date(`${m[1]}T${m[2]}${ms}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

const asId = (s: string | null): number | null =>
  s !== null && /^\d+$/.test(s) ? Number(s) : null;

/**
 * An issue's custom values in stored form, keyed by the backup's field id, references by
 * source id (options by their id, people and groups by their staged id), for the ticket
 * loader to map. A value of a field the import leaves out, or one Taskmoor cannot hold, is
 * dropped with a warning naming the field.
 */
export function storedValues(values: readonly StagedValue[], warnings: Warning[]) {
  const out: Record<string, JsonValue> = {};
  for (const v of values) {
    const shape = targetShape(v.type);
    if (!shape) {
      warnings.push({ code: 'field_value_not_imported', detail: v.field });
      continue;
    }
    const value = isAppField(v.type) ? rawValue(v, warnings) : storedValue(shape, v);
    if (value === undefined) {
      warnings.push({ code: 'invalid_field_value', detail: v.field });
      continue;
    }
    if (value !== null) out[v.field] = value;
  }
  return out;
}

/** An app field's values as one line of text, as stored, cut to what a text value holds. */
function rawValue(v: StagedValue, warnings: Warning[]): JsonValue | null {
  const parts = [
    ...v.rows.map(
      (r) => r.string ?? (r.number === null ? null : String(r.number)) ?? r.text ?? r.date,
    ),
    ...(v.labels ?? []),
  ].flatMap((p) => (p === null ? [] : [p.replace(/\s+/g, ' ').trim()]));
  const text = parts.filter((p) => p !== '').join(', ');
  if (text === '') return null;
  if ([...text].length > TEXT_MAX) {
    warnings.push({ code: 'raw_value_cut', detail: v.field });
    return [...text].slice(0, TEXT_MAX).join('').trim();
  }
  return text;
}

/** One value: undefined when it cannot be held, null when it is empty. */
function storedValue(shape: FieldShape, v: StagedValue): JsonValue | null | undefined {
  const first = v.rows[0];
  const parse = (input: unknown) => {
    const parsed = parseValue(shape, input);
    if (!parsed.ok) return undefined;
    return parsed.value === undefined ? null : (parsed.value as JsonValue);
  };
  switch (shape.type) {
    case 'text':
    case 'url':
    case 'read-only-text':
      return parse(first?.string ?? first?.text ?? null);
    case 'paragraph': {
      const text = first?.text ?? first?.string ?? null;
      return text === null ? null : parse(plainDoc(text));
    }
    case 'number':
      return first?.number === null || first?.number === undefined ? null : parse(first.number);
    case 'date':
      return first?.date ? parse(first.date.trim().slice(0, 10)) : null;
    case 'datetime':
      return first?.date ? parse(instantOf(first.date)) : null;
    case 'select': {
      const ids = v.rows.map((r) => asId(r.string));
      if (ids.some((id) => id === null)) return undefined;
      const sorted = [...new Set(ids as number[])].sort((a, b) => a - b);
      if (sorted.length === 0) return null;
      return shape.multiple ? sorted : (sorted[0] as number);
    }
    case 'cascading-select': {
      const parent = asId(v.rows.find((r) => r.parentKey === null)?.string ?? null);
      const childRow = v.rows.find((r) => r.parentKey === CASCADE_CHILD_KEY);
      const child = childRow ? asId(childRow.string) : null;
      if (parent === null) return v.rows.length === 0 ? null : undefined;
      return child === null ? [parent] : [parent, child];
    }
    case 'user':
    case 'group': {
      const ids = [...new Set(v.rows.flatMap((r) => (r.string ? [r.string] : [])))];
      if (ids.length === 0) return null;
      return shape.multiple ? ids : (ids[0] as string);
    }
    case 'labels': {
      const labels = v.labels ?? v.rows.flatMap((r) => (r.string ? [r.string] : []));
      if (labels.length === 0) return null;
      const checked = checkLabels(labels);
      return checked.ok ? checked.labels : undefined;
    }
    default:
      return undefined;
  }
}
