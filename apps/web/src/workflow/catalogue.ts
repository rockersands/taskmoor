import type { CompareOp } from '@taskmoor/workflow';
import type { MessageId } from '../i18n/messages.en';
import type { CheckDef, EffectDef, GuardNode, RuleDef } from './definition';

/**
 * The guards, checks, effects and local-mode rules the editor offers (spec 01a sections 3.2 to
 * 3.5; M1-030), each with the parameters its form shows. The tables are typed against the
 * workflow model: a type the model gains or a parameter it renames fails to compile here, so
 * the forms cannot drift from what the engine runs. The parameter kinds also drive the text
 * mode's shape check (`shape.ts`), which mirrors the server's schema.
 */
export type GuardLeaf = Exclude<GuardNode, { all: GuardNode[] } | { any: GuardNode[] }>;
export type RuleKind = 'guard' | 'check' | 'effect' | 'rule';

export type FieldSet = 'readable' | 'writable' | 'number' | 'date' | 'user';

/** What a parameter holds, which decides its control and its shape check. */
export type ParamKind =
  | { kind: 'field'; fields: FieldSet }
  | { kind: 'op' }
  | { kind: 'number' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'text'; min: number; max: number }
  | { kind: 'pattern' }
  | { kind: 'permission'; min: number }
  | { kind: 'status' }
  | { kind: 'statuses' }
  | { kind: 'transition' }
  | { kind: 'role' }
  | { kind: 'roles' }
  | { kind: 'group' }
  | { kind: 'groups' }
  | { kind: 'users' }
  | { kind: 'boolean' }
  | { kind: 'value' }
  | { kind: 'url' }
  | { kind: 'levels' }
  | { kind: 'assignTarget' }
  | { kind: 'systemField' }
  | { kind: 'readonly'; max: number };

type ParamSpec<Optional extends boolean> = ParamKind & {
  labelId: MessageId;
  hintId?: MessageId;
} & (Optional extends true ? { optional: true } : { optional?: false });

type IsOptional<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? true : false;
type Params<T> = {
  [P in Exclude<keyof T, 'type' | 'message'>]-?: ParamSpec<IsOptional<T, P>>;
};
type Catalogue<T extends { type: string }> = {
  [K in T['type']]: { labelId: MessageId; params: Params<Extract<T, { type: K }>> };
};

/** One parameter as the forms and the shape check read it. */
export type AnyParamSpec = ParamKind & {
  labelId: MessageId;
  hintId?: MessageId;
  optional?: boolean;
};
export interface CatalogueEntry {
  labelId: MessageId;
  params: Record<string, AnyParamSpec>;
}

const field = (fields: FieldSet, labelId: MessageId = 'workflow.param.field') =>
  ({ kind: 'field', fields, labelId }) as const;
const op = { kind: 'op', labelId: 'workflow.param.op' } as const;
const flag = (labelId: MessageId) => ({ kind: 'boolean', labelId, optional: true }) as const;
const status = { kind: 'status', labelId: 'workflow.param.status' } as const;
const statuses = { kind: 'statuses', labelId: 'workflow.param.statuses' } as const;
const value = {
  kind: 'value',
  labelId: 'workflow.param.value',
  hintId: 'workflow.param.valueHint',
} as const;
const permission = (min: number) =>
  ({ kind: 'permission', min, labelId: 'workflow.param.permission' }) as const;

export const GUARDS: Catalogue<GuardLeaf> = {
  'only-assignee': { labelId: 'workflow.guardType.onlyAssignee', params: {} },
  'only-requester': { labelId: 'workflow.guardType.onlyRequester', params: {} },
  permission: { labelId: 'workflow.guardType.permission', params: { permission: permission(1) } },
  'user-in-role': {
    labelId: 'workflow.guardType.userInRole',
    params: { role: { kind: 'role', labelId: 'workflow.param.role' } },
  },
  'user-in-any-role': {
    labelId: 'workflow.guardType.userInAnyRole',
    params: { roles: { kind: 'roles', labelId: 'workflow.param.roles' } },
  },
  'user-in-group': {
    labelId: 'workflow.guardType.userInGroup',
    params: { group: { kind: 'group', labelId: 'workflow.param.group' } },
  },
  'user-in-any-group': {
    labelId: 'workflow.guardType.userInAnyGroup',
    params: { groups: { kind: 'groups', labelId: 'workflow.param.groups' } },
  },
  'user-in-field': {
    labelId: 'workflow.guardType.userInField',
    params: { field: field('user') },
  },
  'user-in-group-field': {
    labelId: 'workflow.guardType.userInGroupField',
    params: { field: field('readable') },
  },
  'previous-status': {
    labelId: 'workflow.guardType.previousStatus',
    params: { status, mostRecentOnly: flag('workflow.param.mostRecentOnly') },
  },
  'separation-of-duties': {
    labelId: 'workflow.guardType.separationOfDuties',
    params: { transition: { kind: 'transition', labelId: 'workflow.param.transition' } },
  },
  'subticket-blocking': {
    labelId: 'workflow.guardType.subticketBlocking',
    params: { statuses },
  },
  'compare-number': {
    labelId: 'workflow.guardType.compareNumber',
    params: {
      field: field('number'),
      op,
      value: { kind: 'number', labelId: 'workflow.param.number' },
    },
  },
  'value-field': {
    labelId: 'workflow.guardType.valueField',
    params: { field: field('readable'), op, value },
  },
  'hide-from-user': { labelId: 'workflow.guardType.hideFromUser', params: {} },
  'block-until-approval': { labelId: 'workflow.guardType.blockUntilApproval', params: {} },
  'always-false': { labelId: 'workflow.guardType.alwaysFalse', params: {} },
};

export const CHECKS: Catalogue<CheckDef> = {
  'field-required': {
    labelId: 'workflow.checkType.fieldRequired',
    params: { field: field('readable') },
  },
  'field-modified': {
    labelId: 'workflow.checkType.fieldModified',
    params: { field: field('readable') },
  },
  'field-single-value': {
    labelId: 'workflow.checkType.fieldSingleValue',
    params: { field: field('readable') },
  },
  regex: {
    labelId: 'workflow.checkType.regex',
    params: {
      field: field('readable'),
      pattern: { kind: 'pattern', labelId: 'workflow.param.pattern' },
    },
  },
  'date-compare': {
    labelId: 'workflow.checkType.dateCompare',
    params: {
      field: field('date'),
      op,
      other: field('date', 'workflow.param.other'),
      includeTime: flag('workflow.param.includeTime'),
    },
  },
  'date-window': {
    labelId: 'workflow.checkType.dateWindow',
    params: {
      field: field('date'),
      other: field('date', 'workflow.param.other'),
      days: { kind: 'integer', min: 0, max: 36_500, labelId: 'workflow.param.days' },
    },
  },
  'parent-status': { labelId: 'workflow.checkType.parentStatus', params: { statuses } },
  permission: { labelId: 'workflow.checkType.permission', params: { permission: permission(0) } },
  'previous-state': {
    labelId: 'workflow.checkType.previousState',
    params: { status, mostRecentOnly: flag('workflow.param.mostRecentOnly') },
  },
  'forms-attached': { labelId: 'workflow.checkType.formsAttached', params: {} },
  'forms-submitted': { labelId: 'workflow.checkType.formsSubmitted', params: {} },
};

export const EFFECTS: Catalogue<EffectDef> = {
  'assign-to-current-user': { labelId: 'workflow.effectType.assignToCurrentUser', params: {} },
  'assign-to-owner': { labelId: 'workflow.effectType.assignToOwner', params: {} },
  'assign-to-requester': { labelId: 'workflow.effectType.assignToRequester', params: {} },
  'update-field': {
    labelId: 'workflow.effectType.updateField',
    params: { field: field('writable'), value },
  },
  'update-system-field': {
    labelId: 'workflow.effectType.updateSystemField',
    params: { field: { kind: 'systemField', labelId: 'workflow.param.field' }, value },
  },
  'clear-field': {
    labelId: 'workflow.effectType.clearField',
    params: { field: field('writable') },
  },
  'copy-field': {
    labelId: 'workflow.effectType.copyField',
    params: {
      from: field('readable', 'workflow.param.from'),
      to: field('writable', 'workflow.param.to'),
      fromParent: flag('workflow.param.fromParent'),
    },
  },
  'set-visibility-level-from-role': {
    labelId: 'workflow.effectType.setVisibilityLevel',
    params: {
      levels: {
        kind: 'levels',
        labelId: 'workflow.param.levels',
        hintId: 'workflow.param.levelsHint',
      },
    },
  },
  webhook: {
    labelId: 'workflow.effectType.webhook',
    params: { url: { kind: 'url', labelId: 'workflow.param.url' } },
  },
  placeholder: {
    labelId: 'workflow.effectType.placeholder',
    params: { jiraClass: { kind: 'readonly', max: 500, labelId: 'workflow.param.importedClass' } },
  },
};

export const RULES: Catalogue<RuleDef> = {
  assign: {
    labelId: 'workflow.ruleType.assign',
    params: { to: { kind: 'assignTarget', labelId: 'workflow.param.assignTo' } },
  },
  'restrict-field-value': {
    labelId: 'workflow.ruleType.restrictFieldValue',
    params: { field: field('readable'), value },
  },
  'restrict-been-through': {
    labelId: 'workflow.ruleType.restrictBeenThrough',
    params: {
      status,
      includeCurrent: flag('workflow.param.includeCurrent'),
      reverse: flag('workflow.param.reverse'),
      mostRecentOnly: flag('workflow.param.mostRecentOnly'),
      ignoreLoops: flag('workflow.param.ignoreLoops'),
    },
  },
  'restrict-who': {
    labelId: 'workflow.ruleType.restrictWho',
    params: {
      users: { kind: 'users', labelId: 'workflow.param.users', optional: true },
      groups: { kind: 'groups', labelId: 'workflow.param.groups', optional: true },
      roles: { kind: 'roles', labelId: 'workflow.param.roles', optional: true },
    },
  },
  'validate-permission': {
    labelId: 'workflow.ruleType.validatePermission',
    params: { permission: permission(0) },
  },
  'copy-field': {
    labelId: 'workflow.ruleType.copyField',
    params: {
      from: field('readable', 'workflow.param.from'),
      to: field('writable', 'workflow.param.to'),
    },
  },
  'update-field': {
    labelId: 'workflow.ruleType.updateField',
    params: { field: field('writable'), value },
  },
};

/** The table for a kind of rule, as plain entries the forms read. */
export function catalogueOf(kind: RuleKind): Record<string, CatalogueEntry> {
  const tables = { guard: GUARDS, check: CHECKS, effect: EFFECTS, rule: RULES };
  return tables[kind] as unknown as Record<string, CatalogueEntry>;
}

/** A catalogue's own entry for a type, never an inherited property. */
export function entryOf(kind: RuleKind, type: string): CatalogueEntry | undefined {
  const table = catalogueOf(kind);
  return Object.hasOwn(table, type) ? table[type] : undefined;
}

/** Types an editor may add: imported placeholders only arrive through import (WF-011). */
export function addableTypes(kind: RuleKind): string[] {
  return Object.keys(catalogueOf(kind)).filter((type) => type !== 'placeholder');
}

export const OPS: readonly CompareOp[] = ['=', '!=', '>', '>=', '<', '<='];
export const OP_LABELS: Record<CompareOp, MessageId> = {
  '=': 'workflow.op.eq',
  '!=': 'workflow.op.ne',
  '>': 'workflow.op.gt',
  '>=': 'workflow.op.ge',
  '<': 'workflow.op.lt',
  '<=': 'workflow.op.le',
};

/**
 * The ticket fields workflows read and write (apps/server/src/workflows/fields.ts), in the
 * order the forms offer them. Custom fields join with field rules and layouts (M1-012).
 */
export const WORKFLOW_FIELDS = [
  'summary',
  'description',
  'environment',
  'assignee',
  'close-reason',
  'priority',
  'labels',
  'start-date',
  'due-date',
  'original-estimate',
  'remaining-estimate',
  'target-release',
  'found-in-release',
  'area',
  'time-spent',
  'ticket-type',
  'requester',
  'creator',
] as const;
export type WorkflowField = (typeof WORKFLOW_FIELDS)[number];

const READ_ONLY_FIELDS: readonly string[] = ['time-spent', 'ticket-type', 'requester', 'creator'];
const FIELD_SETS: Record<FieldSet, readonly string[]> = {
  readable: WORKFLOW_FIELDS,
  writable: WORKFLOW_FIELDS.filter((f) => !READ_ONLY_FIELDS.includes(f)),
  number: ['original-estimate', 'remaining-estimate', 'time-spent'],
  date: ['start-date', 'due-date'],
  user: ['assignee', 'requester', 'creator'],
};

export const fieldsOf = (set: FieldSet): readonly string[] => FIELD_SETS[set];
export const isWritableField = (name: string) => FIELD_SETS.writable.includes(name);

/** The system fields `update-system-field` sets (spec 01a section 3.4). */
export const SYSTEM_FIELDS = [
  'assignee',
  'description',
  'environment',
  'priority',
  'close-reason',
  'summary',
  'original-estimate',
  'remaining-estimate',
] as const;

/** First choices for parameters that name something: a status, transition, role or group. */
export interface RuleDefaults {
  status?: string;
  transition?: string;
  role?: string;
  group?: string;
}

/** A new rule of a type with every required parameter at a starting value. */
export function blankRule(
  kind: RuleKind,
  type: string,
  defaults: RuleDefaults = {},
): Record<string, unknown> {
  const entry = entryOf(kind, type);
  const rule: Record<string, unknown> = { type };
  if (!entry) return rule;
  for (const [name, spec] of Object.entries(entry.params)) {
    if (spec.optional) continue;
    rule[name] = blankValue(spec, defaults);
  }
  return rule;
}

function blankValue(spec: AnyParamSpec, defaults: RuleDefaults): unknown {
  switch (spec.kind) {
    case 'field':
      return fieldsOf(spec.fields)[0];
    case 'systemField':
      return SYSTEM_FIELDS[0];
    case 'op':
      return '=';
    case 'number':
    case 'integer':
      return 0;
    case 'statuses':
    case 'roles':
    case 'groups':
    case 'users':
      return [];
    case 'boolean':
      return false;
    case 'value':
      return '';
    case 'levels':
      return {};
    case 'assignTarget':
      return 'current-user';
    case 'url':
      return 'https://';
    case 'pattern':
      return '.+';
    case 'permission':
      return spec.min > 0 ? 'transition_tickets' : '';
    case 'status':
    case 'transition':
    case 'role':
    case 'group':
      return defaults[spec.kind] ?? '';
    default:
      return '';
  }
}

/**
 * A value typed in a "value" box: JSON when it reads as JSON (numbers, true, null, quoted
 * text, lists, objects), the text itself otherwise, so plain words need no quotes.
 */
export function valueFromText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** How a value shows in its box; `valueFromText` reads it back unchanged. */
export function valueToText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value === undefined ? '' : JSON.stringify(value);
}

/** A list of ids typed as text: "3, 4 7" gives ["3", "4", "7"]. */
export const idsFromText = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
