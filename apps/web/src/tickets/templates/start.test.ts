import { describe, expect, it } from 'vitest';
import type { TicketForm } from '../form';
import { fillForm, labelOfKey, omitKeys } from './start';

const field = (key: string) => ({ key, required: false, description: null });
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
            fields: [
              field('summary'),
              field('description'),
              field('priority'),
              field('labels'),
              field('assignee'),
              field('dueDate'),
              field('cf[7]'),
              field('cf[8]'),
              field('cf[9]'),
              field('cf[10]'),
              field('cf[11]'),
            ],
          },
        ],
      },
    ],
  },
  customFields: [
    { id: 7, name: 'Severity', description: '', type: 'select', multiple: false },
    { id: 8, name: 'Browsers', description: '', type: 'select', multiple: true },
    { id: 9, name: 'Part', description: '', type: 'cascading-select', multiple: false },
    { id: 10, name: 'Reviewer', description: '', type: 'user', multiple: false },
    { id: 11, name: 'Tags', description: '', type: 'labels', multiple: false },
  ],
};
const DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

describe('a template on the create form (CORE-030)', () => {
  it('[CORE-030] fills what the form edits and lists what it cannot', () => {
    const fill = fillForm(
      {
        summary: 'Release',
        description: DOC,
        priorityId: 1,
        labels: ['a', 'b'],
        assigneeId: 21,
        dueDate: '2026-11-10',
        fields: { 7: 70, 8: [80, 81], 9: { parent: 90, child: 91 }, 10: 5, 11: ['x', 'y'] },
      },
      FORM,
    );
    expect(fill.values).toEqual({
      summary: 'Release',
      priority: '1',
      labels: 'a b',
      dueDate: '2026-11-10',
      'cf[7]': '70',
      'cf[8]': ['80', '81'],
      'cf[9]': '90',
      'cf[9]/child': '91',
      'cf[11]': 'x y',
    });
    expect(fill.docs).toEqual({ description: DOC });
    expect(fill.extras).toEqual(['assigneeId', 'fields.10']);
  });

  it('[CORE-030] shows nothing the layout hides or locks: the backend leaves those out', () => {
    const fill = fillForm(
      { summary: 'Release', startDate: '2026-11-04', labels: ['a'], fields: { 12: 'x', 7: 70 } },
      {
        ...FORM,
        locks: [
          { by: 'field', field: 'labels', allowed: [] },
          { by: 'field', field: 'cf[7]', allowed: [] },
        ],
      },
    );
    expect(fill.values).toEqual({ summary: 'Release' });
    expect(fill.extras).toEqual([]);
  });

  it('[CORE-030] [IAM-010] neither fills nor lists what the person may not set at create', () => {
    const fill = fillForm(
      { summary: 'Release', assigneeId: 21, dueDate: '2026-11-10' },
      { ...FORM, withheld: ['assignee', 'dueDate'] },
    );
    expect(fill.values).toEqual({ summary: 'Release' });
    expect(fill.extras).toEqual([]);
  });

  it('[CORE-030] fills the pickers the form has with its assignee, releases and areas (T-265)', () => {
    const form: TicketForm = {
      ...FORM,
      layout: {
        operation: 'create',
        tabs: [
          {
            name: null,
            sections: [
              {
                kind: 'main',
                hideWhenEmpty: false,
                fields: [
                  field('summary'),
                  field('assignee'),
                  field('area'),
                  field('targetRelease'),
                ],
              },
            ],
          },
        ],
      },
    };
    const start = { summary: 'Release', assigneeId: 21, areaIds: [31], targetReleaseIds: [41, 42] };
    const pickers = {
      keys: new Set(['assignee', 'area', 'targetRelease']),
      assignee: { id: 21, name: 'Sam Rivera' },
    };
    const fill = fillForm(start, form, pickers);
    expect(fill.picks).toEqual({ assignee: [{ id: 21, name: 'Sam Rivera' }] });
    expect(fill.values).toEqual({ summary: 'Release', area: ['31'], targetRelease: ['41', '42'] });
    expect(fill.extras).toEqual([]);
    expect(fill.picked).toEqual(['assigneeId', 'areaIds', 'targetReleaseIds']);
    // A picker the form lacks, or an assignee it cannot name, stays a checkbox in the list.
    const without = fillForm(start, form, {
      keys: new Set(['area']),
      assignee: { id: 99, name: 'Someone else' },
    });
    expect(without.picks).toEqual({});
    expect(without.extras).toEqual(['assigneeId', 'targetReleaseIds']);
    // Cleared in the form, the template's value is left out; chosen there, the form's is sent.
    const body = { summary: 'Release', assigneeId: 22, targetReleaseIds: [41, 42] };
    expect(omitKeys(start, form, body, new Set(), fill.picked)).toEqual(['areaIds']);
  });

  it('[CORE-030] leaves out only what the person cleared or turned off', () => {
    const start = {
      summary: 'Release',
      priorityId: 1,
      labels: ['a'],
      assigneeId: 21,
      startDate: '2026-11-04',
      fields: { 7: 70, 11: ['x'], 12: 'off the form' },
    };
    const body = { summary: 'Mine', priorityId: 1, fields: { 11: ['x'] } };
    expect(omitKeys(start, FORM, body, new Set(['assigneeId'])).sort()).toEqual([
      'assigneeId',
      'fields.7',
      'labels',
    ]);
  });

  it('[CORE-030] names what was left out', () => {
    expect(labelOfKey('labels', FORM)).toEqual({ id: 'workflow.field.labels' });
    expect(labelOfKey('fields.7', FORM)).toEqual({ name: 'Severity' });
    expect(labelOfKey('fields.12', FORM)).toEqual({ fieldId: '12' });
    expect(labelOfKey('fields.12', null)).toEqual({ fieldId: '12' });
  });
});
