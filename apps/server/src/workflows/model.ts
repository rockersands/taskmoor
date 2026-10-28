import type { StatusStage } from '@taskmoor/db';
import type {
  CheckDef,
  EffectDef,
  GuardNode,
  RuleDef,
  StatusPermissions,
  TransitionDef,
  WorkflowDef,
} from '@taskmoor/workflow';
import { z } from 'zod';
import { isKnownField, isWritableField, parseField } from './fields';

/**
 * Workflows as stored (M1-023 to M1-027; WF-001 to WF-009; spec 01a section 3). A version's
 * definition lists its statuses, its initial status and its transitions by database id; each
 * transition carries the anatomy of section 3.1: a layout of fields entered with it, guards,
 * checks, effects, properties, the event it fires and the external events that trigger it.
 * Guards, checks, effects and rules are the workflow model's own shapes
 * (`@taskmoor/workflow`), with statuses, roles, groups and users named by their ids as text.
 * `toEngine` turns a definition into the engine's `WorkflowDef`.
 */
const MAX_INT = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT);
/** An id as text, the way guards, checks and effects name statuses, roles, groups and users. */
const idText = z.string().regex(/^[1-9][0-9]{0,9}$/);
const fieldName = z.string().min(1).max(100);
const op = z.enum(['=', '!=', '>', '>=', '<', '<=']);

/** Guardrails of spec 01a section 1.7, and depth limits that keep evaluation cheap. */
export const STATUSES_PER_WORKFLOW = 200;
export const TRANSITIONS_PER_WORKFLOW = 2000;
const GUARD_DEPTH = 10;

const guardLeaf = z.discriminatedUnion('type', [
  z.object({ type: z.literal('always-false') }).strict(),
  z.object({ type: z.literal('block-until-approval') }).strict(),
  z.object({ type: z.literal('compare-number'), field: fieldName, op, value: z.number() }).strict(),
  z.object({ type: z.literal('hide-from-user') }).strict(),
  z.object({ type: z.literal('only-assignee') }).strict(),
  z.object({ type: z.literal('only-requester') }).strict(),
  z.object({ type: z.literal('permission'), permission: z.string().min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal('previous-status'),
      status: idText,
      mostRecentOnly: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('separation-of-duties'), transition: idText }).strict(),
  z.object({ type: z.literal('subticket-blocking'), statuses: z.array(idText).max(200) }).strict(),
  z.object({ type: z.literal('user-in-group'), group: idText }).strict(),
  z.object({ type: z.literal('user-in-any-group'), groups: z.array(idText).max(200) }).strict(),
  z.object({ type: z.literal('user-in-role'), role: idText }).strict(),
  z.object({ type: z.literal('user-in-any-role'), roles: z.array(idText).max(200) }).strict(),
  z.object({ type: z.literal('user-in-field'), field: fieldName }).strict(),
  z.object({ type: z.literal('user-in-group-field'), field: fieldName }).strict(),
  z.object({ type: z.literal('value-field'), field: fieldName, op, value: z.unknown() }).strict(),
]);
const guardNode: z.ZodType<GuardNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(guardNode).max(100) }).strict(),
    z.object({ any: z.array(guardNode).max(100) }).strict(),
    guardLeaf,
  ]),
) as z.ZodType<GuardNode>;

const message = { message: z.string().max(500).optional() };
const checkDef: z.ZodType<CheckDef> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('field-required'), field: fieldName, ...message }).strict(),
  z.object({ type: z.literal('field-modified'), field: fieldName, ...message }).strict(),
  z.object({ type: z.literal('field-single-value'), field: fieldName, ...message }).strict(),
  z
    .object({
      type: z.literal('date-compare'),
      field: fieldName,
      op,
      other: fieldName,
      includeTime: z.boolean().optional(),
      ...message,
    })
    .strict(),
  z
    .object({
      type: z.literal('date-window'),
      field: fieldName,
      other: fieldName,
      days: z.number().int().min(0).max(36_500),
      ...message,
    })
    .strict(),
  z
    .object({
      type: z.literal('regex'),
      field: fieldName,
      pattern: z.string().min(1).max(500),
      ...message,
    })
    .strict(),
  z.object({ type: z.literal('forms-attached'), ...message }).strict(),
  z.object({ type: z.literal('forms-submitted'), ...message }).strict(),
  z
    .object({ type: z.literal('parent-status'), statuses: z.array(idText).max(200), ...message })
    .strict(),
  z.object({ type: z.literal('permission'), permission: z.string().max(100), ...message }).strict(),
  z
    .object({
      type: z.literal('previous-state'),
      status: idText,
      mostRecentOnly: z.boolean().optional(),
      ...message,
    })
    .strict(),
]) as z.ZodType<CheckDef>;

const SYSTEM_FIELDS = [
  'assignee',
  'description',
  'environment',
  'priority',
  'close-reason',
  'summary',
  'original-estimate',
  'remaining-estimate',
] as const;
const effectDef: z.ZodType<EffectDef> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign-to-current-user') }).strict(),
  z.object({ type: z.literal('assign-to-owner') }).strict(),
  z.object({ type: z.literal('assign-to-requester') }).strict(),
  z.object({ type: z.literal('clear-field'), field: fieldName }).strict(),
  z
    .object({
      type: z.literal('copy-field'),
      from: fieldName,
      to: fieldName,
      fromParent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set-visibility-level-from-role'),
      levels: z.record(idText, z.string().max(100)),
    })
    .strict(),
  z
    .object({
      type: z.literal('webhook'),
      url: z
        .string()
        .max(2000)
        .refine((u) => /^https?:\/\//.test(u), 'an http or https URL'),
    })
    .strict(),
  z.object({ type: z.literal('update-field'), field: fieldName, value: z.unknown() }).strict(),
  z
    .object({
      type: z.literal('update-system-field'),
      field: z.enum(SYSTEM_FIELDS),
      value: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal('placeholder'), jiraClass: z.string().max(500) }).strict(),
]) as z.ZodType<EffectDef>;

const ruleDef: z.ZodType<RuleDef> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('assign'),
      to: z.union([
        z.literal('current-user'),
        z.literal('requester'),
        z.object({ user: idText }).strict(),
      ]),
    })
    .strict(),
  z
    .object({ type: z.literal('restrict-field-value'), field: fieldName, value: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal('restrict-been-through'),
      status: idText,
      includeCurrent: z.boolean().optional(),
      reverse: z.boolean().optional(),
      mostRecentOnly: z.boolean().optional(),
      ignoreLoops: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('restrict-who'),
      users: z.array(idText).max(200).optional(),
      groups: z.array(idText).max(200).optional(),
      roles: z.array(idText).max(200).optional(),
    })
    .strict(),
  z.object({ type: z.literal('validate-permission'), permission: z.string().max(100) }).strict(),
  z.object({ type: z.literal('copy-field'), from: fieldName, to: fieldName }).strict(),
  z.object({ type: z.literal('update-field'), field: fieldName, value: z.unknown() }).strict(),
]) as z.ZodType<RuleDef>;

const principal = z.union([
  z.object({ role: idText }).strict(),
  z.object({ group: idText }).strict(),
]);
const statusPermissions = z
  .object({
    edit: z.array(principal).max(50).optional(),
    comment: z.array(principal).max(50).optional(),
    attach: z.array(principal).max(50).optional(),
    assign: z.array(principal).max(50).optional(),
    transition: z.array(principal).max(50).optional(),
  })
  .strict();

export const transitionSchema = z
  .object({
    /** Stable across versions, so history and integrations can name it. */
    id,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).optional(),
    from: z.union([z.literal('any'), z.array(id).min(1).max(STATUSES_PER_WORKFLOW)]),
    to: id,
    /** Fields entered with the transition, saved with it (WF-006). */
    layout: z.array(fieldName).max(50).optional(),
    guards: guardNode.optional(),
    checks: z.array(checkDef).max(50).optional(),
    effects: z.array(effectDef).max(50).optional(),
    properties: z.record(z.string().min(1).max(255), z.string().max(4000)).optional(),
    /** The event it fires: generic unless a custom one is named (WF-006 (3)). */
    event: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,99}$/)
      .optional(),
    /** External events that run it as automation (M1-024; development events arrive in M2). */
    triggers: z
      .array(z.object({ event: z.string().regex(/^[a-z][a-z0-9.:-]{0,199}$/) }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export type Transition = z.infer<typeof transitionSchema>;

export const definitionSchema = z
  .object({
    initialStatusId: id,
    statuses: z
      .array(
        z
          .object({
            statusId: id,
            /** Where the editor's diagram draws it. */
            x: z.number().finite().optional(),
            y: z.number().finite().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(STATUSES_PER_WORKFLOW),
    transitions: z.array(transitionSchema).max(TRANSITIONS_PER_WORKFLOW),
    /** What creating a ticket does beyond the initial status (WF-005 (3)). */
    onCreate: z
      .object({
        effects: z.array(effectDef).max(50).optional(),
        event: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,99}$/)
          .optional(),
      })
      .strict()
      .optional(),
    /** Local-mode rules by transition id (WF-009). */
    rules: z.record(idText, z.array(ruleDef).max(50)).optional(),
    /** Who may do what in a status (WF-007), by status id. */
    statusPermissions: z.record(idText, statusPermissions).optional(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export type DefinitionProblem =
  | { problem: 'unknown_status'; statusId: number }
  | { problem: 'duplicate_status'; statusId: number }
  | { problem: 'initial_not_in_workflow' }
  | { problem: 'duplicate_transition'; transitionId: number }
  | { problem: 'transition_status_not_in_workflow'; transitionId: number; statusId: number }
  | { problem: 'unknown_field'; transitionId: number | null; field: string }
  | { problem: 'field_not_writable'; transitionId: number | null; field: string }
  | { problem: 'invalid_value'; transitionId: number | null; field: string }
  | { problem: 'invalid_pattern'; transitionId: number; pattern: string }
  | { problem: 'guards_too_deep'; transitionId: number };

const depth = (node: GuardNode): number =>
  'all' in node
    ? 1 + Math.max(0, ...node.all.map(depth))
    : 'any' in node
      ? 1 + Math.max(0, ...node.any.map(depth))
      : 1;

/** Fields a guard tree reads. */
function guardFields(node: GuardNode | undefined): string[] {
  if (!node) return [];
  if ('all' in node) return node.all.flatMap(guardFields);
  if ('any' in node) return node.any.flatMap(guardFields);
  return 'field' in node ? [node.field] : [];
}

/** Fields effects write, with the value an update sets when there is one. */
function effectWrites(effects: readonly EffectDef[]): { field: string; value?: unknown }[] {
  return effects.flatMap((e) => {
    switch (e.type) {
      case 'clear-field':
        return [{ field: e.field, value: null }];
      case 'copy-field':
        return [{ field: e.to }];
      case 'update-field':
      case 'update-system-field':
        return [{ field: e.field, value: e.value }];
      case 'assign-to-current-user':
      case 'assign-to-owner':
      case 'assign-to-requester':
        return [{ field: 'assignee' }];
      default:
        return [];
    }
  });
}

/** Why a definition cannot be saved, or null. `known` holds the workspace's statuses. */
export function definitionProblem(
  definition: WorkflowDefinition,
  known: ReadonlySet<number>,
): DefinitionProblem | null {
  const statuses = new Set<number>();
  for (const { statusId } of definition.statuses) {
    if (!known.has(statusId)) return { problem: 'unknown_status', statusId };
    if (statuses.has(statusId)) return { problem: 'duplicate_status', statusId };
    statuses.add(statusId);
  }
  if (!statuses.has(definition.initialStatusId)) return { problem: 'initial_not_in_workflow' };
  const ids = new Set<number>();
  const writes = (transitionId: number | null, effects: readonly EffectDef[]) => {
    for (const w of effectWrites(effects)) {
      if (!isKnownField(w.field))
        return { problem: 'unknown_field' as const, transitionId, field: w.field };
      if (!isWritableField(w.field)) {
        return { problem: 'field_not_writable' as const, transitionId, field: w.field };
      }
      if (w.value !== undefined && !parseField(w.field, w.value).ok) {
        return { problem: 'invalid_value' as const, transitionId, field: w.field };
      }
    }
    return null;
  };
  for (const t of definition.transitions) {
    if (ids.has(t.id)) return { problem: 'duplicate_transition', transitionId: t.id };
    ids.add(t.id);
    for (const statusId of [...(t.from === 'any' ? [] : t.from), t.to]) {
      if (!statuses.has(statusId)) {
        return { problem: 'transition_status_not_in_workflow', transitionId: t.id, statusId };
      }
    }
    if (t.guards && depth(t.guards) > GUARD_DEPTH) {
      return { problem: 'guards_too_deep', transitionId: t.id };
    }
    for (const field of t.layout ?? []) {
      if (!isKnownField(field)) return { problem: 'unknown_field', transitionId: t.id, field };
      if (!isWritableField(field))
        return { problem: 'field_not_writable', transitionId: t.id, field };
    }
    const read = [
      ...guardFields(t.guards),
      ...(t.checks ?? []).flatMap((c) => [
        ...('field' in c ? [c.field] : []),
        ...('other' in c ? [c.other] : []),
      ]),
      ...(t.effects ?? []).flatMap((e) => (e.type === 'copy-field' ? [e.from] : [])),
    ];
    for (const field of read) {
      if (!isKnownField(field)) return { problem: 'unknown_field', transitionId: t.id, field };
    }
    for (const c of t.checks ?? []) {
      if (c.type !== 'regex') continue;
      try {
        new RegExp(c.pattern);
      } catch {
        return { problem: 'invalid_pattern', transitionId: t.id, pattern: c.pattern };
      }
    }
    const effects = writes(t.id, t.effects ?? []);
    if (effects) return effects;
  }
  return writes(null, definition.onCreate?.effects ?? []);
}

export const statusIdsOf = (definition: WorkflowDefinition): Set<number> =>
  new Set(definition.statuses.map((s) => s.statusId));

/** Statuses in `before` that `after` no longer has. */
export function removedStatuses(before: WorkflowDefinition, after: WorkflowDefinition): number[] {
  const kept = statusIdsOf(after);
  return [...statusIdsOf(before)].filter((s) => !kept.has(s)).sort((a, b) => a - b);
}

/** The engine's view of a definition: ids as text, status names and stages filled in. */
export function toEngine(
  workflowId: number,
  definition: WorkflowDefinition,
  statuses: ReadonlyMap<number, { name: string; stage: StatusStage }>,
): WorkflowDef {
  const transitions: TransitionDef[] = definition.transitions.map((t) => ({
    id: String(t.id),
    name: t.name,
    from: t.from === 'any' ? 'any' : t.from.map(String),
    to: String(t.to),
    ...(t.layout ? { layout: t.layout } : {}),
    ...(t.guards ? { guards: t.guards } : {}),
    ...(t.checks ? { checks: t.checks } : {}),
    ...(t.effects ? { effects: t.effects } : {}),
    ...(t.properties ? { properties: t.properties } : {}),
    ...(t.event ? { event: t.event } : {}),
  }));
  if (definition.onCreate) {
    transitions.push({
      id: 'create',
      name: 'Create',
      from: [],
      to: String(definition.initialStatusId),
      ...(definition.onCreate.effects ? { effects: definition.onCreate.effects } : {}),
      ...(definition.onCreate.event ? { event: definition.onCreate.event } : {}),
    });
  }
  return {
    id: String(workflowId),
    statuses: definition.statuses.map((s) => ({
      id: String(s.statusId),
      name: statuses.get(s.statusId)?.name ?? '',
      stage: statuses.get(s.statusId)?.stage ?? 'new',
    })),
    initial: String(definition.initialStatusId),
    transitions,
    ...(definition.rules ? { rules: definition.rules } : {}),
    ...(definition.statusPermissions
      ? { statusPermissions: definition.statusPermissions as Record<string, StatusPermissions> }
      : {}),
  };
}
