import type { TicketRow } from '../tickets/store';
import type { Catalog, ContextDef, FieldDef } from './catalog';
import {
  bodyKey,
  customFieldId,
  customKey,
  FIXED_FIELDS,
  type FormPlacement,
  type LayoutDefinition,
  type Operation,
  type RuleDef,
  SYSTEM_FIELDS,
  type SystemField,
} from './form-model';

export {
  bodyKey,
  customFieldId,
  customKey,
  EMPTY_FORMS,
  FIXED_FIELDS,
  type FormConfig,
  type FormPlacement,
  fieldOfBody,
  isFieldKey,
  type LayoutDefinition,
  type LayoutSetDef,
  layoutDefinition,
  OPERATIONS,
  type Operation,
  type RuleDef,
  type RuleSetDef,
  SYSTEM_FIELDS,
  type SystemField,
} from './form-model';

/**
 * Field rules and layouts (M1-012; CORE-008, CORE-013; spec 01a section 1.5): which fields a
 * ticket of a type in a track must have, which it may not show or write, and how create, edit
 * and view forms arrange the rest. Pure: the catalogue holds the sets, the routes enforce.
 *
 * - Fields are named as the query language names them: system fields by name (`dueDate`),
 *   custom fields as `cf[12]`.
 * - A rule for the ticket's type wins over the set's rule for every type; a field without a
 *   rule is optional and shown. The summary is always required and shown.
 * - A layout for the ticket's type wins over the set's layout for every type; without one, the
 *   form shows every field that applies, in one tab. Hidden fields never appear; required fields
 *   always do (a layout that leaves one out gets it in a section of its own), so a form can
 *   always be completed. `others: 'show'` appends the fields a layout does not place.
 * - Formula fields (M1-013) are computed: a create form never shows them, and no rule makes
 *   them required.
 */
const NO_RULE: RuleDef = { required: false, hidden: false, description: null };

export function ruleOf(catalog: Catalog, at: FormPlacement, key: string): RuleDef {
  if (FIXED_FIELDS.has(key)) return { required: true, hidden: false, description: null };
  const forms = catalog.forms;
  const set = forms.ruleSets.get(at.ruleSetId ?? forms.defaultRuleSetId ?? 0);
  if (!set) return NO_RULE;
  return set.rules.get(`${at.ticketTypeId}|${key}`) ?? set.rules.get(`0|${key}`) ?? NO_RULE;
}

/** Every field that applies to the ticket: the system ones, then its custom ones by name. */
export function applicableKeys(catalog: Catalog, at: FormPlacement): string[] {
  return [
    ...SYSTEM_FIELDS.map((f) => f.key as string),
    ...catalog.applicable(at.trackId, at.ticketTypeId).map((f) => customKey(f.id)),
  ];
}

export interface ResolvedField {
  key: string;
  required: boolean;
  /** Help text: the rule's, else the context's, else the field's; null for none. */
  description: string | null;
}
export interface ResolvedSection {
  kind: 'main' | 'context';
  hideWhenEmpty: boolean;
  fields: ResolvedField[];
}
export interface ResolvedLayout {
  operation: Operation;
  /** A tab's name; null for the one tab of a generated layout or the tab of the rest. */
  tabs: { name: string | null; sections: ResolvedSection[] }[];
}

function layoutOf(
  catalog: Catalog,
  at: FormPlacement,
  operation: Operation,
): LayoutDefinition | null {
  const forms = catalog.forms;
  const set = forms.layoutSets.get(at.layoutSetId ?? forms.defaultLayoutSetId ?? 0);
  if (!set) return null;
  return (
    set.layouts.get(`${at.ticketTypeId}|${operation}`) ?? set.layouts.get(`0|${operation}`) ?? null
  );
}

/** The form for an operation on a ticket of a type in a track. */
export function resolveLayout(
  catalog: Catalog,
  at: FormPlacement,
  operation: Operation,
): ResolvedLayout {
  const applicable = applicableKeys(catalog, at);
  const applies = new Set(applicable);
  const field = (key: string): ResolvedField | null => {
    if (!applies.has(key)) return null;
    const rule = ruleOf(catalog, at, key);
    if (rule.hidden) return null;
    let description = rule.description;
    const id = customFieldId(key);
    // There is nothing to enter for a computed value before the ticket exists.
    if (operation === 'create' && id !== null && catalog.fields.get(id)?.type === 'formula') {
      return null;
    }
    if (description === null && id !== null) {
      const def = catalog.fields.get(id) as FieldDef;
      const context = catalog.contextOf(id, at.trackId, at.ticketTypeId) as ContextDef;
      description = context.description || def.description || null;
    }
    return { key, required: rule.required, description };
  };
  const definition = layoutOf(catalog, at, operation) ?? { tabs: [], others: 'show' as const };
  const placed = new Set<string>();
  const tabs: ResolvedLayout['tabs'] = definition.tabs.map((tab) => ({
    name: tab.name,
    sections: tab.sections.map((section) => ({
      kind: section.kind,
      hideWhenEmpty: section.hideWhenEmpty,
      fields: section.fields.flatMap((key) => {
        placed.add(key);
        const f = field(key);
        return f ? [f] : [];
      }),
    })),
  }));
  // The rest: every unplaced field when the layout says so, and required ones always.
  const rest = applicable
    .filter((key) => !placed.has(key))
    .map(field)
    .filter((f): f is ResolvedField => f !== null)
    .filter((f) => definition.others === 'show' || f.required);
  if (rest.length > 0) {
    tabs.push({ name: null, sections: [{ kind: 'main', hideWhenEmpty: false, fields: rest }] });
  }
  return { operation, tabs };
}

/** The fields a form shows, and which of them are required. */
export function formFields(layout: ResolvedLayout): { shown: Set<string>; required: Set<string> } {
  const shown = new Set<string>();
  const required = new Set<string>();
  for (const tab of layout.tabs) {
    for (const section of tab.sections) {
      for (const f of section.fields) {
        shown.add(f.key);
        if (f.required) required.add(f.key);
      }
    }
  }
  return { shown, required };
}

/**
 * Why a field may not be written through a form, or null: hidden by a rule (CORE-013 (2)), or
 * not on the operation's layout.
 */
export function writeProblem(
  catalog: Catalog,
  at: FormPlacement,
  shown: ReadonlySet<string>,
  key: string,
): 'hidden' | 'not_on_layout' | null {
  if (ruleOf(catalog, at, key).hidden) return 'hidden';
  return shown.has(key) ? null : 'not_on_layout';
}

/** Whether a ticket has no value for a field (a required one is refused so). */
export function isEmptyOn(row: TicketRow, key: string): boolean {
  const id = customFieldId(key);
  if (id !== null) return !Object.hasOwn(row.fields, String(id));
  switch (key as SystemField) {
    case 'summary':
      return row.summary.trim() === '';
    case 'description':
      return row.description === null;
    case 'environment':
      return row.environment === null;
    case 'assignee':
      return row.assignee_id === null;
    case 'requester':
      return row.requester_id === null;
    case 'parent':
      return row.parent_id === null;
    case 'priority':
      return row.priority_id === null;
    case 'closeReason':
      return row.close_reason_id === null;
    case 'labels':
      return row.labels.length === 0;
    case 'startDate':
      return row.start_date === null;
    case 'dueDate':
      return row.due_date === null;
    case 'targetRelease':
      return row.target_releases.length === 0;
    case 'foundInRelease':
      return row.found_releases.length === 0;
    case 'area':
      return row.areas.length === 0;
    case 'originalEstimate':
      return row.original_estimate === null;
    case 'remainingEstimate':
      return row.remaining_estimate === null;
  }
  return false;
}

/** Required fields among `keys` that the ticket leaves empty, by body key; null when none. */
export function missingRequired(
  row: TicketRow,
  required: ReadonlySet<string>,
  keys: Iterable<string> = required,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (required.has(key) && isEmptyOn(row, key)) out[bodyKey(key)] = 'required';
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Fields written that a form may not take (hidden or not on its layout), by body key. */
export function layoutProblems(
  catalog: Catalog,
  at: FormPlacement,
  shown: ReadonlySet<string>,
  written: Iterable<string>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const key of written) {
    const problem = writeProblem(catalog, at, shown, key);
    if (problem) out[bodyKey(key)] = problem;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A workflow's field name (`close-reason`) as rules and layouts name it (`closeReason`). */
export const ruleKeyOfWorkflowField = (name: string) =>
  customFieldId(name) !== null
    ? name
    : name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
