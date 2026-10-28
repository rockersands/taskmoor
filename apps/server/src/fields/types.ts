import type { JsonValue } from '@taskmoor/db';
import { checkLabels } from '../tickets/fields';
import { canonicalJson, checkRichText, isCalendarDay } from '../tickets/model';

/**
 * The custom field type catalogue (M1-010; CORE-010, spec 01a section 1.4). For each type it
 * says how a value is read from input (REST, a workflow effect, an import), how the ticket's
 * `fields` document stores it (ADR-008), how it reads as text for history and CSV and back, how
 * values sort, and how REST shows it. Empty values are never stored: an empty input clears the
 * field, so "is empty" is "has no key".
 *
 * Stored forms:
 * - text, read-only text, URL: the string; paragraph: the ProseMirror document (ADR-014)
 * - number: a JSON number from -10^12 to 10^12, rounded half away from zero to 0.001
 * - date: YYYY-MM-DD; date-time: the instant in UTC as an ISO string
 * - select, user, group, release, area: an id, or ids in ascending order for a multiple field
 * - cascading select: [parent option id] or [parent, child]
 * - labels: the labels in the order given, each once
 */
export const FIELD_TYPES = [
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'select',
  'cascading-select',
  'user',
  'group',
  'labels',
  'url',
  'read-only-text',
  'release',
  'area',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that hold one value or several; the choice is made at creation and never changes. */
export const MULTIPLE_TYPES: ReadonlySet<FieldType> = new Set([
  'select',
  'user',
  'group',
  'release',
  'area',
]);

/** Types whose values name other objects, and which objects. */
export type Reference = 'option' | 'user' | 'group' | 'release' | 'area';
export const REFERENCE_OF: Readonly<Partial<Record<FieldType, Reference>>> = {
  select: 'option',
  'cascading-select': 'option',
  user: 'user',
  group: 'group',
  release: 'release',
  area: 'area',
};

/** The side table M1-011 indexes a type's values in (ADR-008). */
export const STORAGE_OF: Readonly<
  Record<FieldType, 'text' | 'number' | 'date' | 'user' | 'option'>
> = {
  text: 'text',
  paragraph: 'text',
  number: 'number',
  date: 'date',
  datetime: 'date',
  select: 'option',
  'cascading-select': 'option',
  user: 'user',
  group: 'option',
  labels: 'text',
  url: 'text',
  'read-only-text': 'text',
  release: 'option',
  area: 'option',
};

export const TEXT_MAX = 255;
export const URL_MAX = 2000;
export const PARAGRAPH_DEFAULT_MAX = 32_767;
export const PARAGRAPH_LIMIT = 100_000;
export const NUMBER_LIMIT = 1e12;
/** Values of one multiple field on one ticket. */
export const VALUES_MAX = 1000;
export const NUMBER_FORMATS = ['number', 'currency', 'percentage'] as const;
export const SELECT_DISPLAYS = ['dropdown', 'radio', 'checkboxes'] as const;

/** Type settings; the ones a type does not use are left out. */
export interface FieldConfig {
  /** Paragraph: the most characters of text, 1 to 100,000 (32,767 when left out). */
  maxChars?: number;
  /** Number: how it shows; the stored value is the same for every format. */
  format?: (typeof NUMBER_FORMATS)[number];
  /** Number: decimals shown, 0 to 3. */
  decimals?: number;
  /** Number with the currency format: an ISO 4217 code. */
  currency?: string;
  /** Select: how the picker presents the options. */
  display?: (typeof SELECT_DISPLAYS)[number];
}

export interface FieldShape {
  type: FieldType;
  multiple: boolean;
  config: FieldConfig;
}

export type Stored = string | number | readonly number[] | readonly string[] | JsonValue;
export type ValueProblem = 'invalid' | 'too_long' | 'too_many' | 'out_of_range';
/** A value read from input: `value` undefined is empty (the field is cleared). */
export type Parsed = { ok: true; value: Stored | undefined } | { ok: false; problem: ValueProblem };

const ok = (value: Stored | undefined): Parsed => ({ ok: true, value });
const bad = (problem: ValueProblem): Parsed => ({ ok: false, problem });
const EMPTY = ok(undefined);

const MAX_ID = 2_147_483_647;

/** An id as a number, a string of digits, or an object with an `id` (the REST form). */
export function idOf(input: unknown): number | null {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'id' in input) {
    return idOf((input as { id: unknown }).id);
  }
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 && input <= MAX_ID ? input : null;
  }
  if (typeof input === 'string' && /^[1-9][0-9]{0,9}$/.test(input)) {
    const n = Number(input);
    return n <= MAX_ID ? n : null;
  }
  return null;
}

const ascending = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

function references(input: unknown, multiple: boolean): Parsed {
  if (input === null || input === undefined || input === '') return EMPTY;
  if (!multiple) {
    const id = idOf(input);
    return id === null ? bad('invalid') : ok(id);
  }
  if (!Array.isArray(input)) return bad('invalid');
  if (input.length > VALUES_MAX) return bad('too_many');
  const ids: number[] = [];
  for (const item of input) {
    const id = idOf(item);
    if (id === null) return bad('invalid');
    ids.push(id);
  }
  return ids.length === 0 ? EMPTY : ok(ascending(ids));
}

/** Parent and optional child: `{parent, child}`, `[parent, child]` or the REST form. */
function cascade(input: unknown): Parsed {
  if (input === null || input === undefined || input === '') return EMPTY;
  let parent: unknown;
  let child: unknown;
  if (Array.isArray(input)) {
    if (input.length === 0) return EMPTY;
    if (input.length > 2) return bad('invalid');
    [parent, child] = input;
  } else if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if ('parent' in o) [parent, child] = [o.parent, o.child];
    else [parent, child] = [o.id, o.child];
  } else {
    parent = input;
  }
  const p = idOf(parent);
  if (p === null) return bad('invalid');
  if (child === undefined || child === null) return ok([p]);
  const c = idOf(child);
  return c === null || c === p ? bad('invalid') : ok([p, c]);
}

/** One line of text: trimmed, no line breaks or other control characters. */
function line(input: unknown, max: number): Parsed {
  if (input === null || input === undefined) return EMPTY;
  if (typeof input !== 'string') return bad('invalid');
  const s = input.trim();
  if (s === '') return EMPTY;
  if ([...s].some((c) => (c.codePointAt(0) as number) < 0x20 || c === '\u007f')) {
    return bad('invalid');
  }
  return [...s].length > max ? bad('too_long') : ok(s);
}

function url(input: unknown): Parsed {
  const text = line(input, URL_MAX);
  if (!text.ok || text.value === undefined) return text;
  const s = text.value as string;
  if (/\s/.test(s)) return bad('invalid');
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? ok(s) : bad('invalid');
  } catch {
    return bad('invalid');
  }
}

/**
 * A decimal read exactly from its digits and rounded half away from zero to 0.001: "1.23456"
 * is 1.235 and 1.2345 is 1.235 too, though the nearest binary double of 1.2345 lies below it.
 * Scientific notation is accepted ("5e3" is 5000).
 */
export function roundedNumber(input: unknown): Parsed {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return bad('invalid');
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
    if (text === '') return EMPTY;
  } else if (input === null || input === undefined) {
    return EMPTY;
  } else {
    return bad('invalid');
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(text);
  if (!m || text.length > 100) return bad('invalid');
  const [, sign, whole = '', fraction = '', exp = '0'] = m;
  if (whole === '' && fraction === '') return bad('invalid');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  let mantissa = BigInt(digits === '' ? '0' : digits);
  // The value is mantissa x 10^shift; we want it x 1000, rounded to an integer.
  const shift = Number(exp) - fraction.length + 3;
  if (mantissa !== 0n && shift > 20) return bad('out_of_range');
  if (shift >= 0) {
    mantissa *= 10n ** BigInt(shift);
  } else if (-shift > 40) {
    mantissa = 0n;
  } else {
    const d = 10n ** BigInt(-shift);
    const q = mantissa / d;
    mantissa = 2n * (mantissa % d) >= d ? q + 1n : q;
  }
  if (mantissa > BigInt(NUMBER_LIMIT) * 1000n) return bad('out_of_range');
  const value = Number(mantissa) / 1000;
  return ok(sign === '-' && value !== 0 ? -value : value);
}

/** An instant with its offset, kept as the same instant in UTC. */
function instant(input: unknown): Parsed {
  if (input === null || input === undefined || input === '') return EMPTY;
  if (typeof input !== 'string') return bad('invalid');
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      input.trim(),
    );
  if (!m) return bad('invalid');
  const [, day, hh, mm, ss = '00', , zone] = m;
  if (!isCalendarDay(day as string) || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    return bad('invalid');
  }
  if (zone !== 'Z' && (Number(zone?.slice(1, 3)) > 18 || Number(zone?.slice(4)) > 59)) {
    return bad('invalid');
  }
  const at = new Date(input.trim());
  if (Number.isNaN(at.getTime())) return bad('invalid');
  const year = at.getUTCFullYear();
  return year < 1000 || year > 9999 ? bad('out_of_range') : ok(at.toISOString());
}

function paragraph(input: unknown, config: FieldConfig): Parsed {
  if (input === null || input === undefined) return EMPTY;
  const checked = checkRichText(input);
  if (!checked.ok) return bad(checked.problem);
  if (checked.doc === null) return EMPTY;
  const max = config.maxChars ?? PARAGRAPH_DEFAULT_MAX;
  return [...plainText(checked.doc)].length > max ? bad('too_long') : ok(checked.doc);
}

function labels(input: unknown): Parsed {
  if (input === null || input === undefined || input === '') return EMPTY;
  if (!Array.isArray(input) || !input.every((l) => typeof l === 'string')) return bad('invalid');
  const checked = checkLabels(input as string[]);
  if (!checked.ok) return bad(checked.problem);
  return checked.labels.length === 0 ? EMPTY : ok(checked.labels);
}

/** The text of a rich text document, blocks separated by line breaks. */
export function plainText(doc: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      if (n.type !== 'doc' && n.type !== 'text') out.push('\n');
    }
  };
  walk(doc);
  return out.join('').trim();
}

/** Reads a value given for a field. */
export function parseValue(field: FieldShape, input: unknown): Parsed {
  switch (field.type) {
    case 'text':
    case 'read-only-text':
      return line(input, TEXT_MAX);
    case 'paragraph':
      return paragraph(input, field.config);
    case 'number':
      return roundedNumber(input);
    case 'date':
      if (input === null || input === undefined || input === '') return EMPTY;
      return typeof input === 'string' && isCalendarDay(input.trim())
        ? ok(input.trim())
        : bad('invalid');
    case 'datetime':
      return instant(input);
    case 'select':
    case 'user':
    case 'group':
    case 'release':
    case 'area':
      return references(input, field.multiple);
    case 'cascading-select':
      return cascade(input);
    case 'labels':
      return labels(input);
    case 'url':
      return url(input);
  }
}

/** The ids a stored value names, for types that name objects. */
export function referencedIds(field: FieldShape, value: Stored): number[] {
  if (REFERENCE_OF[field.type] === undefined) return [];
  return Array.isArray(value) ? (value as number[]) : [value as number];
}

/**
 * A stored value as one line of text, for history and CSV: ids for references (comma between
 * values, a colon between a cascade's parent and child), labels by spaces, canonical JSON for
 * rich text. `deserialise` reads it back.
 */
export function serialise(field: FieldShape, value: Stored): string {
  switch (field.type) {
    case 'paragraph':
      return canonicalJson(value);
    case 'number':
      return String(value);
    case 'cascading-select':
      return (value as number[]).join(':');
    case 'labels':
      return (value as string[]).join(' ');
    case 'select':
    case 'user':
    case 'group':
    case 'release':
    case 'area':
      return field.multiple ? (value as number[]).join(',') : String(value);
    default:
      return value as string;
  }
}

export function deserialise(field: FieldShape, text: string): Parsed {
  if (text === '') return EMPTY;
  switch (field.type) {
    case 'paragraph':
      try {
        return parseValue(field, JSON.parse(text));
      } catch {
        return bad('invalid');
      }
    case 'cascading-select':
      return parseValue(field, text.split(':'));
    case 'labels':
      return parseValue(field, text.split(' '));
    case 'select':
    case 'user':
    case 'group':
    case 'release':
    case 'area':
      return parseValue(field, field.multiple ? text.split(',') : text);
    default:
      return parseValue(field, text);
  }
}

/**
 * Where a referenced object sorts and what it is called: options in their order, people,
 * groups and areas by name, releases in their order. `name` is null for an object that is gone.
 */
export interface Resolver {
  rank(ref: Reference, id: number): string | number;
  name(ref: Reference, id: number): string | null;
}

type Key = string | number;

/** Case-folded for ordering; ties fall back to the text as written. */
const fold = (s: string) => s.normalize('NFKC').toLowerCase();

/** Code point order, as the C collation orders UTF-8 bytes (not UTF-16 code units). */
export function compareText(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) as number) - (y[i]?.codePointAt(0) as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function compareKey(a: Key, b: Key): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return compareText(a, b);
}

function compareKeys(a: readonly Key[], b: readonly Key[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareKey(a[i] as Key, b[i] as Key);
    if (d !== 0) return d;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** The sort key of a value: compared element by element, numbers before text. */
export function sortKey(field: FieldShape, value: Stored, resolver: Resolver): Key[] {
  const text = (s: string) => [fold(s), s];
  switch (field.type) {
    case 'number':
      return [value as number];
    case 'date':
    case 'datetime':
      return [value as string];
    case 'paragraph':
      return text(plainText(value));
    case 'labels': {
      // Every label without case first, then as written: case only breaks ties.
      const sorted = [...(value as string[])].sort((a, b) => compareKeys(text(a), text(b)));
      return [...sorted.map(fold), ...sorted];
    }
    case 'cascading-select':
      return (value as number[]).flatMap((id) => [resolver.rank('option', id), id]);
    case 'select':
    case 'user':
    case 'group':
    case 'release':
    case 'area': {
      const ref = REFERENCE_OF[field.type] as Reference;
      const pairs = (field.multiple ? (value as number[]) : [value as number]).map((id): Key[] => [
        resolver.rank(ref, id),
        id,
      ]);
      return pairs.sort(compareKeys).flat();
    }
    default:
      return text(value as string);
  }
}

/**
 * Orders two values of a field, empty after every value (Postgres orders nulls last when
 * ascending, so the query engine can walk an index the same way).
 */
export function compareValues(
  field: FieldShape,
  a: Stored | undefined,
  b: Stored | undefined,
  resolver: Resolver,
): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return compareKeys(sortKey(field, a, resolver), sortKey(field, b, resolver));
}

/**
 * A value as REST shows it: references as `{id, value}` for options and `{id, name}`
 * otherwise, a cascade as its parent option with `child`. `parseValue` reads every one of
 * these forms back to the same stored value.
 */
export function restValue(field: FieldShape, value: Stored, resolver: Resolver): JsonValue {
  const ref = REFERENCE_OF[field.type];
  if (ref === undefined) return value as JsonValue;
  const one = (r: Reference, id: number) =>
    r === 'option' ? { id, value: resolver.name(r, id) } : { id, name: resolver.name(r, id) };
  if (field.type === 'cascading-select') {
    const [parent, child] = value as number[];
    return {
      ...one('option', parent as number),
      child: child === undefined ? null : one('option', child),
    };
  }
  return field.multiple ? (value as number[]).map((id) => one(ref, id)) : one(ref, value as number);
}
