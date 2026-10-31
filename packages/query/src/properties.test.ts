import { describe, expect, it } from 'vitest';
import { toJira, toNative } from './dialect';
import { makeCatalogue, type PropertyField } from './fields';
import { QueryError } from './lexer';
import { parseQuery } from './parser';
import { printQuery } from './print';
import { resolveQuery } from './resolve';

/**
 * Ticket property values in queries (M1-129; API-013 (2)): `ticket.property[key].path`, in the
 * Jira dialect `issue.property[key].path`, for the values a declared property index makes
 * searchable, and its alias as a plain field name.
 */
const indexes: PropertyField[] = [
  {
    kind: 'property',
    indexId: 1,
    key: 'support',
    path: 'level',
    name: 'ticket.property[support].level',
    alias: 'supportLevel',
    type: 'number',
  },
  {
    kind: 'property',
    indexId: 2,
    key: 'com.acme.review',
    path: '',
    name: 'ticket.property["com.acme.review"]',
    alias: null,
    type: 'labels',
  },
];
const catalogue = makeCatalogue([], {}, indexes);
const ctx = { currentUserId: 1, now: new Date('2026-10-30T12:00:00Z') };
const resolve = (text: string) => resolveQuery(parseQuery(text), catalogue, ctx);

describe('ticket properties in queries (M1-129)', () => {
  it('[API-013] reads a key and a path in either vocabulary', () => {
    expect(parseQuery('ticket.property[support].level >= 2').where).toMatchObject({
      kind: 'compare',
      field: { name: 'ticket.property', property: { key: 'support', path: 'level' } },
      op: '>=',
    });
    expect(parseQuery('issue.property["com.acme.review"] = approved').where).toMatchObject({
      field: { name: 'issue.property', property: { key: 'com.acme.review', path: '' } },
    });
    expect(parseQuery('ticket.property[a].b.c IS EMPTY').where).toMatchObject({
      kind: 'empty',
      field: { property: { key: 'a', path: 'b.c' } },
    });
  });

  it('[API-013] prints them back and turns one vocabulary into the other', () => {
    const native =
      'ticket.property[support].level >= 2 AND ticket.property["com.acme.review"] = approved';
    expect(printQuery(parseQuery(native))).toBe(native);
    expect(printQuery(toJira(parseQuery(native)))).toBe(
      'issue.property[support].level >= 2 AND issue.property["com.acme.review"] = approved',
    );
    expect(printQuery(toNative(parseQuery('issue.property[support].level = 1')))).toBe(
      'ticket.property[support].level = 1',
    );
  });

  it('[API-013] refuses a property reference with no key or an empty path step', () => {
    expect(() => parseQuery('ticket.property[] = 1')).toThrow(QueryError);
    expect(() => parseQuery('ticket.property[a]..b = 1')).toThrow(/property path/);
  });

  it('[API-013] resolves a declared index by key and path, and by its alias', () => {
    expect(resolve('ticket.property[support].level > 1').where).toMatchObject({
      kind: 'compare',
      field: { kind: 'property', indexId: 1 },
    });
    expect(resolve('issue.property[support].level IN (1, 2)').where).toMatchObject({
      kind: 'in',
      field: { indexId: 1 },
    });
    expect(resolve('supportLevel = 3').where).toMatchObject({ field: { indexId: 1 } });
    expect(resolve('ticket.property["com.acme.review"] = approved').where).toMatchObject({
      field: { indexId: 2, type: 'labels' },
    });
  });

  it('[API-013] refuses a value no index makes searchable, and history on one', () => {
    expect(() => resolve('ticket.property[support].tier = 1')).toThrow(
      'ticket.property[support].tier is not searchable: no property index is declared for it',
    );
    expect(() => resolve('ticket.property[support].level WAS 1')).toThrow(QueryError);
    // Words are for text indexes: a number index takes no ~.
    expect(() => resolve('ticket.property[support].level ~ high')).toThrow(QueryError);
  });
});
