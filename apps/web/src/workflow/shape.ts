import { type AnyParamSpec, catalogueOf, OPS, type RuleKind, SYSTEM_FIELDS } from './catalogue';
import { jsonErrorPosition, LIMITS, type WorkflowDefinition } from './definition';

/**
 * The text mode's shape check (M1-030): whether a value has the shape the server's definition
 * schema accepts (`apps/server/src/workflows/model.ts`), with a path to each problem so the
 * editor can say where it is. What needs the workspace (unknown statuses or fields, a pattern
 * that does not compile) is the server's `definitionProblem`, reported after saving.
 */
export type ShapeCode =
  | 'not_object'
  | 'missing'
  | 'unknown_key'
  | 'not_id'
  | 'not_id_text'
  | 'not_text'
  | 'text_length'
  | 'not_list'
  | 'list_length'
  | 'unknown_type'
  | 'not_op'
  | 'not_number'
  | 'not_integer'
  | 'not_boolean'
  | 'not_url'
  | 'not_event'
  | 'not_trigger'
  | 'not_system_field'
  | 'not_assign_target'
  | 'not_guard';

export interface ShapeProblem {
  path: string;
  code: ShapeCode;
  args?: Record<string, string | number>;
}

const MAX_INT = 2_147_483_647;
const ID_TEXT = /^[1-9][0-9]{0,9}$/;
const EVENT = /^[a-z][a-z0-9-]{0,99}$/;
const TRIGGER = /^[a-z][a-z0-9.:-]{0,199}$/;

type Check = (value: unknown, path: string) => void;

class Checker {
  readonly problems: ShapeProblem[] = [];

  add(path: string, code: ShapeCode, args?: Record<string, string | number>) {
    this.problems.push(args ? { path, code, args } : { path, code });
  }

  /** An object with exactly these keys; `required` ones must be present. */
  object(value: unknown, path: string, keys: Record<string, Check>, required: string[] = []) {
    if (!isObject(value)) {
      this.add(path, 'not_object');
      return;
    }
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) this.add(join(path, key), 'missing');
    }
    for (const [key, v] of Object.entries(value)) {
      const check = Object.hasOwn(keys, key) ? keys[key] : undefined;
      if (!check) this.add(join(path, key), 'unknown_key');
      else if (v !== undefined) check(v, join(path, key));
    }
  }

  list(value: unknown, path: string, item: Check, min: number, max: number) {
    if (!Array.isArray(value)) {
      this.add(path, 'not_list');
      return;
    }
    if (value.length < min || value.length > max) this.add(path, 'list_length', { min, max });
    value.forEach((v, i) => {
      item(v, `${path}[${i}]`);
    });
  }

  record(value: unknown, path: string, item: Check, key: (k: string, path: string) => void) {
    if (!isObject(value)) {
      this.add(path, 'not_object');
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      key(k, join(path, k));
      item(v, join(path, k));
    }
  }

  id = (value: unknown, path: string) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_INT) {
      this.add(path, 'not_id');
    }
  };

  idText = (value: unknown, path: string) => {
    if (typeof value !== 'string' || !ID_TEXT.test(value)) this.add(path, 'not_id_text');
  };

  text(value: unknown, path: string, min: number, max: number, trim = false) {
    if (typeof value !== 'string') {
      this.add(path, 'not_text');
      return;
    }
    const length = (trim ? value.trim() : value).length;
    if (length < min || length > max) this.add(path, 'text_length', { min, max });
  }

  boolean = (value: unknown, path: string) => {
    if (typeof value !== 'boolean') this.add(path, 'not_boolean');
  };

  number = (value: unknown, path: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) this.add(path, 'not_number');
  };

  pattern(value: unknown, path: string, re: RegExp, code: ShapeCode) {
    if (typeof value !== 'string' || !re.test(value)) this.add(path, code);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const join = (path: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

/** Problems with a value as a definition; none means the server's schema accepts its shape. */
export function checkShape(value: unknown): ShapeProblem[] {
  const c = new Checker();
  const fieldName = (v: unknown, p: string) => c.text(v, p, 1, 100);
  const rules = (kind: RuleKind) => (v: unknown, p: string) =>
    c.list(v, p, (r, rp) => rule(c, kind, r, rp), 0, LIMITS.rulesPerList);
  const guard: Check = (v, p) => guardNode(c, v, p);
  const principal: Check = (v, p) => {
    if (isObject(v) && 'group' in v) c.object(v, p, { group: c.idText }, ['group']);
    else c.object(v, p, { role: c.idText }, ['role']);
  };
  const principals: Check = (v, p) => c.list(v, p, principal, 0, 50);

  const transition: Check = (v, p) =>
    c.object(
      v,
      p,
      {
        id: c.id,
        name: (x, xp) => c.text(x, xp, 1, 255, true),
        description: (x, xp) => c.text(x, xp, 0, 2000),
        from: (x, xp) => {
          if (x === 'any') return;
          if (typeof x === 'string') c.add(xp, 'not_list');
          else c.list(x, xp, c.id, 1, LIMITS.statuses);
        },
        to: c.id,
        layout: (x, xp) => c.list(x, xp, fieldName, 0, LIMITS.layoutFields),
        guards: guard,
        checks: rules('check'),
        effects: rules('effect'),
        properties: (x, xp) =>
          c.record(
            x,
            xp,
            (pv, pp) => c.text(pv, pp, 0, 4000),
            (k, kp) => {
              if (k.length < 1 || k.length > 255) c.add(kp, 'text_length', { min: 1, max: 255 });
            },
          ),
        event: (x, xp) => c.pattern(x, xp, EVENT, 'not_event'),
        triggers: (x, xp) =>
          c.list(
            x,
            xp,
            (tv, tp) =>
              c.object(tv, tp, { event: (e, ep) => c.pattern(e, ep, TRIGGER, 'not_trigger') }, [
                'event',
              ]),
            0,
            LIMITS.triggers,
          ),
      },
      ['id', 'name', 'from', 'to'],
    );

  c.object(
    value,
    'definition',
    {
      initialStatusId: c.id,
      statuses: (v, p) =>
        c.list(
          v,
          p,
          (s, sp) => c.object(s, sp, { statusId: c.id, x: c.number, y: c.number }, ['statusId']),
          1,
          LIMITS.statuses,
        ),
      transitions: (v, p) => c.list(v, p, transition, 0, LIMITS.transitions),
      onCreate: (v, p) =>
        c.object(v, p, {
          effects: rules('effect'),
          event: (x, xp) => c.pattern(x, xp, EVENT, 'not_event'),
        }),
      rules: (v, p) => c.record(v, p, rules('rule'), (_k, kp) => c.idText(_k, kp)),
      statusPermissions: (v, p) =>
        c.record(
          v,
          p,
          (x, xp) =>
            c.object(x, xp, {
              edit: principals,
              comment: principals,
              attach: principals,
              assign: principals,
              transition: principals,
            }),
          (_k, kp) => c.idText(_k, kp),
        ),
    },
    ['initialStatusId', 'statuses', 'transitions'],
  );
  return c.problems;
}

function guardNode(c: Checker, value: unknown, path: string) {
  const group = (v: unknown, p: string) => c.list(v, p, (g, gp) => guardNode(c, g, gp), 0, 100);
  if (isObject(value) && 'all' in value) c.object(value, path, { all: group }, ['all']);
  else if (isObject(value) && 'any' in value) c.object(value, path, { any: group }, ['any']);
  else if (isObject(value) && 'type' in value) rule(c, 'guard', value, path);
  else c.add(path, 'not_guard');
}

/** A guard leaf, check, effect or rule: a known type and its parameters. */
function rule(c: Checker, kind: RuleKind, value: unknown, path: string) {
  if (!isObject(value)) {
    c.add(path, 'not_object');
    return;
  }
  const table = catalogueOf(kind);
  const type = value.type;
  if (typeof type !== 'string' || !Object.hasOwn(table, type)) {
    c.add(join(path, 'type'), 'unknown_type', { type: String(type) });
    return;
  }
  const entry = table[type];
  if (!entry) return;
  const keys: Record<string, Check> = { type: () => {} };
  const required: string[] = [];
  for (const [name, spec] of Object.entries(entry.params)) {
    keys[name] = (v, p) => param(c, spec, v, p);
    if (!spec.optional && spec.kind !== 'value') required.push(name);
  }
  if (kind === 'check') keys.message = (v, p) => c.text(v, p, 0, 500);
  c.object(value, path, keys, required);
}

function param(c: Checker, spec: AnyParamSpec, value: unknown, path: string) {
  const ids = (v: unknown, p: string) => c.list(v, p, c.idText, 0, 200);
  switch (spec.kind) {
    case 'field':
      return c.text(value, path, 1, 100);
    case 'op':
      if (!OPS.includes(value as never)) c.add(path, 'not_op');
      return;
    case 'number':
      return c.number(value, path);
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < spec.min ||
        value > spec.max
      ) {
        c.add(path, 'not_integer', { min: spec.min, max: spec.max });
      }
      return;
    case 'text':
      return c.text(value, path, spec.min, spec.max);
    case 'pattern':
      return c.text(value, path, 1, 500);
    case 'permission':
      return c.text(value, path, spec.min, 100);
    case 'readonly':
      return c.text(value, path, 0, spec.max);
    case 'status':
    case 'transition':
    case 'role':
    case 'group':
      return c.idText(value, path);
    case 'statuses':
    case 'roles':
    case 'groups':
    case 'users':
      return ids(value, path);
    case 'boolean':
      return c.boolean(value, path);
    case 'value':
      return;
    case 'url':
      if (typeof value !== 'string' || value.length > 2000 || !/^https?:\/\//.test(value)) {
        c.add(path, 'not_url');
      }
      return;
    case 'levels':
      return c.record(
        value,
        path,
        (v, p) => c.text(v, p, 0, 100),
        (k, kp) => c.idText(k, kp),
      );
    case 'systemField':
      if (!SYSTEM_FIELDS.includes(value as never)) c.add(path, 'not_system_field');
      return;
    case 'assignTarget':
      if (value === 'current-user' || value === 'requester') return;
      if (isObject(value) && Object.keys(value).length === 1 && 'user' in value) {
        c.idText(value.user, join(path, 'user'));
        return;
      }
      c.add(path, 'not_assign_target');
      return;
  }
}

/** Reads the text mode's JSON: the definition, or why it cannot be one. */
export type ParsedText =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; kind: 'syntax'; at: { line: number; column: number } | null }
  | { ok: false; kind: 'shape'; problems: ShapeProblem[] };

export function parseDefinitionText(text: string): ParsedText {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'syntax', at: jsonErrorPosition(text) };
  }
  const problems = checkShape(value);
  return problems.length > 0
    ? { ok: false, kind: 'shape', problems }
    : { ok: true, definition: value as WorkflowDefinition };
}
