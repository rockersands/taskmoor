import { invalidPath, invalidValue, mutability, noTarget } from './errors';
import { type AttrPath, containerOf, type Filter, matches, parsePath } from './filter';
import { locateKey, normalizeValue, type Resource, writable } from './resource';
import { type AttributeDef, findAttribute, type ResourceTypeDef, schemaFor } from './schemas';

/**
 * SCIM PATCH (RFC 7644 3.5.2) over a canonical resource. Operations apply in order to a copy;
 * the caller stores the result only when every operation succeeded, so a request is all or
 * nothing.
 *
 * Restated rules: `add` appends values to multi-valued attributes, merges sub-attributes into
 * complex ones and sets simple ones; `replace` replaces a multi-valued attribute's values (or
 * the values a filter picks) and sets the rest, merging sub-attributes of complex attributes;
 * `remove` needs a path and removes the attribute, the values a filter picks, or a
 * sub-attribute. Without a path, `add` and `replace` take an object of attributes.
 *
 * Shapes identity providers send that the RFC leaves open, handled here on purpose:
 * - an `add` or `replace` through `emails[type eq "work"].value` when no value matches creates
 *   one from the filter's equality terms (Microsoft Entra ID);
 * - a `remove` of a multi-valued attribute with a `value` list removes only those values
 *   (Entra ID's way of removing group members);
 * - operation names in any letter case ("Replace"), string booleans ("False"), a bare id for
 *   the enterprise `manager`, and `id` or `meta` inside a path-less value (Okta) are accepted;
 *   the read-only attributes there are ignored.
 */
export interface PatchOperation {
  op: 'add' | 'replace' | 'remove';
  path?: string | undefined;
  value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/** Whether two values of a multi-valued attribute are the same value. */
function sameValue(def: AttributeDef, a: unknown, b: unknown): boolean {
  if (isRecord(a) && isRecord(b)) {
    const valueDef = findAttribute(def.subAttributes, 'value');
    if (valueDef && (a.value !== undefined || b.value !== undefined)) {
      if (typeof a.value === 'string' && typeof b.value === 'string' && !valueDef.caseExact) {
        return a.value.toLowerCase() === b.value.toLowerCase();
      }
      return a.value === b.value;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** A value that claims `primary` takes it from every other value (RFC 7644 3.5.2). */
function settlePrimary(items: unknown[], winners: unknown[]): void {
  const winner = winners.find((w) => isRecord(w) && w.primary === true);
  if (!winner) return;
  for (const item of items) {
    if (item !== winner && isRecord(item) && item.primary === true) delete item.primary;
  }
}

function store(container: Resource, name: string, value: unknown): void {
  const empty =
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0);
  if (empty) delete container[name];
  else container[name] = value;
}

/** The values `attr[type eq "work" and ...]` describes, for creating one that is missing. */
function seedFromFilter(filter: Filter): Record<string, unknown> | undefined {
  if (filter.op === 'and') {
    const left = seedFromFilter(filter.left);
    const right = seedFromFilter(filter.right);
    return left && right ? { ...left, ...right } : undefined;
  }
  if (filter.op === 'eq' && !filter.path.sub && filter.value !== null) {
    return { [filter.path.attr.name]: filter.value };
  }
  return undefined;
}

function first(def: AttributeDef, value: unknown, where: string): Record<string, unknown> {
  const items = normalizeValue(def, Array.isArray(value) ? value : [value], where);
  const item = Array.isArray(items) ? items[0] : undefined;
  if (!isRecord(item)) throw invalidValue(`${where} needs a value`);
  return item;
}

function applyPath(
  resource: Resource,
  path: AttrPath,
  op: PatchOperation['op'],
  value: unknown,
  where: string,
): void {
  const def = path.attr;
  const name = def.name;
  let container = containerOf(resource, path.urn);
  if (!container) {
    if (op === 'remove' || !path.urn) return;
    container = {};
    resource[path.urn] = container;
  }
  const done = () => {
    if (path.urn && Object.keys(container).length === 0) delete resource[path.urn];
  };

  if (path.filter) {
    const items = asArray(container[name]);
    const inner = path.filter;
    const hits = items.filter((item) => isRecord(item) && matches(item, inner)) as Record<
      string,
      unknown
    >[];
    if (op === 'remove') {
      if (path.sub) {
        for (const hit of hits) delete hit[path.sub.name];
        store(container, name, items);
      } else {
        store(
          container,
          name,
          items.filter((item) => !hits.includes(item as Record<string, unknown>)),
        );
      }
      done();
      return;
    }
    if (hits.length === 0) {
      const seed = seedFromFilter(inner);
      if (!seed) throw noTarget(`No value of ${name} matches ${where}`);
      const created = path.sub
        ? first(def, { ...seed, [path.sub.name]: value }, where)
        : first(def, { ...seed, ...(isRecord(value) ? value : {}) }, where);
      items.push(created);
      settlePrimary(items, [created]);
      store(container, name, items);
      done();
      return;
    }
    for (const hit of hits) {
      if (path.sub) {
        const normalized = normalizeValue(path.sub, value, where);
        if (normalized === undefined) delete hit[path.sub.name];
        else hit[path.sub.name] = normalized;
      } else {
        const next = first(def, value, where);
        if (op === 'replace') for (const key of Object.keys(hit)) delete hit[key];
        Object.assign(hit, next);
      }
    }
    settlePrimary(items, hits);
    store(container, name, items);
    done();
    return;
  }

  if (def.multiValued) {
    if (path.sub) {
      throw invalidPath(`Pick values of ${name} with a filter, as in ${name}[type eq "work"]`);
    }
    const current = asArray(container[name]);
    if (op === 'remove') {
      if (value === undefined || value === null) {
        delete container[name];
      } else {
        const doomed = asArray(normalizeValue(def, value, where, Number.POSITIVE_INFINITY));
        store(
          container,
          name,
          current.filter((item) => !doomed.some((d) => sameValue(def, item, d))),
        );
      }
      done();
      return;
    }
    const incoming = asArray(
      normalizeValue(def, value, where, name === 'members' ? Number.POSITIVE_INFINITY : undefined),
    );
    if (op === 'replace') {
      store(container, name, incoming);
      done();
      return;
    }
    const added: unknown[] = [];
    for (const item of incoming) {
      const existing = current.find((c) => sameValue(def, c, item));
      if (existing && isRecord(existing) && isRecord(item)) {
        Object.assign(existing, item);
        added.push(existing);
      } else if (!existing) {
        current.push(item);
        added.push(item);
      }
    }
    settlePrimary(current, added);
    store(container, name, current);
    done();
    return;
  }

  if (def.type === 'complex') {
    const current = isRecord(container[name]) ? { ...(container[name] as Resource) } : {};
    if (path.sub) {
      if (op === 'remove') delete current[path.sub.name];
      else {
        const normalized = normalizeValue(path.sub, value, where);
        if (normalized === undefined) delete current[path.sub.name];
        else current[path.sub.name] = normalized;
      }
      store(container, name, current);
      done();
      return;
    }
    if (op === 'remove') {
      delete container[name];
      done();
      return;
    }
    const incoming = normalizeValue(def, value, where);
    store(container, name, isRecord(incoming) ? { ...current, ...incoming } : undefined);
    done();
    return;
  }

  if (op === 'remove') delete container[name];
  else store(container, name, normalizeValue(def, value, where));
  done();
  return;
}

function applyOne(resource: Resource, operation: PatchOperation, type: ResourceTypeDef): void {
  const { op, value } = operation;
  const path = operation.path?.trim();
  if (!path) {
    if (op === 'remove') throw noTarget('A remove operation needs a path');
    if (!isRecord(value)) throw invalidValue(`A ${op} without a path needs an object value`);
    for (const [key, inner] of Object.entries(value)) {
      if (key.toLowerCase() === 'schemas') continue;
      const located = locateKey(type, key);
      if (located && 'extension' in located) {
        if (inner === null || inner === undefined) continue;
        if (!isRecord(inner)) throw invalidValue(`${key} must be an object`);
        const schema = schemaFor(type, located.extension);
        for (const [name, extensionValue] of Object.entries(inner)) {
          const def = findAttribute(schema?.attributes, name);
          if (def && writable(def)) {
            applyPath(resource, { attr: def, urn: located.extension }, op, extensionValue, name);
          }
        }
        continue;
      }
      // Read-only attributes (`id`, `meta`) and unknown ones in a path-less value are ignored.
      let target: AttrPath | undefined;
      if (located) target = { attr: located.def, ...(located.urn ? { urn: located.urn } : {}) };
      else if (key.includes('.')) {
        try {
          target = parsePath(key, type);
        } catch {
          target = undefined;
        }
      }
      if (!target || !writable(target.attr) || (target.sub && !writable(target.sub))) continue;
      applyPath(resource, target, op, inner, key);
    }
    return;
  }
  // The whole extension as the path: its attributes are the value's keys.
  const extension = schemaFor(type, path);
  if (extension && extension.id !== type.schema.id) {
    if (op === 'remove') {
      delete resource[extension.id];
      return;
    }
    applyOne(resource, { op, value: { [extension.id]: value } }, type);
    return;
  }
  const target = parsePath(path, type);
  if (target.attr.mutability === 'writeOnly') return; // A password: never stored.
  if (!writable(target.attr) || (target.sub && target.sub.mutability === 'readOnly')) {
    throw mutability(`${path} cannot be changed`);
  }
  if (op !== 'remove' && value === undefined) {
    throw invalidValue(`The ${op} of ${path} needs a value`);
  }
  applyPath(resource, target, op, value, path);
}

/** Applies the operations in order to a copy of the resource and returns the copy. */
export function applyPatch(
  resource: Resource,
  operations: readonly PatchOperation[],
  type: ResourceTypeDef,
): Resource {
  const out = structuredClone(resource);
  for (const operation of operations) applyOne(out, operation, type);
  return out;
}
