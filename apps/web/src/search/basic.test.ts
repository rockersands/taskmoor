import { makeCatalogue, parseQuery, resolveQuery } from '@taskmoor/query';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  type BasicQuery,
  basicToQuery,
  CHOICE_FIELDS,
  DATE_FIELDS,
  type DateFilter,
  EMPTY_BASIC,
  ME,
  queryToBasic,
  STAGES,
} from './basic';

describe('the basic search mode (M1-041)', () => {
  it('[QRY-001] makes a query of the choices', () => {
    expect(
      basicToQuery({ tracks: ['SHOP'], stages: ['new', 'active'], assignee: 'me', text: 'refund' }),
    ).toBe(
      'track = SHOP AND stage IN (new, active) AND assignee = currentUser() AND text ~ "refund" ORDER BY updated DESC',
    );
    expect(basicToQuery({ tracks: [], stages: [], assignee: 'none', text: ' say "hi" ' })).toBe(
      'assignee IS EMPTY AND text ~ "say \\"hi\\"" ORDER BY updated DESC',
    );
    expect(basicToQuery({ tracks: [], stages: [], assignee: 'any', text: '' })).toBe(
      'ORDER BY updated DESC',
    );
  });

  it('[QRY-001] reads the basic choices back from a query in any spelling it accepts', () => {
    expect(queryToBasic('project in (SHOP, OPS) and statusCategory = Active')).toEqual({
      tracks: ['SHOP', 'OPS'],
      stages: ['active'],
      assignee: 'any',
      text: '',
    });
    expect(queryToBasic('assignee is empty order by updated desc')).toMatchObject({
      assignee: 'none',
    });
  });

  it('[QRY-001] says when a query goes beyond the basic mode', () => {
    for (const text of [
      'status = Active',
      'track = SHOP OR track = OPS',
      'NOT stage = closed',
      'track = SHOP AND track = OPS',
      'assignee = kalo',
      'stage != closed',
      'text !~ refund',
      'ORDER BY created DESC',
      'track = ',
      'cf[10] = x',
    ]) {
      expect(queryToBasic(text), text).toBeNull();
    }
  });

  it('[QRY-001] quotes a track key that is a word of the grammar', () => {
    for (const key of ['ON', 'IN', 'OR', 'EMPTY', 'ORDER']) {
      const text = basicToQuery({ tracks: [key], stages: [], assignee: 'any', text: '' });
      expect(text).toBe(`track = "${key}" ORDER BY updated DESC`);
      expect(queryToBasic(text)?.tracks).toEqual([key]);
    }
    expect(basicToQuery({ tracks: ['SHOP'], stages: [], assignee: 'any', text: '' })).toBe(
      'track = SHOP ORDER BY updated DESC',
    );
  });

  const dated = (...dates: DateFilter[]) => basicToQuery({ ...EMPTY_BASIC, dates });
  const clauses = (query: string) => query.replace(' ORDER BY updated DESC', '');

  it('[QRY-014] [QRY-006] makes each date filter a plain query, a day whole on either kind of field', () => {
    // A date and time: from that day's midnight up to the next one.
    expect(clauses(dated({ field: 'created', op: 'on', from: '2026-10-31' }))).toBe(
      'created >= 2026-10-31 AND created < 2026-11-01',
    );
    expect(clauses(dated({ field: 'updated', op: 'before', from: '2026-10-31' }))).toBe(
      'updated < 2026-10-31',
    );
    expect(clauses(dated({ field: 'closed', op: 'after', from: '2026-10-31' }))).toBe(
      'closed >= 2026-11-01',
    );
    expect(
      clauses(dated({ field: 'created', op: 'between', from: '2026-01-01', to: '2026-12-31' })),
    ).toBe('created >= 2026-01-01 AND created < 2027-01-01');
    // A day: compared as it is.
    expect(clauses(dated({ field: 'due', op: 'on', from: '2026-10-31' }))).toBe('due = 2026-10-31');
    expect(clauses(dated({ field: 'start', op: 'after', from: '2026-10-31' }))).toBe(
      'start > 2026-10-31',
    );
    expect(
      clauses(dated({ field: 'due', op: 'between', from: '2026-10-01', to: '2026-10-31' })),
    ).toBe('due >= 2026-10-01 AND due <= 2026-10-31');
    // Without its days a filter is on the form but not in the query.
    expect(clauses(dated({ field: 'due', op: 'on', from: '' }))).toBe('ORDER BY updated DESC');
    expect(clauses(dated({ field: 'due', op: 'between', from: '2026-10-01' }))).toBe(
      'ORDER BY updated DESC',
    );
    expect(clauses(dated({ field: 'due', op: 'on', from: '2026-02-31' }))).toBe(
      'ORDER BY updated DESC',
    );
  });

  it("[QRY-006] reads a day on the person's own clock, whatever their time zone", () => {
    const catalogue = makeCatalogue();
    const instants = (timeZone: string) => {
      const query = dated({ field: 'created', op: 'on', from: '2026-10-31' });
      const plan = resolveQuery(parseQuery(query), catalogue, {
        currentUserId: 1,
        now: new Date('2026-11-01T00:00:00Z'),
        timeZone,
      });
      return JSON.stringify(plan.where).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g);
    };
    expect(instants('UTC')).toEqual(['2026-10-31T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
    expect(instants('America/Bogota')).toEqual([
      '2026-10-31T05:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
    ]);
    expect(instants('Asia/Tokyo')).toEqual([
      '2026-10-30T15:00:00.000Z',
      '2026-10-31T15:00:00.000Z',
    ]);
  });

  it('[QRY-014] makes value filters plain queries, quoting what the grammar needs', () => {
    expect(
      clauses(
        basicToQuery({
          ...EMPTY_BASIC,
          choices: {
            type: ['Bug', 'User story'],
            priority: ['High'],
            labels: ['2026', 'and'],
            requester: [ME],
            creator: ['Ana Ruiz', ME],
            targetRelease: ['1.0'],
            foundInRelease: ['1.0', 'v2'],
            area: ['Checkout'],
          },
        }),
      ),
    ).toBe(
      'type IN (Bug, "User story") AND priority = High AND labels IN ("2026", "and") AND requester = currentUser() AND creator IN ("Ana Ruiz", currentUser()) AND targetRelease = "1.0" AND foundInRelease IN ("1.0", v2) AND area = Checkout',
    );
    // A filter with nothing chosen yet adds nothing.
    expect(basicToQuery({ ...EMPTY_BASIC, choices: { priority: [] } })).toBe(
      'ORDER BY updated DESC',
    );
  });

  it('[QRY-014] reads filters back in any spelling that means the same', () => {
    expect(
      queryToBasic(
        'issuetype = Bug and reporter = currentUser() and component in (A, "B C") and fixVersion = "1.0"',
      ),
    ).toEqual({
      ...EMPTY_BASIC,
      choices: { type: ['Bug'], requester: [ME], area: ['A', 'B C'], targetRelease: ['1.0'] },
    });
    const dates = (query: string) => queryToBasic(query)?.dates;
    expect(dates('createdDate < 2026/10/31')).toEqual([
      { field: 'created', op: 'before', from: '2026-10-31' },
    ]);
    // On or after a day is after the day before.
    expect(dates('updated >= 2026-10-01')).toEqual([
      { field: 'updated', op: 'after', from: '2026-09-30' },
    ]);
    expect(dates('created < 2026-11-01 and created >= 2026-10-31')).toEqual([
      { field: 'created', op: 'on', from: '2026-10-31' },
    ]);
    expect(dates('resolved >= 2026-03-01 and resolved < 2026-03-05')).toEqual([
      { field: 'closed', op: 'between', from: '2026-03-01', to: '2026-03-04' },
    ]);
    expect(dates('dueDate <= 2026-10-31')).toEqual([
      { field: 'due', op: 'before', from: '2026-11-01' },
    ]);
    expect(dates('"Start date" >= 2026-10-31')).toEqual([
      { field: 'start', op: 'after', from: '2026-10-30' },
    ]);
  });

  it('[QRY-014] says when a date or value goes beyond the basic mode', () => {
    for (const text of [
      // A moment, not a day: the form could not say the same thing.
      'created = 2026-10-31',
      'created > 2026-10-31',
      'created <= 2026-10-31',
      'created >= "2026-10-31 14:00"',
      // Relative to now.
      'created >= -7d',
      'updated >= startOfMonth()',
      // More than one range, or none at all.
      'due >= 2026-01-01 AND due >= 2026-02-01',
      'due = 2026-01-01 AND due < 2026-02-01',
      'created >= 2026-01-01 AND created < 2026-02-01 AND created < 2026-03-01',
      'due IS EMPTY',
      'due IN (2026-01-01)',
      'NOT due = 2026-01-01',
      'due = 2026-02-31',
      // Negated or history forms of values.
      'priority != High',
      'type NOT IN (Bug)',
      'labels IS EMPTY',
      'priority > Low',
      'priority WAS High',
      'labels = 12',
      'type = openSprints()',
      'requester = "currentUser()"',
      'requester IN membersOf("Payments")',
      'type = Bug AND type = Story',
    ]) {
      expect(queryToBasic(text), text).toBeNull();
    }
  });

  it('[QRY-014] goes from every filter to a query and back unchanged', () => {
    const day = fc
      .date({
        min: new Date('2000-01-01T00:00:00Z'),
        max: new Date('2099-12-30T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString().slice(0, 10));
    const value = fc.oneof(
      fc.constantFrom('Bug', 'User story', 'and', 'ON', '1.0', 'a"b', 'x\\y', 'ñandú'),
      fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.trim() || 'x'),
    );
    const values = fc.uniqueArray(value, { minLength: 1, maxLength: 3 });
    const choices = fc.dictionary(fc.constantFrom(...CHOICE_FIELDS), values, { maxKeys: 4 });
    const filter = (field: DateFilter['field']): fc.Arbitrary<DateFilter> =>
      fc.oneof(
        fc.record({
          field: fc.constant(field),
          op: fc.constantFrom('on' as const, 'before' as const, 'after' as const),
          from: day,
        }),
        // Between a day and a later one: a single day reads back as "on" on a date and time.
        fc
          .tuple(day, day)
          .filter(([a, b]) => a < b)
          .map(([from, to]) => ({
            field,
            op: 'between' as const,
            from,
            to,
          })),
      );
    const dates = fc
      .subarray([...DATE_FIELDS])
      .chain((fields) => fc.tuple(...fields.map(filter)) as fc.Arbitrary<DateFilter[]>);
    fc.assert(
      fc.property(choices, dates, (chosen, ds) => {
        const basic: BasicQuery = {
          ...EMPTY_BASIC,
          ...(Object.keys(chosen).length > 0 ? { choices: chosen } : {}),
          ...(ds.length > 0 ? { dates: ds } : {}),
        };
        expect(queryToBasic(basicToQuery(basic))).toEqual(basic);
      }),
    );
  });

  it('[QRY-001] goes from basic to a query and back unchanged', () => {
    const basic = fc.record({
      tracks: fc.uniqueArray(
        fc.oneof(
          fc.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
          // Keys that are words of the grammar must be quoted to read back.
          fc.constantFrom('ON', 'IN', 'OR', 'IS', 'TO', 'BY', 'AND', 'NOT', 'EMPTY', 'NULL'),
        ),
        { maxLength: 3 },
      ),
      stages: fc.subarray([...STAGES]).filter((s) => s.length < 3),
      assignee: fc.constantFrom('any', 'me', 'none'),
      text: fc.string({ maxLength: 20 }).map((s) => s.trim()),
    }) as fc.Arbitrary<BasicQuery>;
    fc.assert(
      fc.property(basic, (b) => {
        expect(queryToBasic(basicToQuery(b))).toEqual(b);
      }),
    );
  });
});
