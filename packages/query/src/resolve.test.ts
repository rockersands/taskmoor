import { describe, expect, it } from 'vitest';
import {
  type CustomField,
  type CustomType,
  type Field,
  makeCatalogue,
  OPERATORS_BY_TYPE,
  type OperatorFamily,
  SYSTEM_FIELDS,
  takes,
} from './fields';
import { QueryError } from './lexer';
import { parseQuery } from './parser';
import { printField } from './print';
import { resolveQuery } from './resolve';

/**
 * The field and operator resolver (M1-036; QRY-002, QRY-003): every field under every name, and
 * the operator-by-field-type matrix, checked against `OPERATORS_BY_TYPE` one clause at a time.
 */
const CUSTOM_TYPES: CustomType[] = [
  'text',
  'number',
  'date',
  'datetime',
  'user',
  'group',
  'option',
  'multi',
  'cascade',
  'labels',
  'release',
  'area',
];
const CUSTOMS: CustomField[] = CUSTOM_TYPES.map((type, i) => ({
  kind: 'custom',
  id: 100 + i,
  name: `Custom ${type}`,
  type,
}));
const catalogue = makeCatalogue(CUSTOMS, { ABC: 1 });
const ctx = { currentUserId: 7, now: new Date('2026-10-28T12:00:00Z') };
const resolve = (text: string) => resolveQuery(parseQuery(text), catalogue, ctx);
const refusal = (text: string): string => {
  try {
    resolve(text);
    return 'accepted';
  } catch (e) {
    // Without the position the error ends with.
    if (e instanceof QueryError) return e.message.replace(/ at position \d+$/, '');
    throw e;
  }
};

/** A value each type reads, in query syntax. */
function sample(field: Field): string {
  switch (field.type) {
    case 'number':
      return '3';
    case 'date':
    case 'datetime':
      return '2026-01-31';
    case 'user':
      return 'currentUser()';
    case 'track':
      return 'ABC';
    case 'key':
      return 'ABC-1';
    default:
      return '"x"';
  }
}

const OPERATORS: [string, OperatorFamily, (f: string, v: string) => string][] = [
  ['=', 'equality', (f, v) => `${f} = ${v}`],
  ['!=', 'equality', (f, v) => `${f} != ${v}`],
  ['>', 'order', (f, v) => `${f} > ${v}`],
  ['>=', 'order', (f, v) => `${f} >= ${v}`],
  ['<', 'order', (f, v) => `${f} < ${v}`],
  ['<=', 'order', (f, v) => `${f} <= ${v}`],
  ['IN', 'list', (f, v) => `${f} IN (${v})`],
  ['NOT IN', 'list', (f, v) => `${f} NOT IN (${v})`],
  ['~', 'contains', (f) => `${f} ~ "word"`],
  ['!~', 'contains', (f) => `${f} !~ "word"`],
  ['IS', 'empty', (f) => `${f} IS EMPTY`],
  ['IS NOT', 'empty', (f) => `${f} IS NOT EMPTY`],
  ['WAS', 'history', (f, v) => `${f} WAS ${v}`],
  ['WAS NOT', 'history', (f, v) => `${f} WAS NOT ${v}`],
  ['WAS IN', 'history', (f, v) => `${f} WAS IN (${v})`],
  ['WAS NOT IN', 'history', (f, v) => `${f} WAS NOT IN (${v})`],
  ['CHANGED', 'history', (f) => `${f} CHANGED`],
];

const ALL_FIELDS: Field[] = [...SYSTEM_FIELDS, ...CUSTOMS];
const nameOf = (field: Field) =>
  field.kind === 'custom'
    ? `cf[${field.id}]`
    : printField({ name: field.name, span: { start: 0, end: 0 } });

describe('field and operator resolver (M1-036)', () => {
  it('[QRY-002] takes exactly the operators of each field type, all 17 on every field', () => {
    let checked = 0;
    for (const field of ALL_FIELDS) {
      for (const [op, family, clause] of OPERATORS) {
        const text = clause(nameOf(field), sample(field));
        const result = refusal(text);
        if (takes(field, family)) {
          expect(result, text).toBe('accepted');
        } else {
          // Refused, naming the field (QRY-002 (1)).
          expect(result, text).not.toBe('accepted');
          expect(result, text).toContain(`"${field.name}"`);
        }
        checked++;
      }
    }
    expect(checked).toBe(ALL_FIELDS.length * 17);
  });

  it('[QRY-002] orders only numbers, dates, releases and priorities; text only by words', () => {
    const ordered = Object.entries(OPERATORS_BY_TYPE)
      .filter(([, families]) => families.includes('order'))
      .map(([type]) => type)
      .sort();
    expect(ordered).toEqual(['date', 'datetime', 'number', 'priority', 'release']);
    expect(refusal('"Custom number" ~ "3"')).toBe(
      '"Custom number" (cf[101]) is not a text field; ~ needs one',
    );
    expect(refusal('summary = "login"')).toBe(
      '"summary" is a text field: use ~ or !~ to search it, not =',
    );
    expect(refusal('attachments = "x"')).toBe('"attachments" only takes IS EMPTY and IS NOT EMPTY');
    expect(refusal('status > Done')).toBe(
      '"status" cannot be compared with >; its values have no order',
    );
    expect(refusal('votes WAS 3')).toBe('"votes" keeps no change history');
    // EMPTY works with = and != wherever IS does.
    expect(refusal('summary = EMPTY')).toBe('accepted');
    expect(refusal('priority != EMPTY')).toBe('accepted');
  });

  it('[QRY-002] takes 1,000 values in IN', () => {
    const values = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(', ');
    const plan = resolve(`assignee IN (${values})`);
    expect(plan.where).toMatchObject({ kind: 'in' });
    expect((plan.where as { values: unknown[] }).values).toHaveLength(1000);
  });

  it('[QRY-003] resolves every system field by its native, Jira-compatible and display names', () => {
    for (const field of SYSTEM_FIELDS) {
      const op = takes(field, 'empty') ? 'IS EMPTY' : 'CHANGED';
      for (const name of [field.name, ...field.aliases, field.name.toUpperCase()]) {
        const plan = resolve(`${printField({ name, span: { start: 0, end: 0 } })} ${op}`);
        expect((plan.where as { field: Field }).field, name).toBe(field);
      }
    }
  });

  it('[QRY-003] project = ABC AND issuetype = Bug is track = ABC AND type = Bug', () => {
    expect(resolve('project = ABC AND issuetype = Bug')).toEqual(
      resolve('track = ABC AND type = Bug'),
    );
    expect(resolve('fixVersion = "1.0" AND component = API AND reporter = currentUser()')).toEqual(
      resolve('targetRelease = "1.0" AND area = API AND requester = currentUser()'),
    );
  });

  it('[QRY-003] finds custom fields by name or id, and names the ids of an ambiguous name', () => {
    expect(resolve('"Custom number" > 2')).toEqual(resolve('cf[101] > 2'));
    const twice = makeCatalogue(
      [
        { kind: 'custom', id: 7, name: 'Team', type: 'option' },
        { kind: 'custom', id: 9, name: 'team', type: 'option' },
      ],
      {},
    );
    expect(() => resolveQuery(parseQuery('Team = Red'), twice, ctx)).toThrow(
      /^Several custom fields are called "Team" \(cf\[7\], cf\[9\]\); name one by its id/,
    );
    expect(resolveQuery(parseQuery('cf[9] = Red'), twice, ctx).where).toMatchObject({
      field: { id: 9 },
    });
    // A system field wins over a custom field of its name.
    const shadow = makeCatalogue([{ kind: 'custom', id: 5, name: 'Status', type: 'option' }], {});
    expect(resolveQuery(parseQuery('status = Done'), shadow, ctx).where).toMatchObject({
      field: { kind: 'system', name: 'status' },
    });
    expect(() => resolve('cf[999] = 1')).toThrow('Unknown field cf[999]');
  });

  it('[QRY-005] WAS takes EMPTY, and its predicates in any order', () => {
    expect(resolve('assignee WAS EMPTY').where).toMatchObject({ kind: 'history', empty: true });
    expect(resolve('status WAS Done BY currentUser() AFTER -1w')).toEqual(
      resolve('status WAS Done AFTER -1w BY currentUser()'),
    );
  });

  it('[QRY-005] [QRY-006] reads ON as the whole day on the person’s calendar, and FROM EMPTY', () => {
    const on = (q: string, timeZone: string) => {
      const plan = resolveQuery(parseQuery(q), makeCatalogue(), {
        currentUserId: 7,
        now: new Date('2026-10-12T12:00:00Z'),
        timeZone,
      });
      const where = plan.where as { predicates: { kind: string; values: { value: Date }[] }[] };
      return where.predicates
        .find((p) => p.kind === 'on')
        ?.values.map((v) => v.value.toISOString());
    };
    expect(on('status CHANGED ON 2026-01-15', 'UTC')).toEqual([
      '2026-01-15T00:00:00.000Z',
      '2026-01-16T00:00:00.000Z',
    ]);
    // Madrid moves its clocks forward on 29 March 2026: that day has 23 hours.
    expect(on('status WAS Done ON 2026-03-29', 'Europe/Madrid')).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T22:00:00.000Z',
    ]);
    // A relative date names the day it falls on.
    expect(on('status CHANGED ON -1d', 'UTC')).toEqual([
      '2026-10-11T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
    ]);
    expect(resolve('assignee CHANGED FROM (EMPTY, 7) TO EMPTY').where).toMatchObject({
      predicates: [
        { kind: 'from', empty: true, values: [{ type: 'number', value: 7 }] },
        { kind: 'to', empty: true, values: [] },
      ],
    });
    expect(refusal('status WAS Done FROM New')).toBe(
      'FROM goes with CHANGED; WAS takes AFTER, BEFORE, BY, DURING and ON',
    );
    expect(refusal('updated CHANGED')).toBe('"updated" keeps no change history');
  });

  it('[QRY-006] reads dates with dashes or slashes, with or without a time', () => {
    expect(resolve('created >= 2026/01/31')).toEqual(resolve('created >= 2026-01-31'));
    expect(resolve('created >= "2026/01/31 14:05"')).toEqual(
      resolve('created >= "2026-01-31 14:05"'),
    );
  });
});
