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

export const TRACKS = [{ id: 1, key: 'SHOP', name: 'Shop' }];
export const TYPES = [
  { id: 3, name: 'Bug' },
  { id: 4, name: 'Chore' },
];
export const PRIORITIES = [
  { id: 1, name: 'Urgent' },
  { id: 2, name: 'Normal' },
];
