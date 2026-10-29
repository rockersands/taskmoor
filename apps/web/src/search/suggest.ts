import {
  type Clause,
  parseWithDiagnostics,
  SYSTEM_FIELDS,
  scan,
  type Token,
} from '@taskmoor/query';
import { STAGES, valueWord } from './basic';

/** What the editor may offer at the caret (M1-041; QRY-001 (1)). */
export interface Suggestions {
  /** The text the chosen item replaces: the word being typed, or nothing at the caret. */
  from: number;
  to: number;
  kind: 'field' | 'operator' | 'value' | 'keyword';
  items: string[];
}

export interface SuggestContext {
  /** Custom field names the person may see. */
  customFields: string[];
  /** Track keys the person may see. */
  tracks: string[];
}

const CONNECTIVES = new Set(['AND', 'OR', 'NOT']);
const OPERATORS = ['=', '!=', '~', '!~', 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY', '<', '>'];
const AFTER_VALUE = ['AND', 'OR', 'ORDER BY'];
/** Fields people search by most, offered first; every searchable field follows. */
const FIRST = ['track', 'stage', 'status', 'assignee', 'text', 'summary', 'type', 'priority'];
const USER_FIELDS = new Set(['assignee', 'requester', 'creator']);

const upper = (t: Token | undefined) => (t?.type === 'word' ? t.text.toUpperCase() : '');
/** A custom field's name bare where the parser reads it back as that field, quoted otherwise. */
function quoteName(name: string): string {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    const { query, errors } = parseWithDiagnostics(`${name} = x`);
    const back = query.where as Clause | null;
    if (errors.length === 0 && back?.kind === 'compare' && back.field.name === name) return name;
  }
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The names offered for fields: the common ones, the other system fields, then custom ones. */
function fieldNames(context: SuggestContext): string[] {
  const system = SYSTEM_FIELDS.filter((f) => !f.module).map((f) => f.name);
  const rest = system.filter((n) => !FIRST.includes(n)).sort();
  return [
    ...FIRST.filter((n) => system.includes(n)),
    ...rest,
    ...context.customFields.map(quoteName),
  ];
}

function canonical(name: string): string {
  const lower = name.toLowerCase();
  const field = SYSTEM_FIELDS.find(
    (f) => f.name.toLowerCase() === lower || f.aliases.some((a) => a.toLowerCase() === lower),
  );
  return field?.name ?? name;
}

/** The field a value is for: the word before the operator, or before IN or NOT IN. */
function valueField(tokens: Token[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token?.type === 'op') return tokens[i - 1]?.text ?? null;
    if (upper(token) === 'IN') {
      return tokens[upper(tokens[i - 1]) === 'NOT' ? i - 2 : i - 1]?.text ?? null;
    }
    if (upper(token) === 'AND' || upper(token) === 'OR') return null;
  }
  return null;
}

/** Whether the caret is in the ORDER BY list. */
function inOrder(tokens: Token[]): boolean {
  return tokens.some((t, i) => upper(t) === 'ORDER' && upper(tokens[i + 1]) === 'BY');
}

/**
 * Suggestions for the caret in `text`: field names where a clause starts, operators after a
 * field, values after an operator (tracks, stages, people functions) and connectives after a
 * value. The word under the caret filters them by prefix, case aside.
 */
export function suggest(text: string, caret: number, context: SuggestContext): Suggestions | null {
  const before = text.slice(0, caret);
  const tokens = scan(before).tokens.filter((t) => t.type !== 'eof');
  let partial = '';
  let from = caret;
  const last = tokens.at(-1);
  if (last && last.type === 'word' && last.span.end === caret && !/\s$/.test(before)) {
    partial = last.text;
    from = last.span.start;
    tokens.pop();
  }
  const prev = tokens.at(-1);
  const prev2 = tokens.at(-2);
  const afterIn = prev?.type === 'lparen' && upper(prev2) === 'IN';
  const startsClause =
    !prev || (prev.type === 'lparen' && !afterIn) || CONNECTIVES.has(upper(prev));
  let kind: Suggestions['kind'];
  let items: string[];
  if (startsClause) {
    kind = 'field';
    items = fieldNames(context);
  } else if (upper(prev) === 'ORDER') {
    kind = 'keyword';
    items = ['BY'];
  } else if (upper(prev) === 'BY' || (prev.type === 'comma' && inOrder(tokens))) {
    kind = 'field';
    items = SYSTEM_FIELDS.filter((f) => f.sortable).map((f) => f.name);
  } else if (
    (prev.type === 'word' || prev.type === 'string') &&
    (!prev2 || prev2.type === 'lparen' || CONNECTIVES.has(upper(prev2)))
  ) {
    kind = 'operator';
    items = OPERATORS;
  } else if (prev.type === 'op' || afterIn || prev.type === 'comma') {
    const field = canonical(valueField(tokens) ?? '');
    kind = 'value';
    items =
      field === 'track'
        ? context.tracks.map(valueWord)
        : field === 'stage'
          ? [...STAGES]
          : USER_FIELDS.has(field)
            ? ['currentUser()', 'EMPTY']
            : ['EMPTY'];
  } else if (inOrder(tokens)) {
    kind = 'keyword';
    items = ['DESC', 'ASC'];
  } else {
    kind = 'keyword';
    items = AFTER_VALUE;
  }
  const needle = partial.toLowerCase().replace(/^"/, '');
  const matching = items.filter((item) => item.toLowerCase().replace(/^"/, '').startsWith(needle));
  if (matching.length === 0) return null;
  return { from, to: caret, kind, items: matching.slice(0, 12) };
}
