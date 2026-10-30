import type { JsonValue } from '@taskmoor/db';
import { type FieldShape, REFERENCE_OF, type Reference } from '../fields/types';
import { canonicalJson } from '../tickets/model';
import type { EntityKind, Ref } from './model';

/**
 * Ids inside stored values (M1-098; IMP-014). Taskmoor keeps references to other objects
 * inside some values: custom values (options, people, groups, releases, areas), history entries
 * (ids as text, and `cf[<field id>]` as the field), rich text (mentions), workflow definitions
 * and formula expressions. The export writes these values as stored, with the source's ids; an
 * import maps every id to the target's through an `IdMap`, and the round-trip check maps the
 * target's ids back to the source's with the same walkers, so both directions agree by
 * construction.
 *
 * An id the map does not know is never kept as it is (it would name an unrelated object on the
 * other side): a single reference becomes empty, a list loses it, a mention keeps its label
 * only. `unmapped` counts them.
 */
export interface IdMap {
  /** The id on the other side, or null when it has none. */
  id(kind: EntityKind, id: string): string | null;
  /** A custom field's shape by its id on the side being read; undefined when unknown. */
  field(id: string): Pick<FieldShape, 'type' | 'multiple'> | undefined;
  /** Called for every id that did not map, with where it was. */
  unmapped?(kind: EntityKind, where: string): void;
}

/** The kind a custom field's reference names. */
export const KIND_OF_REFERENCE: Readonly<Record<Reference, EntityKind>> = {
  option: 'field_option',
  user: 'user',
  group: 'group',
  release: 'release',
  area: 'area',
};

const DIGITS = /^[1-9][0-9]{0,18}$/;
const CUSTOM = /^cf\[([1-9][0-9]{0,9})\]$/;

function one(map: IdMap, kind: EntityKind, id: string, where: string): string | null {
  const out = map.id(kind, id);
  if (out === null) map.unmapped?.(kind, where);
  return out;
}

/** A custom field's history and query name with its id mapped, or null for an unknown field. */
export function remapFieldName(name: string, map: IdMap, where = 'field'): string | null {
  const custom = CUSTOM.exec(name);
  if (!custom) return name;
  const id = one(map, 'field', custom[1] as string, where);
  return id === null ? null : `cf[${id}]`;
}

/**
 * A rich text document with the people and teams its mentions name mapped (`"42"`,
 * `"group:7"`). Other mention ids (foreign accounts an import kept) stay as they are.
 */
export function remapDoc(doc: JsonValue, map: IdMap): JsonValue {
  if (Array.isArray(doc)) return doc.map((d) => remapDoc(d, map));
  if (doc === null || typeof doc !== 'object') return doc;
  const node = doc as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'content' ? remapDoc(value, map) : value;
  }
  const attrs = node.attrs;
  if (node.type === 'mention' && attrs !== null && typeof attrs === 'object') {
    const a = attrs as Record<string, JsonValue>;
    const id = typeof a.id === 'string' ? a.id : null;
    const group = id === null ? null : /^group:([1-9][0-9]{0,9})$/.exec(id);
    let mapped: string | null | undefined;
    if (id !== null && DIGITS.test(id)) mapped = one(map, 'user', id, 'mention');
    else if (group) {
      const g = one(map, 'group', group[1] as string, 'mention');
      mapped = g === null ? null : `group:${g}`;
    }
    if (mapped !== undefined) out.attrs = { ...a, id: mapped };
  }
  return out;
}

const ascending = (ids: string[]) => ids.sort((a, b) => Number(a) - Number(b));

/**
 * A custom value in stored form (`fields/types.ts`) with its references mapped, or undefined
 * when nothing of it maps. Several ids stay in ascending order, as stored values keep them.
 */
export function remapStored(
  shape: Pick<FieldShape, 'type' | 'multiple'>,
  value: JsonValue,
  map: IdMap,
  where = 'fields',
): JsonValue | undefined {
  if (shape.type === 'paragraph') return remapDoc(value, map);
  const reference = REFERENCE_OF[shape.type];
  if (reference === undefined) return value;
  const kind = KIND_OF_REFERENCE[reference];
  const ids = (Array.isArray(value) ? value : [value]).map(String);
  if (shape.type === 'cascading-select') {
    // [parent] or [parent, child]: a child without its parent means nothing.
    const parent = ids[0] === undefined ? null : one(map, kind, ids[0], where);
    if (parent === null) return undefined;
    const child = ids[1] === undefined ? null : one(map, kind, ids[1], where);
    return child === null ? [Number(parent)] : [Number(parent), Number(child)];
  }
  const mapped = ids.flatMap((id) => {
    const m = one(map, kind, id, where);
    return m === null ? [] : [m];
  });
  if (Array.isArray(value)) {
    return mapped.length === 0 ? undefined : ascending(mapped).map(Number);
  }
  return mapped.length === 0 ? undefined : Number(mapped[0]);
}

/** A ticket's custom values (`ticket.fields`) with field ids and their references mapped. */
export function remapFields(
  fields: Record<string, JsonValue>,
  map: IdMap,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(fields).sort((a, b) => Number(a) - Number(b))) {
    const shape = map.field(key);
    const id = one(map, 'field', key, 'fields');
    if (id === null || shape === undefined) continue;
    const value = remapStored(shape, fields[key] as JsonValue, map, `cf[${key}]`);
    if (value !== undefined) out[id] = value;
  }
  return out;
}

/** What the ids of a history field name (`tickets/history.ts`). */
const HISTORY_REFS: Readonly<Record<string, { kind: EntityKind; list?: true }>> = {
  track: { kind: 'track' },
  type: { kind: 'ticket_type' },
  parent: { kind: 'ticket' },
  status: { kind: 'status' },
  assignee: { kind: 'user' },
  requester: { kind: 'user' },
  priority: { kind: 'priority' },
  closeReason: { kind: 'close_reason' },
  targetRelease: { kind: 'release', list: true },
  foundInRelease: { kind: 'release', list: true },
  area: { kind: 'area', list: true },
  comment: { kind: 'comment' },
  attachment: { kind: 'attachment' },
};

/**
 * History fields whose values name objects the export does not carry (visibility levels);
 * they stay empty, their display text kept. Web links are kept by URL, so they carry over.
 */
export const UNCARRIED_HISTORY_FIELDS: ReadonlySet<string> = new Set(['visibilityLevel']);

/** Rich text kept as JSON text, mentions mapped; text that is not JSON stays as it is. */
function richValue(value: string, map: IdMap): string {
  let doc: JsonValue;
  try {
    doc = JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
  return canonicalJson(remapDoc(doc, map));
}

/** History fields holding rich text as canonical JSON. */
const RICH_HISTORY_FIELDS: ReadonlySet<string> = new Set(['description', 'environment']);

/**
 * One value of a history entry with its ids mapped (`field` named as on the side being read),
 * or null when it named something that does not map.
 */
export function remapHistoryValue(field: string, value: string | null, map: IdMap): string | null {
  if (value === null) return null;
  const where = `history.${field}`;
  if (UNCARRIED_HISTORY_FIELDS.has(field)) {
    map.unmapped?.('history', where);
    return null;
  }
  if (RICH_HISTORY_FIELDS.has(field)) return richValue(value, map);
  if (field === 'timeEntry') {
    // `<time entry>:<seconds>`
    const cut = value.indexOf(':');
    const entry = one(map, 'time_entry', cut < 0 ? value : value.slice(0, cut), where);
    return entry === null ? null : cut < 0 ? entry : `${entry}${value.slice(cut)}`;
  }
  if (field === 'link') {
    // `<link type>:<outward|inward>:<other ticket>`
    const [type, direction, other] = value.split(':');
    if (type === undefined || direction === undefined || other === undefined) return value;
    const t = one(map, 'link_type', type, where);
    const o = one(map, 'ticket', other, where);
    return t === null || o === null ? null : `${t}:${direction}:${o}`;
  }
  const custom = CUSTOM.exec(field);
  if (custom) {
    const shape = map.field(custom[1] as string);
    if (shape === undefined) return value;
    if (shape.type === 'paragraph') return richValue(value, map);
    const reference = REFERENCE_OF[shape.type];
    if (reference === undefined) return value;
    const kind = KIND_OF_REFERENCE[reference];
    const separator = shape.type === 'cascading-select' ? ':' : ',';
    const parts = value.split(separator).flatMap((id) => {
      const m = one(map, kind, id, where);
      return m === null ? [] : [m];
    });
    return parts.length === 0 ? null : parts.join(separator);
  }
  const refs = HISTORY_REFS[field];
  if (!refs) return value;
  if (!refs.list) return one(map, refs.kind, value, where);
  const parts = value.split(',').flatMap((id) => {
    const m = one(map, refs.kind, id, where);
    return m === null ? [] : [m];
  });
  return parts.length === 0 ? null : parts.join(',');
}

/** A formula expression with the fields it names (`{cf[12]}`) mapped. */
export function remapExpression(expression: string, map: IdMap): string {
  return expression.replace(/cf\[([1-9][0-9]{0,9})\]/g, (whole, id: string) => {
    const m = one(map, 'field', id, 'expression');
    return m === null ? whole.replace(id, '0') : `cf[${m}]`;
  });
}

/** A field's settings with a formula's expression mapped. */
export function remapFieldConfig(
  config: Record<string, JsonValue>,
  map: IdMap,
): Record<string, JsonValue> {
  return typeof config.expression === 'string'
    ? { ...config, expression: remapExpression(config.expression, map) }
    : config;
}

// --- Workflow definitions ---------------------------------------------------------------------

type Json = JsonValue;
type Obj = Record<string, Json>;
const isObj = (v: Json | undefined): v is Obj =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);

/**
 * A workflow definition (`workflows/model.ts`) with the statuses, groups, roles, people and
 * custom fields it names mapped. Transition ids are the definition's own and stay. Visibility
 * levels (`set-visibility-level-from-role`) are not carried by the export: the effect keeps no
 * levels.
 */
export function remapDefinition(definition: Json, map: IdMap): Json {
  if (!isObj(definition)) return definition;
  const status = (v: Json | undefined): Json =>
    typeof v === 'number' ? Number(one(map, 'status', String(v), 'workflow') ?? 0) : (v ?? null);
  const idText = (kind: EntityKind, v: Json | undefined): Json =>
    typeof v === 'string' ? (one(map, kind, v, 'workflow') ?? '0') : (v ?? null);
  const idTexts = (kind: EntityKind, v: Json | undefined): Json =>
    Array.isArray(v)
      ? v.flatMap((x) => {
          const m = typeof x === 'string' ? one(map, kind, x, 'workflow') : null;
          return m === null ? [] : [m];
        })
      : (v ?? null);
  const field = (v: Json | undefined): Json =>
    typeof v === 'string' ? (remapFieldName(v, map, 'workflow') ?? v) : (v ?? null);
  const principal = (p: Json): Json => {
    if (!isObj(p)) return p;
    if (typeof p.role === 'string') return { role: idText('role', p.role) };
    if (typeof p.group === 'string') return { group: idText('group', p.group) };
    return p;
  };
  /** A guard, check, effect or rule leaf: the keys that hold references by name. */
  const leaf = (node: Obj): Obj => {
    const out: Obj = { ...node };
    for (const key of ['field', 'from', 'to', 'other'] as const) {
      // Effects and rules copy between fields by name; `from`/`to` of a transition are not here.
      if (typeof out[key] === 'string') out[key] = field(out[key]);
    }
    switch (node.type) {
      case 'previous-status':
      case 'previous-state':
      case 'restrict-been-through':
        out.status = idText('status', node.status);
        break;
      case 'subticket-blocking':
      case 'parent-status':
        out.statuses = idTexts('status', node.statuses);
        break;
      case 'user-in-group':
        out.group = idText('group', node.group);
        break;
      case 'user-in-any-group':
        out.groups = idTexts('group', node.groups);
        break;
      case 'user-in-role':
        out.role = idText('role', node.role);
        break;
      case 'user-in-any-role':
        out.roles = idTexts('role', node.roles);
        break;
      case 'assign':
        if (isObj(node.to) && typeof node.to.user === 'string') {
          out.to = { user: idText('user', node.to.user) };
        }
        break;
      case 'restrict-who':
        if (node.users !== undefined) out.users = idTexts('user', node.users);
        if (node.groups !== undefined) out.groups = idTexts('group', node.groups);
        if (node.roles !== undefined) out.roles = idTexts('role', node.roles);
        break;
      case 'set-visibility-level-from-role':
        out.levels = {};
        break;
    }
    return out;
  };
  const guard = (node: Json): Json => {
    if (!isObj(node)) return node;
    if (Array.isArray(node.all)) return { all: node.all.map(guard) };
    if (Array.isArray(node.any)) return { any: node.any.map(guard) };
    return leaf(node);
  };
  const list = (v: Json | undefined): Json =>
    Array.isArray(v) ? v.map((x) => (isObj(x) ? leaf(x) : x)) : (v ?? null);
  const keyed = (record: Json | undefined, value: (v: Json) => Json): Json => {
    if (!isObj(record)) return record ?? null;
    const out: Obj = {};
    for (const [k, v] of Object.entries(record)) {
      const id = one(map, 'status', k, 'workflow');
      if (id !== null) out[id] = value(v);
    }
    return out;
  };
  const def = definition;
  const out: Obj = { ...def, initialStatusId: status(def.initialStatusId) };
  if (Array.isArray(def.statuses)) {
    out.statuses = def.statuses.map((s) => (isObj(s) ? { ...s, statusId: status(s.statusId) } : s));
  }
  if (Array.isArray(def.transitions)) {
    out.transitions = def.transitions.map((t) => {
      if (!isObj(t)) return t;
      const next: Obj = {
        ...t,
        from: Array.isArray(t.from) ? t.from.map((s) => status(s)) : (t.from ?? null),
        to: status(t.to),
      };
      if (Array.isArray(t.layout)) next.layout = t.layout.map((f) => field(f));
      if (t.guards !== undefined) next.guards = guard(t.guards);
      if (t.checks !== undefined) next.checks = list(t.checks);
      if (t.effects !== undefined) next.effects = list(t.effects);
      return next;
    });
  }
  if (isObj(def.onCreate) && def.onCreate.effects !== undefined) {
    out.onCreate = { ...def.onCreate, effects: list(def.onCreate.effects) };
  }
  if (isObj(def.rules)) {
    // Keyed by transition id, which carries over.
    out.rules = Object.fromEntries(Object.entries(def.rules).map(([k, v]) => [k, list(v)]));
  }
  if (def.statusPermissions !== undefined) {
    out.statusPermissions = keyed(def.statusPermissions, (perm) => {
      if (!isObj(perm)) return perm;
      return Object.fromEntries(
        Object.entries(perm).map(([k, v]) => [k, Array.isArray(v) ? v.map(principal) : v]),
      );
    });
  }
  return out;
}

// --- Collecting references for a batch -------------------------------------------------------

/**
 * An `IdMap` that maps nothing but records every id asked for, so a batch can look them all up
 * at once before the real walk. `field` answers from the given shapes.
 */
export class RefCollector implements IdMap {
  readonly refs: Ref[] = [];

  constructor(
    private readonly shapes: (id: string) => Pick<FieldShape, 'type' | 'multiple'> | undefined,
  ) {}

  id(kind: EntityKind, id: string): string {
    this.refs.push({ kind, id });
    return id;
  }

  field(id: string) {
    return this.shapes(id);
  }
}
