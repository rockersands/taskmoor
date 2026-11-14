/**
 * Breaking changes between two versions of the API document (M1-065; ADR-067). Only stable
 * operations count; internal routes may change in any release. A change breaks clients when:
 *
 * - a stable operation is gone, or is no longer stable;
 * - a parameter is gone, or one is newly required (a new optional one is fine);
 * - a request body property is gone from a closed body, or newly required, or an enum loses a
 *   value a client may send;
 * - a success status is gone, or a property of its body is gone or changes type.
 *
 * Adding operations, optional inputs, response properties and enum values never breaks.
 */
type Json = Record<string, unknown>;

export interface BreakingChange {
  operation: string;
  change: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function deref(schema: unknown, doc: Json, depth = 0): Json {
  const s = (schema ?? {}) as Json;
  if (typeof s.$ref === 'string' && s.$ref.startsWith('#/') && depth < 20) {
    const target = s.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (node, part) => (node as Json | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')],
        doc,
      );
    return deref(target, doc, depth + 1);
  }
  return s;
}

/** The type names a schema allows (`anyOf` of types, `type` lists), for comparison. */
function typesOf(schema: Json, doc: Json): string[] {
  const s = deref(schema, doc);
  if (Array.isArray(s.type)) return [...(s.type as string[])].sort();
  if (typeof s.type === 'string') return [s.type];
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[key])) {
      return [...new Set((s[key] as Json[]).flatMap((x) => typesOf(x, doc)))].sort();
    }
  }
  return [];
}

function properties(
  schema: unknown,
  doc: Json,
): { props: Record<string, Json>; required: string[]; closed: boolean } {
  const s = deref(schema, doc);
  return {
    props: (s.properties ?? {}) as Record<string, Json>,
    required: (s.required ?? []) as string[],
    closed: s.additionalProperties === false,
  };
}

function enumOf(schema: unknown, doc: Json): unknown[] | null {
  const s = deref(schema, doc);
  return Array.isArray(s.enum) ? (s.enum as unknown[]) : null;
}

function stableOperations(doc: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
    for (const method of METHODS) {
      const operation = item[method] as Json | undefined;
      if (operation?.['x-taskmoor-stability'] === 'stable')
        out.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return out;
}

export function breakingChanges(before: Json, after: Json): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const now = stableOperations(after);
  for (const [key, old] of stableOperations(before)) {
    const add = (change: string) => changes.push({ operation: key, change });
    const next = now.get(key);
    if (!next) {
      add('the operation is gone or no longer stable');
      continue;
    }
    // Parameters.
    const paramKey = (p: Json) => `${p.in}:${p.name}`;
    const oldParams = new Map(((old.parameters ?? []) as Json[]).map((p) => [paramKey(p), p]));
    const newParams = new Map(((next.parameters ?? []) as Json[]).map((p) => [paramKey(p), p]));
    for (const [k, p] of oldParams) {
      const q = newParams.get(k);
      if (!q) add(`parameter ${k} is gone`);
      else {
        if (!p.required && q.required) add(`parameter ${k} is now required`);
        const was = enumOf(p.schema, before);
        const is = enumOf(q.schema, after);
        if (was && is)
          for (const v of was)
            if (!is.includes(v)) add(`parameter ${k} no longer takes ${JSON.stringify(v)}`);
      }
    }
    for (const [k, q] of newParams)
      if (!oldParams.has(k) && q.required) add(`new required parameter ${k}`);
    // Request body.
    const bodyOf = (op: Json, doc: Json) =>
      properties(
        (
          ((op.requestBody as Json | undefined)?.content as Json | undefined)?.[
            'application/json'
          ] as Json | undefined
        )?.schema,
        doc,
      );
    if (old.requestBody || next.requestBody) {
      const was = bodyOf(old, before);
      const is = bodyOf(next, after);
      for (const name of Object.keys(was.props)) {
        if (!(name in is.props) && is.closed) add(`body property ${name} is gone`);
        const a = enumOf(was.props[name], before);
        const b = is.props[name] ? enumOf(is.props[name], after) : null;
        if (a && b)
          for (const v of a)
            if (!b.includes(v)) add(`body property ${name} no longer takes ${JSON.stringify(v)}`);
      }
      for (const name of is.required)
        if (!was.required.includes(name)) add(`body property ${name} is now required`);
    }
    // Success responses and their properties.
    const responses = (op: Json) => (op.responses ?? {}) as Record<string, Json>;
    for (const [status, response] of Object.entries(responses(old))) {
      if (!/^2\d\d$/.test(status)) continue;
      const replaced = responses(next)[status];
      if (!replaced) {
        add(`success status ${status} is gone`);
        continue;
      }
      const schemaOf = (r: Json) =>
        ((r.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema;
      const was = properties(schemaOf(response), before);
      const is = properties(schemaOf(replaced), after);
      for (const [name, prop] of Object.entries(was.props)) {
        const now2 = is.props[name];
        if (!now2) {
          add(`response ${status} property ${name} is gone`);
          continue;
        }
        const a = typesOf(prop, before);
        const b = typesOf(now2, after);
        if (a.length > 0 && b.length > 0 && a.join() !== b.join()) {
          add(
            `response ${status} property ${name} changed type from ${a.join('|')} to ${b.join('|')}`,
          );
        }
        if (was.required.includes(name) && !is.required.includes(name)) {
          add(`response ${status} property ${name} may now be missing`);
        }
      }
    }
  }
  return changes;
}
