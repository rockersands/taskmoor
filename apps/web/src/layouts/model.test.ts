import { describe, expect, it } from 'vitest';
import {
  addSection,
  addTab,
  type Draft,
  draftSetOf,
  entriesOf,
  fromDefinition,
  layoutSource,
  MAX_TABS,
  moveSection,
  placedKeys,
  placeField,
  removeSection,
  removeTab,
  sameLayouts,
  starterFor,
  stepField,
  stepSection,
  stepTab,
  toDefinition,
} from './model';

const twoSections = (): Draft =>
  fromDefinition({
    tabs: [
      {
        name: 'Details',
        sections: [
          { kind: 'main', hideWhenEmpty: false, fields: ['summary', 'description', 'labels'] },
          { kind: 'context', hideWhenEmpty: true, fields: ['assignee'] },
        ],
      },
      { name: 'Planning', sections: [{ kind: 'main', hideWhenEmpty: false, fields: ['dueDate'] }] },
    ],
    others: 'omit',
  });

const fieldsOf = (draft: Draft) => draft.tabs.map((t) => t.sections.map((s) => s.fields));

describe('the layout editor’s draft (UI-T15)', () => {
  it('[CORE-008] round-trips a layout as the API gives it', () => {
    const draft = twoSections();
    expect(toDefinition(draft)).toEqual({
      tabs: [
        {
          name: 'Details',
          sections: [
            { kind: 'main', hideWhenEmpty: false, fields: ['summary', 'description', 'labels'] },
            { kind: 'context', hideWhenEmpty: true, fields: ['assignee'] },
          ],
        },
        {
          name: 'Planning',
          sections: [{ kind: 'main', hideWhenEmpty: false, fields: ['dueDate'] }],
        },
      ],
      others: 'omit',
    });
  });

  it('[CORE-008] places a field anywhere, counting places as a drop sees them, and keeps each field once', () => {
    const draft = twoSections();
    const side = draft.tabs[0]?.sections[1]?.id as string;
    const main = draft.tabs[0]?.sections[0]?.id as string;
    // From the palette into the side column, first.
    expect(fieldsOf(placeField(draft, 'priority', side, 0))[0]?.[1]).toEqual([
      'priority',
      'assignee',
    ]);
    // Down within its own section: dropped below "labels" (place 3 before the move).
    expect(fieldsOf(placeField(draft, 'summary', main, 3))[0]?.[0]).toEqual([
      'description',
      'labels',
      'summary',
    ]);
    // From one section to another: it leaves the first.
    const moved = placeField(draft, 'labels', side, 99);
    expect(fieldsOf(moved)[0]).toEqual([
      ['summary', 'description'],
      ['assignee', 'labels'],
    ]);
    expect(new Set(placedKeys(moved)).size).toBe(placedKeys(moved).length);
  });

  it('[CORE-008] steps a field one place, across sections and tabs at an edge, and stops at the ends', () => {
    let draft = twoSections();
    draft = stepField(draft, 'labels', 1) as Draft;
    expect(fieldsOf(draft)[0]).toEqual([
      ['summary', 'description'],
      ['labels', 'assignee'],
    ]);
    draft = stepField(draft, 'assignee', 1) as Draft;
    expect(fieldsOf(draft)[1]).toEqual([['assignee', 'dueDate']]);
    expect(stepField(draft, 'summary', -1)).toBeNull();
    expect(stepField(draft, 'dueDate', 1)).toBeNull();
    expect(stepField(draft, 'priority', 1)).toBeNull();
  });

  it('[CORE-013] moves sections and tabs, and gives back the fields of what is removed', () => {
    const draft = twoSections();
    const [details, planning] = draft.tabs;
    const side = details?.sections[1]?.id as string;
    const earlier = stepSection(draft, side, -1) as Draft;
    expect(earlier.tabs[0]?.sections.map((s) => s.kind)).toEqual(['context', 'main']);
    expect(stepSection(draft, side, 1)).toBeNull();
    const across = moveSection(draft, side, planning?.id as string, 0);
    expect(fieldsOf(across)).toEqual([
      [['summary', 'description', 'labels']],
      [['assignee'], ['dueDate']],
    ]);
    const swapped = stepTab(draft, planning?.id as string, -1) as Draft;
    expect(swapped.tabs.map((t) => t.name)).toEqual(['Planning', 'Details']);
    expect(stepTab(draft, planning?.id as string, 1)).toBeNull();
    expect(placedKeys(removeSection(draft, side))).not.toContain('assignee');
    expect(placedKeys(removeTab(draft, details?.id as string))).toEqual(['dueDate']);
  });

  it('[CORE-013] keeps to the server’s limits of tabs and sections', () => {
    let draft = twoSections();
    while (draft.tabs.length < MAX_TABS) draft = addTab(draft, 'More');
    expect(addTab(draft, 'One too many').tabs).toHaveLength(MAX_TABS);
    let tab = twoSections();
    const id = tab.tabs[1]?.id as string;
    for (let i = 0; i < 30; i++) tab = addSection(tab, id, 'main');
    expect(tab.tabs[1]?.sections).toHaveLength(20);
  });

  it('[CORE-008] chooses a form’s layout as the server does, and starts a new one from it', () => {
    const set = draftSetOf([
      {
        ticketTypeId: null,
        operation: 'create',
        definition: { tabs: [{ name: 'All', sections: [] }], others: 'show' },
      },
      {
        ticketTypeId: 2,
        operation: 'view',
        definition: { tabs: [], others: 'omit' },
      },
    ]);
    expect(layoutSource(set, { ticketTypeId: 2, operation: 'create' })).toBe('every_type');
    expect(layoutSource(set, { ticketTypeId: 2, operation: 'view' })).toBe('own');
    expect(layoutSource(set, { ticketTypeId: null, operation: 'edit' })).toBe('none');
    expect(
      toDefinition(starterFor(set, { ticketTypeId: 2, operation: 'create' }, 'Details')),
    ).toEqual({ tabs: [{ name: 'All', sections: [] }], others: 'show' });
    expect(
      toDefinition(starterFor(set, { ticketTypeId: null, operation: 'edit' }, 'Details')),
    ).toEqual({
      tabs: [
        {
          name: 'Details',
          sections: [
            { kind: 'main', hideWhenEmpty: false, fields: [] },
            { kind: 'context', hideWhenEmpty: false, fields: [] },
          ],
        },
      ],
      others: 'show',
    });
    // A save sends every layout, every type first, in operation order; ids never leave.
    expect(entriesOf(set).map((l) => [l.ticketTypeId, l.operation])).toEqual([
      [null, 'create'],
      [2, 'view'],
    ]);
    expect(JSON.stringify(entriesOf(set))).not.toMatch(/"id"/);
    expect(sameLayouts(set, draftSetOf(entriesOf(set)))).toBe(true);
  });
});
