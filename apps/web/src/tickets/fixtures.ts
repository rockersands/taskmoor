import type { TicketForm } from './form';

/** A create form as the backend lays one out: a named tab, a context section, the rest. */
export const BUG_FORM: TicketForm = {
  layout: {
    operation: 'create',
    tabs: [
      {
        name: 'Report',
        sections: [
          {
            kind: 'main',
            hideWhenEmpty: false,
            fields: [
              { key: 'summary', required: true, description: null },
              { key: 'description', required: false, description: 'What happened, step by step' },
              { key: 'cf[7]', required: true, description: null },
            ],
          },
          {
            kind: 'context',
            hideWhenEmpty: false,
            fields: [
              { key: 'priority', required: false, description: null },
              { key: 'cf[8]', required: false, description: null },
              { key: 'assignee', required: false, description: null },
            ],
          },
        ],
      },
      {
        name: null,
        sections: [
          {
            kind: 'main',
            hideWhenEmpty: false,
            fields: [{ key: 'dueDate', required: true, description: null }],
          },
        ],
      },
    ],
  },
  customFields: [
    {
      id: 7,
      name: 'Severity',
      description: '',
      type: 'select',
      multiple: false,
      options: [
        { id: 70, value: 'Blocker' },
        { id: 71, value: 'Minor' },
      ],
    },
    {
      id: 8,
      name: 'Component',
      description: 'Where it lives',
      type: 'cascading-select',
      multiple: false,
      options: [{ id: 80, value: 'Backend', children: [{ id: 81, value: 'Queue' }] }],
    },
  ],
};

/** The same track's form for chores: one generated tab, nothing required but the summary. */
export const CHORE_FORM: TicketForm = {
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
              { key: 'summary', required: true, description: null },
              { key: 'labels', required: false, description: null },
              { key: 'dueDate', required: false, description: null },
            ],
          },
        ],
      },
    ],
  },
  customFields: [],
};

/** The chore form for someone the field rules keep from dating or labelling work (M1-029). */
export const LOCKED_FORM: TicketForm = {
  ...CHORE_FORM,
  locks: [
    { by: 'field', field: 'dueDate', allowed: [{ type: 'group', id: 7, name: 'Approvers' }] },
    {
      by: 'field',
      field: 'labels',
      allowed: [
        { type: 'role', id: 1, name: 'Administrators' },
        { type: 'group', id: 9, name: 'Leads' },
      ],
    },
  ],
};

export const TRACKS = [{ id: 1, key: 'SHOP', name: 'Shop' }];
export const TYPES = [
  { id: 3, name: 'Bug' },
  { id: 4, name: 'Chore' },
];
export const PRIORITIES = [
  { id: 1, name: 'Urgent' },
  { id: 2, name: 'Normal' },
  { id: 3, name: 'Very low' },
];
