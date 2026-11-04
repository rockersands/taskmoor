/**
 * The layout editor's draft (UI-T15; ADR-114 section 8; CORE-008, CORE-013): a layout set's
 * layouts as the editor changes them, and every move the page offers, as pure functions. Tabs
 * and sections carry ids here, so React keys and focus follow them through a move; the API
 * takes them without. The server stays the judge of what is valid: these moves keep a draft
 * the right shape (each field once, the limits), and its preview and save check the rest.
 */
export const OPERATIONS = ['create', 'edit', 'view'] as const;
export type Operation = (typeof OPERATIONS)[number];
export type SectionKind = 'main' | 'context';

/** The system fields a layout places, in form order (`fields/form-model.ts`). */
export const SYSTEM_FIELD_KEYS = [
  'summary',
  'description',
  'environment',
  'assignee',
  'requester',
  'parent',
  'priority',
  'closeReason',
  'labels',
  'startDate',
  'dueDate',
  'targetRelease',
  'foundInRelease',
  'area',
  'originalEstimate',
  'remainingEstimate',
] as const;

/** The limits the server sets (`fields/form-model.ts`). */
export const MAX_TABS = 20;
export const MAX_SECTIONS = 20;
export const MAX_TAB_NAME = 100;

/** A layout as the API takes and gives it. */
export interface LayoutDefinition {
  tabs: {
    name: string;
    sections: { kind: SectionKind; hideWhenEmpty: boolean; fields: string[] }[];
  }[];
  others: 'show' | 'omit';
}

/** One layout of a set: for a ticket type (null: every type) and an operation. */
export interface LayoutEntry {
  ticketTypeId: number | null;
  operation: Operation;
  definition: LayoutDefinition;
}

export interface DraftSection {
  id: string;
  kind: SectionKind;
  hideWhenEmpty: boolean;
  fields: string[];
}
export interface DraftTab {
  id: string;
  name: string;
  sections: DraftSection[];
}
export interface Draft {
  tabs: DraftTab[];
  others: 'show' | 'omit';
}

/** A set's layouts in the editor, by `formKey`. */
export type DraftSet = Readonly<Record<string, Draft>>;

/** Which form a layout is for. */
export interface FormChoice {
  ticketTypeId: number | null;
  operation: Operation;
}

export const formKey = ({ ticketTypeId, operation }: FormChoice) =>
  `${ticketTypeId ?? 0}|${operation}`;

let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

export function sectionOf(kind: SectionKind, fields: string[] = []): DraftSection {
  return { id: nextId('s'), kind, hideWhenEmpty: false, fields };
}

export function fromDefinition(definition: LayoutDefinition): Draft {
  return {
    others: definition.others,
    tabs: definition.tabs.map((tab) => ({
      id: nextId('t'),
      name: tab.name,
      sections: tab.sections.map((s) => ({
        id: nextId('s'),
        kind: s.kind,
        hideWhenEmpty: s.hideWhenEmpty,
        fields: [...s.fields],
      })),
    })),
  };
}

export function toDefinition(draft: Draft): LayoutDefinition {
  return {
    others: draft.others,
    tabs: draft.tabs.map((tab) => ({
      name: tab.name.trim(),
      sections: tab.sections.map((s) => ({
        kind: s.kind,
        hideWhenEmpty: s.hideWhenEmpty,
        fields: [...s.fields],
      })),
    })),
  };
}

export function draftSetOf(layouts: readonly LayoutEntry[]): DraftSet {
  return Object.fromEntries(layouts.map((l) => [formKey(l), fromDefinition(l.definition)]));
}

/** The set's layouts as a save sends them: every type first, then by type, in operation order. */
export function entriesOf(set: DraftSet): LayoutEntry[] {
  return Object.entries(set)
    .map(([key, draft]) => {
      const [type = '0', operation = 'create'] = key.split('|');
      return {
        ticketTypeId: type === '0' ? null : Number(type),
        operation: operation as Operation,
        definition: toDefinition(draft),
      };
    })
    .sort(
      (a, b) =>
        (a.ticketTypeId ?? 0) - (b.ticketTypeId ?? 0) ||
        OPERATIONS.indexOf(a.operation) - OPERATIONS.indexOf(b.operation),
    );
}

/** Whether two sets of layouts would save the same. */
export const sameLayouts = (a: DraftSet, b: DraftSet) =>
  JSON.stringify(entriesOf(a)) === JSON.stringify(entriesOf(b));

/**
 * Which layout a form uses, as the server chooses (`layoutFor` in `fields/layouts.ts`): its own,
 * else the one for every type, else none.
 */
export function layoutSource(set: DraftSet, form: FormChoice): 'own' | 'every_type' | 'none' {
  if (set[formKey(form)]) return 'own';
  if (form.ticketTypeId !== null && set[formKey({ ...form, ticketTypeId: null })]) {
    return 'every_type';
  }
  return 'none';
}

/** A new layout: a copy of the one the form uses now, or one tab with a main and a side column. */
export function starterFor(set: DraftSet, form: FormChoice, tabName: string): Draft {
  const every = form.ticketTypeId !== null ? set[formKey({ ...form, ticketTypeId: null })] : null;
  if (every) return fromDefinition(toDefinition(every));
  return {
    others: 'show',
    tabs: [{ id: nextId('t'), name: tabName, sections: [sectionOf('main'), sectionOf('context')] }],
  };
}

export const placedKeys = (draft: Draft): string[] =>
  draft.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields));

/** Where a section is: its tab and the place of each. */
export function findSection(draft: Draft, sectionId: string) {
  for (const [tabIndex, tab] of draft.tabs.entries()) {
    const index = tab.sections.findIndex((s) => s.id === sectionId);
    if (index >= 0) return { tab, tabIndex, section: tab.sections[index] as DraftSection, index };
  }
  return null;
}

/** Where a field is placed, or null when it is not. */
export function findField(draft: Draft, key: string) {
  for (const tab of draft.tabs) {
    for (const section of tab.sections) {
      const index = section.fields.indexOf(key);
      if (index >= 0) return { tab, section, index };
    }
  }
  return null;
}

const mapSections = (draft: Draft, change: (s: DraftSection) => DraftSection): Draft => ({
  ...draft,
  tabs: draft.tabs.map((tab) => ({ ...tab, sections: tab.sections.map(change) })),
});

export const removeField = (draft: Draft, key: string): Draft =>
  mapSections(draft, (s) =>
    s.fields.includes(key) ? { ...s, fields: s.fields.filter((f) => f !== key) } : s,
  );

/**
 * Puts a field in a section at a place, wherever it was: `index` counts the section's fields as
 * they are before the move (as a drop sees them), and past the end means last.
 */
export function placeField(draft: Draft, key: string, sectionId: string, index: number): Draft {
  const was = findField(draft, key);
  let at = index;
  if (was && was.section.id === sectionId && was.index < index) at -= 1;
  const without = removeField(draft, key);
  return mapSections(without, (s) => {
    if (s.id !== sectionId) return s;
    const fields = [...s.fields];
    fields.splice(Math.max(0, Math.min(at, fields.length)), 0, key);
    return { ...s, fields };
  });
}

/**
 * A field one place earlier or later: within its section, and from a section's edge into the
 * section before or after it, across tabs. Null when it cannot go further.
 */
export function stepField(draft: Draft, key: string, direction: -1 | 1): Draft | null {
  const sections = draft.tabs.flatMap((t) => t.sections);
  const at = sections.findIndex((s) => s.fields.includes(key));
  const section = sections[at];
  if (!section) return null;
  const index = section.fields.indexOf(key);
  const to = index + direction;
  if (to >= 0 && to < section.fields.length) {
    return placeField(draft, key, section.id, direction === 1 ? to + 1 : to);
  }
  const next = sections[at + direction];
  if (!next) return null;
  return placeField(draft, key, next.id, direction === 1 ? 0 : next.fields.length);
}

export function addTab(draft: Draft, name: string): Draft {
  if (draft.tabs.length >= MAX_TABS) return draft;
  return {
    ...draft,
    tabs: [...draft.tabs, { id: nextId('t'), name, sections: [sectionOf('main')] }],
  };
}

export const renameTab = (draft: Draft, tabId: string, name: string): Draft => ({
  ...draft,
  tabs: draft.tabs.map((t) => (t.id === tabId ? { ...t, name: name.slice(0, MAX_TAB_NAME) } : t)),
});

/** Takes a tab off; its fields go back to the fields not placed. */
export const removeTab = (draft: Draft, tabId: string): Draft => ({
  ...draft,
  tabs: draft.tabs.filter((t) => t.id !== tabId),
});

/** A tab to a place among the tabs, counted without it. */
export function moveTab(draft: Draft, tabId: string, index: number): Draft {
  const tab = draft.tabs.find((t) => t.id === tabId);
  if (!tab) return draft;
  const tabs = draft.tabs.filter((t) => t.id !== tabId);
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
  return { ...draft, tabs };
}

export function stepTab(draft: Draft, tabId: string, direction: -1 | 1): Draft | null {
  const index = draft.tabs.findIndex((t) => t.id === tabId);
  const to = index + direction;
  if (index < 0 || to < 0 || to >= draft.tabs.length) return null;
  return moveTab(draft, tabId, to);
}

export function addSection(draft: Draft, tabId: string, kind: SectionKind): Draft {
  return {
    ...draft,
    tabs: draft.tabs.map((t) =>
      t.id === tabId && t.sections.length < MAX_SECTIONS
        ? { ...t, sections: [...t.sections, sectionOf(kind)] }
        : t,
    ),
  };
}

export const updateSection = (
  draft: Draft,
  sectionId: string,
  change: Partial<Pick<DraftSection, 'kind' | 'hideWhenEmpty'>>,
): Draft => mapSections(draft, (s) => (s.id === sectionId ? { ...s, ...change } : s));

/** Takes a section off; its fields go back to the fields not placed. */
export const removeSection = (draft: Draft, sectionId: string): Draft => ({
  ...draft,
  tabs: draft.tabs.map((t) => ({ ...t, sections: t.sections.filter((s) => s.id !== sectionId) })),
});

/**
 * A section to a place in a tab, counted among that tab's sections without it. A full tab takes
 * no section from another.
 */
export function moveSection(draft: Draft, sectionId: string, tabId: string, index: number): Draft {
  const from = findSection(draft, sectionId);
  const target = draft.tabs.find((t) => t.id === tabId);
  if (!from || !target) return draft;
  if (target.id !== from.tab.id && target.sections.length >= MAX_SECTIONS) return draft;
  const without = removeSection(draft, sectionId);
  return {
    ...without,
    tabs: without.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const sections = [...t.sections];
      sections.splice(Math.max(0, Math.min(index, sections.length)), 0, from.section);
      return { ...t, sections };
    }),
  };
}

/** A section one place earlier or later within its tab; null at either end. */
export function stepSection(draft: Draft, sectionId: string, direction: -1 | 1): Draft | null {
  const at = findSection(draft, sectionId);
  if (!at) return null;
  const to = at.index + direction;
  if (to < 0 || to >= at.tab.sections.length) return null;
  return moveSection(draft, sectionId, at.tab.id, to);
}
