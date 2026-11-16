import { afterEach, describe, expect, it } from 'vitest';
import { setAccountTimeZone } from '../i18n/zone';
import { useTimeZone } from '../test/timeZone';
import { BUG_FORM, CHORE_FORM } from './fixtures';
import {
  createBody,
  errorMessage,
  fieldErrors,
  placementRefusal,
  textDocument,
  trackThingOf,
} from './form';

describe('the create form data (M1-012)', () => {
  it('[CORE-008] sends what was typed, by body key, and leaves empty fields out', () => {
    expect(
      createBody('SHOP', 3, BUG_FORM, {
        summary: 'Checkout fails',
        description: 'Open the cart\n\nPay',
        'cf[7]': '70',
        'cf[8]': '80',
        'cf[8]/child': '81',
        priority: '',
        dueDate: '2026-12-01',
      }),
    ).toEqual({
      track: 'SHOP',
      ticketTypeId: 3,
      summary: 'Checkout fails',
      description: textDocument('Open the cart\n\nPay'),
      dueDate: '2026-12-01',
      fields: { 7: 70, 8: { parent: 80, child: 81 } },
    });
    expect(createBody('SHOP', 4, CHORE_FORM, { summary: 'Tidy', labels: ' a  b ' })).toEqual({
      track: 'SHOP',
      ticketTypeId: 4,
      summary: 'Tidy',
      labels: ['a', 'b'],
    });
  });

  it('[CORE-008] sends what the pickers chose as ids: people, the parent, releases and areas', () => {
    const field = (key: string) => ({ key, required: false, description: null });
    const form = {
      layout: {
        operation: 'create',
        tabs: [
          {
            name: null,
            sections: [
              {
                kind: 'main' as const,
                hideWhenEmpty: false,
                fields: ['summary', 'assignee', 'parent', 'targetRelease', 'foundInRelease', 'area']
                  .concat(['cf[12]', 'cf[13]'])
                  .map(field),
              },
            ],
          },
        ],
      },
      customFields: [
        { id: 12, name: 'Reviewer', description: '', type: 'user', multiple: false },
        { id: 13, name: 'Watchers', description: '', type: 'user', multiple: true },
      ],
    };
    expect(
      createBody('SHOP', 3, form, {
        summary: 'Pay',
        assignee: '21',
        parent: '40',
        targetRelease: ['5', '6'],
        foundInRelease: [],
        area: ['7'],
        'cf[12]': '22',
        'cf[13]': ['23', '24'],
      }),
    ).toEqual({
      track: 'SHOP',
      ticketTypeId: 3,
      summary: 'Pay',
      assigneeId: 21,
      parent: 40,
      targetReleaseIds: [5, 6],
      areaIds: [7],
      fields: { 12: 22, 13: [23, 24] },
    });
  });

  it('[CORE-008] puts the backend refusals on the fields they name', () => {
    expect(
      fieldErrors({ dueDate: 'required', 'fields.7': 'required', priorityId: 'not_found' }),
    ).toEqual({ dueDate: 'required', 'cf[7]': 'required', priority: 'not_found' });
  });

  it('[CORE-015] [CORE-016] names a release or area the track does not have, and keeps the general words for the rest (T-286)', () => {
    // Releases and areas by every key a form or a ticket route names them by.
    for (const key of [
      'targetRelease',
      'foundInRelease',
      'targetReleaseIds',
      'foundInReleaseIds',
    ]) {
      expect(trackThingOf(key), key).toBe('release');
      expect(errorMessage('not_in_track', trackThingOf(key)), key).toBe(
        'tickets.error.releaseNotInTrack',
      );
    }
    for (const key of ['area', 'areaIds']) {
      expect(errorMessage('not_in_track', trackThingOf(key)), key).toBe(
        'tickets.error.areaNotInTrack',
      );
    }
    // A custom field by its type, where the page knows it.
    expect(trackThingOf('cf[33]', 'release')).toBe('release');
    expect(trackThingOf('cf[34]', 'area')).toBe('area');
    expect(trackThingOf('cf[35]', 'select')).toBeNull();
    expect(trackThingOf('fields.33')).toBeNull();
    // A priority, ticket type, visibility level or unknown field keeps the general words.
    for (const key of ['priorityId', 'ticketTypeId', 'visibilityLevelId', 'constructor']) {
      expect(errorMessage('not_in_track', trackThingOf(key)), key).toBe('tickets.error.notInTrack');
    }
    // Other codes keep their own words, release or not.
    expect(errorMessage('archived', 'release')).toBe('tickets.error.archived');
    expect(errorMessage('required', 'area')).toBe('tickets.error.required');
    // Outside the create form, by the first field the track does not have.
    expect(placementRefusal({ labels: 'too_long', areaIds: 'not_in_track' })).toBe(
      'tickets.error.areaNotInTrack',
    );
    expect(placementRefusal({ targetReleaseIds: 'not_in_track', areaIds: 'not_in_track' })).toBe(
      'tickets.error.releaseNotInTrack',
    );
    expect(placementRefusal({ priorityId: 'not_in_track' })).toBe('tickets.error.notInTrack');
    expect(placementRefusal({ 'fields.33': 'not_in_track' })).toBe('tickets.error.notInTrack');
    expect(placementRefusal({ 'fields.33': 'archived' })).toBe('tickets.error.archived');
    expect(placementRefusal({ labels: 'too_long' })).toBeNull();
  });

  it('turns lines of text into paragraphs, and no text into nothing', () => {
    expect(textDocument('  ')).toBeNull();
    expect(textDocument('a\n\nb')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });
});

describe('a date and time typed on the create form (T-280)', () => {
  useTimeZone('America/Mexico_City');
  afterEach(() => setAccountTimeZone(null));
  const form = {
    layout: {
      operation: 'create',
      tabs: [
        {
          name: null,
          sections: [
            {
              kind: 'main' as const,
              hideWhenEmpty: false,
              fields: [{ key: 'cf[20]', required: false, description: null }],
            },
          ],
        },
      ],
    },
    customFields: [{ id: 20, name: 'Go live', description: '', type: 'datetime', multiple: false }],
  };

  it('[NFR-006] [IAM-008] sends the instant the time names on the person’s clock: the account’s zone, else the device’s', () => {
    // 14:00 on the device in Mexico City (UTC−6) is 20:00 in UTC.
    expect(createBody('SHOP', 3, form, { 'cf[20]': '2026-11-16T14:00' }).fields).toEqual({
      20: '2026-11-16T20:00:00.000Z',
    });
    // The account says New York (UTC−5): 14:00 there is 19:00 in UTC.
    setAccountTimeZone('America/New_York');
    expect(createBody('SHOP', 3, form, { 'cf[20]': '2026-11-16T14:00' }).fields).toEqual({
      20: '2026-11-16T19:00:00.000Z',
    });
  });
});
