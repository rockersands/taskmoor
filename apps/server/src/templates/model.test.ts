import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX } from '../tickets/model';
import {
  addDays,
  createTemplateBody,
  expandSummary,
  mergeBody,
  startValues,
  todayIn,
} from './model';

const context = { date: '2026-11-02', track: 'OPS', user: 'Ada' };

describe('ticket templates, pure parts (ADR-113)', () => {
  it('[CORE-029] fills the summary pattern and keeps other text as written', () => {
    expect(expandSummary('Release {track} on {date} by {user}', context)).toBe(
      'Release OPS on 2026-11-02 by Ada',
    );
    expect(expandSummary('Keep {unknown} and {date', context)).toBe('Keep {unknown} and {date');
    expect(expandSummary('{user}', { ...context, user: 'Two\nlines' })).toBe('Two lines');
  });

  it('[CORE-029] never makes a summary longer than a summary may be', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 }), (pattern, user) => {
        expect([...expandSummary(pattern, { ...context, user })].length).toBeLessThanOrEqual(
          SUMMARY_MAX,
        );
      }),
    );
  });

  it('[CORE-029] counts dates in days from today, in the person’s time zone', () => {
    expect(addDays('2026-11-02', 7)).toBe('2026-11-09');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-02', -2)).toBe('2026-10-31');
    const lateUtc = new Date('2026-11-02T23:30:00Z');
    expect(todayIn(null, lateUtc)).toBe('2026-11-02');
    expect(todayIn('Asia/Tokyo', lateUtc)).toBe('2026-11-03');
    expect(todayIn('Not/A_Zone', lateUtc)).toBe('2026-11-02');
  });

  it('[CORE-029] starts a ticket with the template’s values, named as the create route names them', () => {
    const start = startValues(
      {
        summary: 'Incident {date}',
        description: { type: 'doc', content: [{ type: 'paragraph' }] },
        defaults: {
          priorityId: 2,
          labels: ['ops'],
          assigneeId: 9,
          areaIds: [4],
          dueInDays: 7,
          startInDays: 0,
          fields: { '12': 'High', '13': null },
        },
      },
      context,
    );
    expect(start).toEqual({
      summary: 'Incident 2026-11-02',
      description: { type: 'doc', content: [{ type: 'paragraph' }] },
      priorityId: 2,
      labels: ['ops'],
      assigneeId: 9,
      areaIds: [4],
      dueDate: '2026-11-09',
      startDate: '2026-11-02',
      fields: { '12': 'High' },
    });
  });

  it('[CORE-030] lets the person’s values win, and knows which values are the template’s', () => {
    const start = { summary: 'From template', priorityId: 2, labels: ['ops'], fields: { '5': 1 } };
    const merged = mergeBody(
      start,
      { track: 'OPS', summary: 'Mine', labels: ['ops'], fields: { '6': 'x' } },
      new Set(['priorityId']),
    );
    expect(merged.body).toEqual({
      track: 'OPS',
      summary: 'Mine',
      labels: ['ops'],
      fields: { '5': 1, '6': 'x' },
    });
    // The labels the form showed unchanged are still the template's; the summary is not.
    expect([...merged.fromTemplate].sort()).toEqual(['fields.5', 'labels']);
  });

  it('[CORE-029] refuses unknown keys and values out of range', () => {
    expect(createTemplateBody.safeParse({ name: 'A', colour: 'red' }).success).toBe(false);
    expect(createTemplateBody.safeParse({ name: 'A', defaults: { dueInDays: 5000 } }).success).toBe(
      false,
    );
    expect(createTemplateBody.safeParse({ name: 'A', summary: 'two\nlines' }).success).toBe(false);
    expect(
      createTemplateBody.safeParse({
        name: 'A',
        subtickets: Array.from({ length: 51 }, () => ({ summary: 'x' })),
      }).success,
    ).toBe(false);
    expect(createTemplateBody.safeParse({ name: ' ' }).success).toBe(false);
  });
});
