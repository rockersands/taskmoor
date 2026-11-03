import {
  type Clause,
  type Expr,
  parseWithDiagnostics,
  printValue,
  SYSTEM_FIELDS,
} from '@taskmoor/query';

/** A ticket's stage, as the query language names it. */
export type Stage = 'new' | 'active' | 'closed';
export const STAGES: readonly Stage[] = ['new', 'active', 'closed'];

/** The fields a basic search can choose values of, under their native names, in query order. */
export const CHOICE_FIELDS = [
  'type',
  'priority',
  'labels',
  'requester',
  'creator',
  'targetRelease',
  'foundInRelease',
  'area',
] as const;
export type ChoiceField = (typeof CHOICE_FIELDS)[number];

/** The fields a basic search can filter by date, in query order. */
export const DATE_FIELDS = ['created', 'updated', 'due', 'start', 'closed'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

/** Date and time fields hold an instant; the others hold a day. */
const HOLDS_INSTANT: ReadonlySet<DateField> = new Set(['created', 'updated', 'closed']);

export const DATE_OPS = ['on', 'before', 'after', 'between'] as const;
export type DateOp = (typeof DATE_OPS)[number];

/**
 * A date filter: on `from`, before it, after it, or from `from` to `to`, both days included. The
 * days are read in the person's own time zone, as every query's dates are (QRY-006). A filter
 * without its days yet is on the form but not in the query.
 */
export interface DateFilter {
  field: DateField;
  op: DateOp;
  from: string;
  to?: string;
}

/** Stands for the person searching in the people fields: `currentUser()` in the query. */
export const ME = 'currentUser()';

/** People fields, which also take `currentUser()`. */
const PEOPLE_FIELDS: ReadonlySet<ChoiceField> = new Set(['requester', 'creator']);

/**
 * The basic mode's choices (M1-041; QRY-001, QRY-014): tracks, stages, who it is assigned to and
 * words in the text, and the filters a person added: values of a field and dates. Every
 * combination is a query; a query is basic when it is one of these. A filter added with nothing
 * chosen yet is an empty list or a date filter without days, and adds nothing to the query.
 */
export interface BasicQuery {
  tracks: string[];
  stages: Stage[];
  assignee: 'any' | 'me' | 'none';
  text: string;
  choices?: Partial<Record<ChoiceField, string[]>>;
  dates?: DateFilter[];
}

export const EMPTY_BASIC: BasicQuery = { tracks: [], stages: [], assignee: 'any', text: '' };

const ORDER = 'ORDER BY updated DESC';

const quoted = (value: string) => printValue({ kind: 'string', value, span: { start: 0, end: 0 } });

/**
 * A track key bare where the parser reads it back as that word, quoted otherwise: a key that is
 * a word of the grammar (ON, IN, OR, EMPTY, ...) would not parse or would mean something else.
 */
export function valueWord(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    const { query, errors } = parseWithDiagnostics(`track = ${value}`);
    const back = query.where as Clause | null;
    if (
      errors.length === 0 &&
      back?.kind === 'compare' &&
      back.value.kind === 'word' &&
      back.value.value === value
    ) {
      return value;
    }
  }
  return quoted(value);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether this is a day of the calendar written as YYYY-MM-DD. */
export function isDay(value: string | undefined): value is string {
  const m = DAY.exec(value ?? '');
  if (!m) return false;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.toISOString().slice(0, 10) === value;
}

/** The day `days` after a day of the calendar. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** A date filter's clauses, or none while it lacks its days. */
function dateClauses({ field, op, from, to }: DateFilter): string[] {
  if (!isDay(from) || (op === 'between' && !isDay(to))) return [];
  const until = to as string;
  if (HOLDS_INSTANT.has(field)) {
    // An instant is on a day from that midnight up to the next one, so a day's last moment counts.
    switch (op) {
      case 'on':
        return [`${field} >= ${from}`, `${field} < ${addDays(from, 1)}`];
      case 'before':
        return [`${field} < ${from}`];
      case 'after':
        return [`${field} >= ${addDays(from, 1)}`];
      case 'between':
        return [`${field} >= ${from}`, `${field} < ${addDays(until, 1)}`];
    }
  }
  switch (op) {
    case 'on':
      return [`${field} = ${from}`];
    case 'before':
      return [`${field} < ${from}`];
    case 'after':
      return [`${field} > ${from}`];
    case 'between':
      return [`${field} >= ${from}`, `${field} <= ${until}`];
  }
}

const choiceValue = (field: ChoiceField, value: string) =>
  PEOPLE_FIELDS.has(field) && value === ME ? ME : valueWord(value);

/** The query a basic search makes, newest change first. */
export function basicToQuery(basic: BasicQuery): string {
  const parts: string[] = [];
  const [onlyTrack] = basic.tracks;
  if (basic.tracks.length === 1 && onlyTrack) parts.push(`track = ${valueWord(onlyTrack)}`);
  else if (basic.tracks.length > 1)
    parts.push(`track IN (${basic.tracks.map(valueWord).join(', ')})`);
  const stages = STAGES.filter((s) => basic.stages.includes(s));
  if (stages.length === 1) parts.push(`stage = ${stages[0]}`);
  else if (stages.length === 2) parts.push(`stage IN (${stages.join(', ')})`);
  if (basic.assignee === 'me') parts.push('assignee = currentUser()');
  if (basic.assignee === 'none') parts.push('assignee IS EMPTY');
  for (const field of CHOICE_FIELDS) {
    const values = (basic.choices?.[field] ?? []).map((v) => choiceValue(field, v));
    if (values.length === 1) parts.push(`${field} = ${values[0]}`);
    else if (values.length > 1) parts.push(`${field} IN (${values.join(', ')})`);
  }
  for (const field of DATE_FIELDS) {
    const filter = basic.dates?.find((d) => d.field === field);
    if (filter) parts.push(...dateClauses(filter));
  }
  const text = basic.text.trim();
  if (text) parts.push(`text ~ ${quoted(text)}`);
  return parts.length > 0 ? `${parts.join(' AND ')} ${ORDER}` : ORDER;
}

/** The field a name means, by its name or an alias, case aside. */
function fieldIs(name: string, wanted: string): boolean {
  const field = SYSTEM_FIELDS.find((f) => f.name === wanted);
  const lower = name.toLowerCase();
  return lower === wanted.toLowerCase() || !!field?.aliases.some((a) => a.toLowerCase() === lower);
}

/** The date filter a field's clauses say, or null when they say something else. */
function readDateFilter(
  field: DateField,
  clauses: readonly { op: string; day: string }[],
): DateFilter | null {
  const instant = HOLDS_INSTANT.has(field);
  const [first, second] = clauses;
  if (!first || clauses.length > 2) return null;
  if (!second) {
    const { op, day } = first;
    if (op === '<') return { field, op: 'before', from: day };
    if (op === '>=') return { field, op: 'after', from: addDays(day, -1) };
    if (instant) return null; // `=`, `>` and `<=` name an instant, not a day.
    if (op === '=') return { field, op: 'on', from: day };
    if (op === '>') return { field, op: 'after', from: day };
    if (op === '<=') return { field, op: 'before', from: addDays(day, 1) };
    return null;
  }
  const lower = clauses.find((c) => c.op === '>=');
  const upper = clauses.find((c) => c.op === (instant ? '<' : '<='));
  if (!lower || !upper) return null;
  if (!instant) return { field, op: 'between', from: lower.day, to: upper.day };
  const last = addDays(upper.day, -1);
  return last === lower.day
    ? { field, op: 'on', from: lower.day }
    : { field, op: 'between', from: lower.day, to: last };
}

/**
 * The basic choices a query makes, or null when it says more than the basic mode can show
 * (another field, OR, NOT, another order, a date as a time or relative to now, an error). Basic to
 * query and back is the identity.
 */
export function queryToBasic(text: string): BasicQuery | null {
  const { query, errors } = parseWithDiagnostics(text);
  if (errors.length > 0) return null;
  const order = query.orderBy;
  if (
    order.length > 1 ||
    (order.length === 1 &&
      !(fieldIs(order[0]?.field.name ?? '', 'updated') && order[0]?.direction === 'desc'))
  ) {
    return null;
  }
  const items: Expr[] =
    query.where === null ? [] : query.where.kind === 'and' ? query.where.items : [query.where];
  const basic: BasicQuery = { tracks: [], stages: [], assignee: 'any', text: '' };
  const seen = new Set<string>();
  const dated = new Map<DateField, { op: string; day: string }[]>();
  for (const item of items) {
    const clause = item as Clause;
    if (!('field' in clause) || clause.field.custom !== undefined) return null;
    const name = clause.field.name;
    const plain = (v: { kind: string; value?: unknown }) =>
      (v.kind === 'word' || v.kind === 'string') && typeof v.value === 'string' ? v.value : null;
    const dateField = DATE_FIELDS.find((f) => fieldIs(name, f));
    if (dateField) {
      if (clause.kind !== 'compare') return null;
      const day = plain(clause.value)?.replace(/\//g, '-');
      if (!isDay(day)) return null;
      dated.set(dateField, [...(dated.get(dateField) ?? []), { op: clause.op, day }]);
      continue;
    }
    const key = [...CHOICE_FIELDS, 'track', 'stage', 'assignee', 'text'].find((f) =>
      fieldIs(name, f),
    );
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const listed =
      clause.kind === 'compare' && clause.op === '='
        ? [clause.value]
        : clause.kind === 'in' && !clause.negated
          ? clause.values
          : null;
    if (key === 'track') {
      const keys = listed?.map(plain);
      if (!keys || keys.some((k) => k === null)) return null;
      basic.tracks = keys as string[];
    } else if (key === 'stage') {
      const stages = listed?.map((v) => plain(v)?.toLowerCase());
      if (!stages || stages.some((s) => !STAGES.includes(s as Stage))) return null;
      basic.stages = STAGES.filter((s) => stages.includes(s));
      if (basic.stages.length === 3) basic.stages = [];
    } else if (key === 'assignee') {
      if (
        clause.kind === 'compare' &&
        clause.op === '=' &&
        clause.value.kind === 'function' &&
        clause.value.name.toLowerCase() === 'currentuser' &&
        clause.value.args.length === 0
      ) {
        basic.assignee = 'me';
      } else if (clause.kind === 'empty' && !clause.negated) {
        basic.assignee = 'none';
      } else {
        return null;
      }
    } else if (key === 'text') {
      if (clause.kind !== 'compare' || clause.op !== '~') return null;
      const value = plain(clause.value);
      if (value === null) return null;
      basic.text = value;
    } else {
      const field = key as ChoiceField;
      const people = PEOPLE_FIELDS.has(field);
      const values = listed?.map((v) => {
        if (
          people &&
          v.kind === 'function' &&
          v.name.toLowerCase() === 'currentuser' &&
          v.args.length === 0
        ) {
          return ME;
        }
        const value = plain(v);
        // Quoted, that spelling is a person's name, which the form cannot tell from "me".
        return people && value === ME ? null : value;
      });
      if (!values || values.length === 0 || values.some((v) => v === null)) return null;
      basic.choices = { ...basic.choices, [field]: values as string[] };
    }
  }
  const dates: DateFilter[] = [];
  for (const field of DATE_FIELDS) {
    const clauses = dated.get(field);
    if (!clauses) continue;
    const filter = readDateFilter(field, clauses);
    if (!filter) return null;
    dates.push(filter);
  }
  if (dates.length > 0) basic.dates = dates;
  return basic;
}
