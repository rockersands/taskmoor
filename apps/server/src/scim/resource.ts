import { invalidValue } from './errors';
import { type AttrPath, containerOf, parsePath } from './filter';
import {
  type AttributeDef,
  COMMON_ATTRIBUTES,
  extensionPrefix,
  findAttribute,
  type ResourceTypeDef,
  schemaFor,
} from './schemas';

/**
 * Resource bodies against their schema: values coerced to the attribute's type, names to their
 * canonical spelling, unknown and read-only attributes dropped (a provider may send attributes
 * Taskmoor does not keep; RFC 7644 3.3 lets the service provider ignore them), and empty values
 * treated as absent. The functions also take the string booleans ("True") and bare manager ids
 * some identity providers send.
 */
export type Resource = Record<string, unknown>;

/** Longest text a SCIM attribute may hold, and most values a multi-valued attribute may have. */
export const MAX_TEXT = 2048;
export const MAX_VALUES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function single(def: AttributeDef, value: unknown, where: string): unknown {
  if (value === undefined || value === null) return undefined;
  switch (def.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
        return value.trim().toLowerCase() === 'true';
      }
      throw invalidValue(`${where} must be true or false`);
    case 'integer':
    case 'decimal': {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number) || (def.type === 'integer' && !Number.isInteger(number))) {
        throw invalidValue(`${where} must be a number`);
      }
      return number;
    }
    case 'complex': {
      // A bare value where a complex one belongs is its `value` (a manager given by id).
      const raw =
        typeof value === 'string' && findAttribute(def.subAttributes, 'value') ? { value } : value;
      if (!isRecord(raw)) throw invalidValue(`${where} must be an object`);
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(raw)) {
        const sub = findAttribute(def.subAttributes, key);
        if (!sub) continue;
        const normalized = normalizeValue(sub, inner, `${where}.${sub.name}`);
        if (normalized !== undefined) out[sub.name] = normalized;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    default: {
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value !== 'string') throw invalidValue(`${where} must be text`);
      if (value.length > MAX_TEXT) throw invalidValue(`${where} is too long`);
      if (def.type === 'dateTime' && Number.isNaN(Date.parse(value))) {
        throw invalidValue(`${where} must be a date and time`);
      }
      return value === '' ? undefined : value;
    }
  }
}

/** Coerces a value given for an attribute; undefined means the attribute has no value. */
export function normalizeValue(
  def: AttributeDef,
  value: unknown,
  where: string = def.name,
  maxValues = MAX_VALUES,
): unknown {
  if (value === undefined || value === null) return undefined;
  if (!def.multiValued) {
    if (Array.isArray(value)) {
      if (value.length > 1) throw invalidValue(`${where} takes one value`);
      return single(def, value[0], where);
    }
    return single(def, value, where);
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length > maxValues) throw invalidValue(`${where} has too many values`);
  const items = list.map((item) => single(def, item, where)).filter((item) => item !== undefined);
  return items.length > 0 ? keepOnePrimary(items) : undefined;
}

/** At most one value may be primary (RFC 7643 2.4); the first one claiming it keeps it. */
function keepOnePrimary(items: unknown[]): unknown[] {
  let seen = false;
  return items.map((item) => {
    if (!isRecord(item) || item.primary !== true) return item;
    if (!seen) {
      seen = true;
      return item;
    }
    const { primary: _drop, ...rest } = item;
    return rest;
  });
}

/** Where an attribute named by a body key lives: its definition and extension, if any. */
export function locateKey(
  type: ResourceTypeDef,
  key: string,
): { urn?: string; def: AttributeDef } | { extension: string } | undefined {
  const asSchema = schemaFor(type, key);
  if (asSchema && asSchema.id !== type.schema.id) return { extension: asSchema.id };
  let urn: string | undefined;
  let name = key;
  if (/^urn:/i.test(key)) {
    const prefixed = extensionPrefix(type, key);
    if (!prefixed) return undefined;
    name = prefixed.rest;
    if (prefixed.schema.id !== type.schema.id) urn = prefixed.schema.id;
  }
  const attributes = urn
    ? (schemaFor(type, urn)?.attributes ?? [])
    : [...type.schema.attributes, ...COMMON_ATTRIBUTES];
  const def = findAttribute(attributes, name);
  return def ? { def, ...(urn ? { urn } : {}) } : undefined;
}

/** Attributes a client may write; the rest are kept by Taskmoor or never stored. */
export function writable(def: AttributeDef): boolean {
  return def.mutability !== 'readOnly' && def.mutability !== 'writeOnly';
}

/**
 * A POST or PUT body as a canonical resource: known, writable attributes only, extension
 * attributes under their schema URN (whether nested there or given as `urn:...:name`).
 */
export function normalizeResource(body: Resource, type: ResourceTypeDef): Resource {
  const out: Resource = {};
  const put = (urn: string | undefined, def: AttributeDef, value: unknown) => {
    if (!writable(def)) return;
    const normalized = normalizeValue(
      def,
      value,
      def.name,
      def.name === 'members' ? Number.POSITIVE_INFINITY : MAX_VALUES,
    );
    const container = urn ? ((out[urn] as Resource | undefined) ?? {}) : out;
    if (normalized === undefined) delete container[def.name];
    else container[def.name] = normalized;
    if (urn && Object.keys(container).length > 0) out[urn] = container;
  };
  for (const [key, value] of Object.entries(body)) {
    if (key.toLowerCase() === 'schemas') continue;
    const located = locateKey(type, key);
    if (!located) continue;
    if ('extension' in located) {
      if (value === null || value === undefined) continue;
      if (!isRecord(value)) throw invalidValue(`${key} must be an object`);
      const schema = schemaFor(type, located.extension);
      for (const [inner, innerValue] of Object.entries(value)) {
        const def = findAttribute(schema?.attributes, inner);
        if (def) put(located.extension, def, innerValue);
      }
    } else {
      put(located.urn, located.def, value);
    }
  }
  return out;
}

/** Schema URNs a body may list for a resource type. */
export function checkSchemas(body: Resource, type: ResourceTypeDef): void {
  const schemas = body.schemas;
  if (schemas === undefined) return;
  if (!Array.isArray(schemas) || !schemas.every((s) => typeof s === 'string')) {
    throw invalidValue('schemas must be a list of schema URNs');
  }
  const known = [type.schema.id, ...type.extensions.map((e) => e.id)].map((s) => s.toLowerCase());
  if (!schemas.some((s) => s.toLowerCase() === type.schema.id.toLowerCase())) {
    throw invalidValue(`schemas must include ${type.schema.id}`);
  }
  const unknown = schemas.filter((s) => !known.includes(s.toLowerCase()));
  if (unknown.length > 0) throw invalidValue(`Unknown schema ${unknown[0]}`);
}

/** The `schemas` list of a resource: its own and the extensions it has values for. */
export function schemasOf(resource: Resource, type: ResourceTypeDef): string[] {
  return [type.schema.id, ...type.extensions.map((e) => e.id).filter((id) => id in resource)];
}

function parseList(value: string | undefined, type: ResourceTypeDef): AttrPath[] {
  if (!value) return [];
  const paths: AttrPath[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (!name) continue;
    try {
      const path = parsePath(name, type);
      if (!path.filter) paths.push(path);
    } catch {
      // An attribute this service does not know is simply not returned (RFC 7644 3.9).
    }
  }
  return paths;
}

/**
 * The `attributes` and `excludedAttributes` query parameters (RFC 7644 3.9): with
 * `attributes`, only those (and `id` and `schemas`, always returned); with
 * `excludedAttributes`, everything else. Sub-attributes may be named (`name.givenName`).
 */
export function project(
  resource: Resource,
  type: ResourceTypeDef,
  attributes: string | undefined,
  excluded: string | undefined,
): Resource {
  const wanted = parseList(attributes, type);
  if (wanted.length > 0) {
    const out: Resource = { schemas: resource.schemas, id: resource.id };
    for (const path of wanted) {
      const from = containerOf(resource, path.urn);
      const value = from?.[path.attr.name];
      if (value === undefined) continue;
      const to = path.urn ? ((out[path.urn] as Resource | undefined) ?? {}) : out;
      if (path.sub) {
        const sub = path.sub.name;
        const picked = Array.isArray(value)
          ? value.map((item) => (isRecord(item) && sub in item ? { [sub]: item[sub] } : {}))
          : isRecord(value) && sub in value
            ? { ...((to[path.attr.name] as Resource | undefined) ?? {}), [sub]: value[sub] }
            : undefined;
        if (picked !== undefined) to[path.attr.name] = picked;
      } else {
        to[path.attr.name] = value;
      }
      if (path.urn) out[path.urn] = to;
    }
    return out;
  }
  const dropped = parseList(excluded, type);
  if (dropped.length === 0) return resource;
  const out: Resource = structuredClone(resource);
  for (const path of dropped) {
    if (path.attr.returned === 'always') continue;
    const container = containerOf(out, path.urn);
    if (!container) continue;
    if (!path.sub) {
      delete container[path.attr.name];
      continue;
    }
    const value = container[path.attr.name];
    const sub = path.sub.name;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (isRecord(item)) delete item[sub];
    }
  }
  return out;
}
