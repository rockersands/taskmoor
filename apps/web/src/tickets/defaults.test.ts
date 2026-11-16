import { describe, expect, it } from 'vitest';
import { emptiedDefaults, formDefaults, NO_DEFAULTS, overlay, refill } from './defaults';
import { type CustomField, createBody, type TicketForm } from './form';

const custom = (id: number, type: string, defaultValue: unknown, more: Partial<CustomField> = {}) =>
  ({
    id,
    name: `F${id}`,
    description: '',
    type,
    multiple: false,
    defaultValue,
    ...more,
  }) as CustomField;

const FORM: TicketForm = {
  layout: {
    operation: 'create',
    tabs: [
      {
        name: null,
        sections: [
          {
            kind: 'main',
            hideWhenEmpty: false,
            fields: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({
              key: `cf[${id}]`,
              required: false,
              description: null,
            })),
          },
        ],
      },
    ],
  },
  customFields: [
    custom(1, 'text', 'ACME'),
    custom(2, 'number', 12.5),
    custom(3, 'select', { id: 31, value: 'High' }, { options: [{ id: 31, value: 'High' }] }),
    custom(
      4,
      'select',
      [
        { id: 41, value: 'A' },
        { id: 42, value: 'Gone' },
      ],
      { multiple: true, options: [{ id: 41, value: 'A' }] },
    ),
    custom(
      5,
      'cascading-select',
      { id: 51, value: 'Europe', child: { id: 52, value: 'Madrid' } },
      { options: [{ id: 51, value: 'Europe', children: [{ id: 52, value: 'Madrid' }] }] },
    ),
    custom(6, 'user', { id: 7, name: 'Ana Ruiz' }),
    custom(7, 'labels', ['red', 'blue']),
    custom(8, 'paragraph', { type: 'doc', content: [{ type: 'paragraph' }] }),
    custom(9, 'date', null),
  ],
};
const ALL = new Set(FORM.layout.tabs[0]?.sections[0]?.fields.map((f) => f.key));

describe('the create form’s defaults (T-320)', () => {
  it('[CORE-009] starts each field with its context’s default, as the form holds values', () => {
    const start = formDefaults(FORM, ALL);
    expect(start.values).toEqual({
      'cf[1]': 'ACME',
      'cf[2]': '12.5',
      'cf[3]': '31',
      // An option no longer offered is left out, as the server leaves it out.
      'cf[4]': ['41'],
      'cf[5]': '51',
      'cf[5]/child': '52',
      'cf[7]': 'red blue',
    });
    expect(start.picks).toEqual({ 'cf[6]': [{ id: 7, name: 'Ana Ruiz' }] });
    expect(start.docs).toEqual({ 'cf[8]': { type: 'doc', content: [{ type: 'paragraph' }] } });
    // Only the fields the form sets.
    expect(formDefaults(FORM, new Set(['cf[1]'])).values).toEqual({ 'cf[1]': 'ACME' });
  });

  it('[CORE-009] keeps what was typed when another type’s defaults come', () => {
    const prev = { 'cf[1]': 'ACME', 'cf[2]': '12.5' };
    const next = { 'cf[1]': 'Globex', 'cf[3]': '31' };
    // cf[2] was left as its default, so it goes; cf[1] was typed, so it stays.
    expect(refill({ 'cf[1]': 'Typed', 'cf[2]': '12.5', summary: 'S' }, prev, next)).toEqual({
      'cf[1]': 'Typed',
      'cf[3]': '31',
      summary: 'S',
    });
    expect(refill({ 'cf[1]': 'ACME' }, prev, next)).toEqual({ 'cf[1]': 'Globex', 'cf[3]': '31' });
    expect(refill<string | string[]>({}, NO_DEFAULTS.values, next)).toEqual(next);
  });

  it('[CORE-009] sends null for a default the person emptied, and the rest as typed', () => {
    const start = formDefaults(FORM, ALL);
    const values = { ...start.values, 'cf[1]': '', 'cf[4]': [] as string[] };
    const emptied = emptiedDefaults(start, values, { 'cf[8]': null }, { 'cf[6]': [] });
    expect([...emptied].sort()).toEqual(['cf[1]', 'cf[4]', 'cf[6]', 'cf[8]']);
    const body = createBody('PAY', 3, FORM, { ...values, 'cf[6]': '' }, { 'cf[8]': null }, emptied);
    expect(body.fields).toEqual({
      1: null,
      2: '12.5',
      3: 31,
      4: null,
      5: { parent: 51, child: 52 },
      6: null,
      7: ['red', 'blue'],
      8: null,
    });
  });

  it('[CORE-009] puts a template’s values over the defaults, a default child going with its option', () => {
    expect(
      overlay({ 'cf[5]': '51', 'cf[5]/child': '52', 'cf[1]': 'ACME' }, { 'cf[5]': '53' }),
    ).toEqual({ 'cf[5]': '53', 'cf[1]': 'ACME' });
  });
});
