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

/**
 * The basic mode's choices (M1-041; QRY-001): tracks, stages, who it is assigned to and words in
 * the text. Every combination is a query; a query is basic when it is one of these.
 */
export interface BasicQuery {
  tracks: string[];
  stages: Stage[];
  assignee: 'any' | 'me' | 'none';
  text: string;
}

export const EMPTY_BASIC: BasicQuery = { tracks: [], stages: [], assignee: 'any', text: '' };

const ORDER = 'ORDER BY updated DESC';

const word = (value: string) =>
  /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
    ? value
    : printValue({ kind: 'string', value, span: { start: 0, end: 0 } });
const quoted = (value: string) => printValue({ kind: 'string', value, span: { start: 0, end: 0 } });

/** The query a basic search makes, newest change first. */
export function basicToQuery(basic: BasicQuery): string {
  const parts: string[] = [];
  const [onlyTrack] = basic.tracks;
  if (basic.tracks.length === 1 && onlyTrack) parts.push(`track = ${word(onlyTrack)}`);
  else if (basic.tracks.length > 1) parts.push(`track IN (${basic.tracks.map(word).join(', ')})`);
  const stages = STAGES.filter((s) => basic.stages.includes(s));
  if (stages.length === 1) parts.push(`stage = ${stages[0]}`);
  else if (stages.length === 2) parts.push(`stage IN (${stages.join(', ')})`);
  if (basic.assignee === 'me') parts.push('assignee = currentUser()');
  if (basic.assignee === 'none') parts.push('assignee IS EMPTY');
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

/**
 * The basic choices a query makes, or null when it says more than the basic mode can show
 * (another field, OR, NOT, another order, an error). Basic to query and back is the identity.
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
  for (const item of items) {
    const clause = item as Clause;
    if (!('field' in clause) || clause.field.custom !== undefined) return null;
    const name = clause.field.name;
    const key = ['track', 'stage', 'assignee', 'text'].find((f) => fieldIs(name, f));
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const plain = (v: { kind: string; value?: unknown }) =>
      (v.kind === 'word' || v.kind === 'string') && typeof v.value === 'string' ? v.value : null;
    if (key === 'track') {
      const values =
        clause.kind === 'compare' && clause.op === '='
          ? [clause.value]
          : clause.kind === 'in' && !clause.negated
            ? clause.values
            : null;
      const keys = values?.map(plain);
      if (!keys || keys.some((k) => k === null)) return null;
      basic.tracks = keys as string[];
    } else if (key === 'stage') {
      const values =
        clause.kind === 'compare' && clause.op === '='
          ? [clause.value]
          : clause.kind === 'in' && !clause.negated
            ? clause.values
            : null;
      const stages = values?.map((v) => plain(v)?.toLowerCase());
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
    } else {
      if (clause.kind !== 'compare' || clause.op !== '~') return null;
      const value = plain(clause.value);
      if (value === null) return null;
      basic.text = value;
    }
  }
  return basic;
}
