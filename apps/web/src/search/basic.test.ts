import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { type BasicQuery, basicToQuery, queryToBasic, STAGES } from './basic';

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
      'priority = High',
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
