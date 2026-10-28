import { invalidFilter, invalidPath, type ScimError } from './errors';
import {
  type AttributeDef,
  COMMON_ATTRIBUTES,
  extensionPrefix,
  findAttribute,
  type ResourceTypeDef,
  schemaFor,
} from './schemas';

/**
 * SCIM filters and attribute paths (RFC 7644 3.4.2.2 and 3.5.2), parsed against a resource
 * type so every name is resolved (case-insensitively) to its definition, or refused.
 *
 * Grammar, restated from the RFC: a filter is a comparison `attrPath op value`, a presence
 * test `attrPath pr`, a value path `attr[filter]` (true when some value matches the inner
 * filter), `not (filter)`, or filters joined by `and` and `or` (`and` binds tighter), with
 * parentheses for grouping. One extension, which identity providers send in filters:
 * `emails[type eq "work"].value eq "x"` compares a sub-attribute of the matching values only.
 *
 * A PATCH path is `attrPath`, `attr[filter]` or `attr[filter].subAttr`, each optionally
 * prefixed with a schema URN (`urn:...:enterprise:2.0:User:department`).
 */
export type CompareOp = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le';
export type CompareValue = string | number | boolean | null;

export interface AttrPath {
  /** The extension schema URN when the attribute lives in one; undefined for core and common. */
  urn?: string;
  attr: AttributeDef;
  sub?: AttributeDef;
  /** For `attr[filter]...`: only the values matching this filter, relative to each value. */
  filter?: Filter;
}

export type Filter =
  | { op: 'and' | 'or'; left: Filter; right: Filter }
  | { op: 'not'; filter: Filter }
  | { op: 'pr'; path: AttrPath }
  | { op: CompareOp; path: AttrPath; value: CompareValue }
  /** `attr[filter]` used as a filter: some value of the attribute matches. */
  | { op: 'some'; path: AttrPath; filter: Filter };

const COMPARE_OPS = new Set<string>(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le']);
const MAX_FILTER_LENGTH = 4000;
const MAX_DEPTH = 50;

type Token =
  | { kind: 'word'; text: string; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'number'; value: number; at: number }
  | { kind: '(' | ')' | '[' | ']'; at: number }
  /** `.name` right after a closing bracket: the sub-attribute of a value path. */
  | { kind: 'sub'; text: string; at: number };

function tokenize(input: string, fail: (detail: string) => ScimError): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '(' || c === ')' || c === '[' || c === ']') {
      tokens.push({ kind: c, at: i });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') j += input[j] === '\\' ? 2 : 1;
      if (j >= input.length) throw fail(`Unterminated string at ${i}`);
      try {
        tokens.push({ kind: 'string', value: JSON.parse(input.slice(i, j + 1)) as string, at: i });
      } catch {
        throw fail(`Malformed string at ${i}`);
      }
      i = j + 1;
    } else if (c === '.' && tokens[tokens.length - 1]?.kind === ']') {
      const match = /^\.([A-Za-z$][\w$-]*)/.exec(input.slice(i));
      if (!match) throw fail(`Expected a sub-attribute at ${i}`);
      tokens.push({ kind: 'sub', text: match[1] as string, at: i });
      i += match[0].length;
    } else if (/[-0-9]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(input.slice(i));
      if (!match) throw fail(`Unexpected "${c}" at ${i}`);
      tokens.push({ kind: 'number', value: Number(match[0]), at: i });
      i += match[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const match = /^[A-Za-z_$][\w$.:-]*/.exec(input.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'word', text: match[0], at: i });
      i += match[0].length;
    } else {
      throw fail(`Unexpected "${c}" at ${i}`);
    }
  }
  return tokens;
}

/** Resolves `name` or `name.sub` (optionally URN-prefixed) among the given attributes. */
function resolveName(
  type: ResourceTypeDef,
  text: string,
  scope: readonly AttributeDef[] | undefined,
  fail: (detail: string) => ScimError,
): AttrPath {
  let urn: string | undefined;
  let attributes: readonly AttributeDef[] | undefined = scope;
  let rest = text;
  if (!scope) {
    const prefixed = /^urn:/i.test(text) ? extensionPrefix(type, text) : undefined;
    if (/^urn:/i.test(text) && !prefixed) throw fail(`Unknown schema in "${text}"`);
    if (prefixed) {
      rest = prefixed.rest;
      attributes = prefixed.schema.attributes;
      if (prefixed.schema.id !== type.schema.id) urn = prefixed.schema.id;
    } else {
      attributes = [...type.schema.attributes, ...COMMON_ATTRIBUTES];
    }
  }
  const parts = rest.split('.');
  if (parts.length > 2 || parts.some((p) => p === '')) throw fail(`Malformed attribute "${text}"`);
  const def = findAttribute(attributes, parts[0] as string);
  if (!def) throw fail(`Unknown attribute "${text}"`);
  const path: AttrPath = { attr: def, ...(urn ? { urn } : {}) };
  if (parts[1] !== undefined) {
    const sub = findAttribute(def.subAttributes, parts[1]);
    if (!sub) throw fail(`Unknown attribute "${text}"`);
    path.sub = sub;
  }
  return path;
}

class Parser {
  private at = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly type: ResourceTypeDef,
    private readonly fail: (detail: string) => ScimError,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at++];
    if (!token) throw this.fail('The filter ends too early');
    return token;
  }

  private keyword(word: string): boolean {
    const token = this.peek();
    if (token?.kind === 'word' && token.text.toLowerCase() === word) {
      this.at++;
      return true;
    }
    return false;
  }

  private expect(kind: Token['kind']): void {
    const token = this.next();
    if (token.kind !== kind) throw this.fail(`Expected "${kind}" at ${token.at}`);
  }

  done(): boolean {
    return this.at >= this.tokens.length;
  }

  /** How many tokens the parser has used. */
  position(): number {
    return this.at;
  }

  filter(scope?: readonly AttributeDef[]): Filter {
    if (++this.depth > MAX_DEPTH) throw this.fail('The filter is nested too deeply');
    let left = this.conjunction(scope);
    while (this.keyword('or')) left = { op: 'or', left, right: this.conjunction(scope) };
    this.depth--;
    return left;
  }

  private conjunction(scope?: readonly AttributeDef[]): Filter {
    let left = this.unary(scope);
    while (this.keyword('and')) left = { op: 'and', left, right: this.unary(scope) };
    return left;
  }

  private unary(scope?: readonly AttributeDef[]): Filter {
    if (this.keyword('not')) {
      this.expect('(');
      const inner = this.filter(scope);
      this.expect(')');
      return { op: 'not', filter: inner };
    }
    if (this.peek()?.kind === '(') {
      this.next();
      const inner = this.filter(scope);
      this.expect(')');
      return inner;
    }
    return this.attributeExpression(scope);
  }

  private attributeExpression(scope?: readonly AttributeDef[]): Filter {
    const token = this.next();
    if (token.kind !== 'word') throw this.fail(`Expected an attribute at ${token.at}`);
    const path = resolveName(this.type, token.text, scope, this.fail);
    if (this.peek()?.kind === '[') {
      if (scope) throw this.fail('Value paths cannot be nested');
      if (!path.attr.multiValued || path.sub) {
        throw this.fail(`"${token.text}" has no values to filter`);
      }
      this.next();
      const inner = this.filter(path.attr.subAttributes ?? []);
      this.expect(']');
      const sub = this.peek();
      if (sub?.kind !== 'sub') return { op: 'some', path, filter: inner };
      this.next();
      const subDef = findAttribute(path.attr.subAttributes, sub.text);
      if (!subDef) throw this.fail(`Unknown attribute "${token.text}[...].${sub.text}"`);
      return this.comparison({ ...path, sub: subDef, filter: inner });
    }
    return this.comparison(path);
  }

  private comparison(path: AttrPath): Filter {
    const op = this.next();
    if (op.kind !== 'word') throw this.fail(`Expected an operator at ${op.at}`);
    const name = op.text.toLowerCase();
    if (name === 'pr') return { op: 'pr', path };
    if (!COMPARE_OPS.has(name)) throw this.fail(`Unknown operator "${op.text}"`);
    const token = this.next();
    let value: CompareValue;
    if (token.kind === 'string' || token.kind === 'number') {
      value = token.value;
    } else if (token.kind === 'word' && ['true', 'false', 'null'].includes(token.text)) {
      value = token.text === 'null' ? null : token.text === 'true';
    } else {
      throw this.fail(`Expected a value at ${token.at}`);
    }
    return { op: name as CompareOp, path, value };
  }
}

/** Parses a `filter` query parameter for a resource type; 400 invalidFilter when it cannot. */
export function parseFilter(input: string, type: ResourceTypeDef): Filter {
  if (input.length > MAX_FILTER_LENGTH) throw invalidFilter('The filter is too long');
  const tokens = tokenize(input, invalidFilter);
  if (tokens.length === 0) throw invalidFilter('The filter is empty');
  const parser = new Parser(tokens, type, invalidFilter);
  const filter = parser.filter();
  if (!parser.done()) throw invalidFilter('Unexpected text after the filter');
  return filter;
}

/** Parses a PATCH `path`; 400 invalidPath when it does not name an attribute of the type. */
export function parsePath(input: string, type: ResourceTypeDef): AttrPath {
  const tokens = tokenize(input, invalidPath);
  const [head, open] = tokens;
  if (!head || head.kind !== 'word') throw invalidPath(`Malformed path "${input}"`);
  const path = resolveName(type, head.text, undefined, invalidPath);
  if (!open) return path;
  if (open.kind !== '[' || !path.attr.multiValued || path.sub) {
    throw invalidPath(`Malformed path "${input}"`);
  }
  const parser = new Parser(tokens.slice(2), type, invalidPath);
  const filter = parser.filter(path.attr.subAttributes ?? []);
  const rest = tokens.slice(2 + parser.position());
  if (rest[0]?.kind !== ']') throw invalidPath(`Malformed path "${input}"`);
  const sub = rest[1];
  if (rest.length > 2 || (sub && sub.kind !== 'sub'))
    throw invalidPath(`Malformed path "${input}"`);
  const result: AttrPath = { ...path, filter };
  if (sub?.kind === 'sub') {
    const subDef = findAttribute(path.attr.subAttributes, sub.text);
    if (!subDef) throw invalidPath(`Unknown attribute in "${input}"`);
    result.sub = subDef;
  }
  return result;
}

/** The URN a resource type stores an extension's attributes under, or undefined for core. */
export function containerOf(
  resource: Record<string, unknown>,
  urn: string | undefined,
): Record<string, unknown> | undefined {
  if (!urn) return resource;
  const value = resource[urn];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** The values a path selects in a resource (or, inside brackets, in one value). */
function selectValues(
  target: Record<string, unknown>,
  path: AttrPath,
  compare: boolean,
): unknown[] {
  const container = containerOf(target, path.urn);
  const raw = container?.[path.attr.name];
  if (raw === undefined || raw === null) return [];
  if (path.attr.multiValued) {
    let items = Array.isArray(raw) ? raw : [raw];
    if (path.filter) {
      const inner = path.filter;
      items = items.filter((item) => isRecord(item) && matches(item, inner));
    }
    if (path.sub) {
      const sub = path.sub.name;
      return items.map((item) => (isRecord(item) ? item[sub] : undefined));
    }
    // Comparing a multi-valued complex attribute compares its `value` (RFC 7644 3.4.2.2).
    if (compare && path.attr.type === 'complex') {
      return items.map((item) => (isRecord(item) ? item.value : undefined));
    }
    return items;
  }
  if (path.sub) return [isRecord(raw) ? raw[path.sub.name] : undefined];
  return [raw];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function comparable(def: AttributeDef, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (def.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
      return value.toLowerCase() === 'true';
    }
    return null;
  }
  if (def.type === 'dateTime') {
    const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isNaN(time) ? null : time;
  }
  if (def.type === 'integer' || def.type === 'decimal') {
    return typeof value === 'number' ? value : Number(value);
  }
  if (typeof value === 'object') return null;
  const text = String(value);
  return def.caseExact ? text : text.toLowerCase();
}

function compareOne(def: AttributeDef, op: CompareOp, actual: unknown, expected: CompareValue) {
  const a = comparable(def, actual);
  const b = comparable(def, expected);
  if (a === null || b === null) return false;
  switch (op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'co':
      return typeof a === 'string' && typeof b === 'string' && a.includes(b);
    case 'sw':
      return typeof a === 'string' && typeof b === 'string' && a.startsWith(b);
    case 'ew':
      return typeof a === 'string' && typeof b === 'string' && a.endsWith(b);
    default: {
      if (typeof a === 'boolean' || typeof b === 'boolean' || typeof a !== typeof b) return false;
      if (op === 'gt') return a > b;
      if (op === 'ge') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
  }
}

/** Whether a resource (or one value of a multi-valued attribute) matches the filter. */
export function matches(target: Record<string, unknown>, filter: Filter): boolean {
  switch (filter.op) {
    case 'and':
      return matches(target, filter.left) && matches(target, filter.right);
    case 'or':
      return matches(target, filter.left) || matches(target, filter.right);
    case 'not':
      return !matches(target, filter.filter);
    case 'pr':
      return selectValues(target, filter.path, false).some((v) => !isEmpty(v));
    case 'some': {
      const inner = filter.filter;
      return selectValues(target, filter.path, false).some((v) => isRecord(v) && matches(v, inner));
    }
    default: {
      const def = filter.path.sub ?? valueDef(filter.path.attr);
      const values = selectValues(target, filter.path, true);
      if (filter.value === null) {
        const present = values.some((v) => !isEmpty(v));
        return filter.op === 'eq' ? !present : filter.op === 'ne' ? present : false;
      }
      if (filter.op === 'ne') {
        return !values.some((v) => compareOne(def, 'eq', v, filter.value));
      }
      const { op, value } = filter;
      return values.some((v) => compareOne(def, op, v, value));
    }
  }
}

/** The definition values are compared by: a complex multi-valued attribute's `value`. */
function valueDef(def: AttributeDef): AttributeDef {
  if (def.type === 'complex' && def.multiValued) {
    return findAttribute(def.subAttributes, 'value') ?? def;
  }
  return def;
}

/**
 * Top-level `and` terms of the form `<attribute> eq <value>`, for narrowing a list in SQL
 * before the whole filter is evaluated. `emails.value` and `emails[...].value` both count as
 * `emails`; the SQL condition only needs to keep every resource the filter could match.
 */
export function equalityTerms(filter: Filter): { attribute: string; value: CompareValue }[] {
  if (filter.op === 'and') return [...equalityTerms(filter.left), ...equalityTerms(filter.right)];
  if (filter.op !== 'eq' || filter.path.urn) return [];
  const { attr, sub } = filter.path;
  if (attr.multiValued) {
    return attr.type === 'complex' && (sub === undefined || sub.name === 'value')
      ? [{ attribute: attr.name, value: filter.value }]
      : [];
  }
  return sub ? [] : [{ attribute: attr.name, value: filter.value }];
}

/** Whether the filter looks at an attribute, so lists can skip loading it otherwise. */
export function mentions(filter: Filter, name: string): boolean {
  switch (filter.op) {
    case 'and':
    case 'or':
      return mentions(filter.left, name) || mentions(filter.right, name);
    case 'not':
      return mentions(filter.filter, name);
    default:
      return filter.path.attr.name === name;
  }
}

/** The definition that a path's values have (the sub-attribute's when it names one). */
export function pathDef(path: AttrPath): AttributeDef {
  return path.sub ?? path.attr;
}

/** A schema's attributes, for callers that resolve value keys themselves. */
export function attributesOf(type: ResourceTypeDef, urn: string | undefined) {
  return urn ? (schemaFor(type, urn)?.attributes ?? []) : type.schema.attributes;
}
