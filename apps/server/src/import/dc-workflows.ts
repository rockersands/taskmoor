import type { JsonValue } from '@taskmoor/db';
import {
  type CheckDef,
  type EffectDef,
  type GuardNode,
  JIRA_FUNCTION_MAP,
} from '@taskmoor/workflow';
import type {
  StagedWorkflow,
  StagedWorkflowRefs,
  StagedWorkflowScheme,
} from './dc-backup/stage-workflows';
import {
  conditionLeaves,
  FIRST_CUSTOM_EVENT,
  isGroup,
  META,
  type WfAction,
  type WfCondition,
  type WfConditions,
  type WfFunction,
  type WfStep,
} from './dc-backup/workflow-format';
import { plainDoc } from './dc-fields';
import { customEventName, PERMISSIONS } from './dc-schemes';
import type { Mapped, Ref, Warning } from './model';

/**
 * The Data Center backup's workflows and workflow schemes in Taskmoor's terms (M1-090; IMP-004,
 * IMP-005, WF-011; ADR-093). A workflow becomes a published workflow (version 1) whose
 * definition names the backup's statuses, groups and roles by source id; the loader maps them
 * (`remap.ts`) and checks the definition before writing it. Each step is a status, the initial
 * action gives the initial status and the effects of creating a ticket, global actions become
 * transitions from any status, common actions transitions from every step that offers them, and
 * a step's own actions transitions from its status. Screens become transition layouts, action
 * meta transition properties, step properties per-status permissions, and a custom event the
 * transition's own event.
 *
 * Every condition, validator and post function maps by class to the matching guard, check or
 * effect (`JIRA_FUNCTION_MAP`), with its arguments. One that cannot map is listed in the report
 * with what it was and why, and stands in so the result is never wider than the source:
 *
 * - a condition becomes `always-false`, so its transition stays closed (or its alternative in an
 *   any-group falls away) until an administrator replaces it;
 * - a validator is left out (a check guards data, not access), and reported;
 * - a post function becomes a disabled placeholder that keeps its class (WF-011 (2)).
 *
 * Workflow schemes become workflow maps for the tracks that use them. Identical workflows and the
 * schemes that become identical with them are merged by the stage, and skipped here with the one
 * they repeat. The built-in workflow, which a backup does not hold, links to the target's default.
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** Fields a screen names, as the fields Taskmoor's transition layouts take. */
const LAYOUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  summary: ['summary'],
  description: ['description'],
  environment: ['environment'],
  assignee: ['assignee'],
  resolution: ['close-reason'],
  priority: ['priority'],
  labels: ['labels'],
  duedate: ['due-date'],
  fixVersions: ['target-release'],
  versions: ['found-in-release'],
  components: ['area'],
  timeoriginalestimate: ['original-estimate'],
  timeestimate: ['remaining-estimate'],
  timetracking: ['original-estimate', 'remaining-estimate'],
};
/** Screen fields every transition has anyway, or that no layout needs. */
const LAYOUT_IMPLIED = new Set(['comment', 'issuetype', 'project']);

/** Fields `UpdateIssueFieldFunction` names, as Taskmoor's system fields. */
const UPDATE_FIELDS = {
  resolution: 'close-reason',
  assignee: 'assignee',
  priority: 'priority',
  summary: 'summary',
  description: 'description',
  environment: 'environment',
  timeoriginalestimate: 'original-estimate',
  timeestimate: 'remaining-estimate',
} as const;
/** Updated fields whose value names another object: only clearing them maps. */
const REFERENCE_FIELDS = new Set(['close-reason', 'assignee', 'priority']);

/** People fields a user condition may name that Taskmoor's workflows read. */
const PERSON_FIELDS: Readonly<Record<string, string>> = {
  assignee: 'assignee',
  reporter: 'requester',
  creator: 'creator',
};

/** Per-status permissions a step property may limit. */
const STATUS_PERMISSIONS = new Set(['edit', 'comment', 'attach', 'assign', 'transition']);

type Leaf<T> = { ok: T } | { reason: string };

interface Context {
  w: StagedWorkflow;
  refs: StagedWorkflowRefs;
  warnings: Warning[];
  statusName: (id: string) => string;
}

const permissionOf = (f: WfFunction): string | undefined => {
  const key = f.args.permissionKey ?? f.args.permission;
  return key === undefined ? undefined : PERMISSIONS[key.trim()];
};
const listOf = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** A condition as a guard leaf, or why it cannot be one. */
function guardLeaf(c: WfCondition, ctx: Context): Leaf<GuardNode> {
  if (c.className === null) return { reason: `script_not_mapped: ${c.type}` };
  const type = JIRA_FUNCTION_MAP[c.className];
  if (type === undefined) return { reason: 'class_not_mapped' };
  if (c.negate) return { reason: 'negated' };
  const { args } = c;
  switch (type) {
    case 'only-assignee':
    case 'only-requester':
    case 'always-false':
      return { ok: { type } };
    case 'permission': {
      const permission = permissionOf(c);
      return permission
        ? { ok: { type, permission } }
        : { reason: `permission_not_mapped: ${args.permissionKey ?? args.permission ?? ''}` };
    }
    case 'subticket-blocking': {
      const statuses = listOf(args.statuses);
      const known = statuses.filter((s) => ctx.refs.statuses.includes(s));
      // A status that did not come along narrows the list: never wider.
      for (const s of statuses) {
        if (!known.includes(s))
          ctx.warnings.push({ code: 'status_not_found', detail: `${ctx.w.name}: ${s}` });
      }
      return { ok: { type, statuses: known } };
    }
    case 'user-in-group': {
      const group = args.group === undefined ? null : (ctx.refs.groups[args.group] ?? null);
      return group === null
        ? { reason: `group_not_found: ${args.group ?? ''}` }
        : { ok: { type, group } };
    }
    case 'user-in-role': {
      const role = args['jira.projectrole.id'] ?? '';
      return ctx.refs.roles.includes(role)
        ? { ok: { type, role } }
        : { reason: `role_not_found: ${role}` };
    }
    case 'user-in-any-role': {
      const roles = listOf(args['jira.projectrole.ids']).filter((r) => ctx.refs.roles.includes(r));
      return roles.length > 0 ? { ok: { type, roles } } : { reason: 'role_not_found' };
    }
    case 'user-in-field': {
      const field = PERSON_FIELDS[args.fieldName ?? ''];
      return field
        ? { ok: { type, field } }
        : { reason: `field_not_readable: ${args.fieldName ?? ''}` };
    }
    case 'user-in-group-field':
      // Taskmoor's workflows read system fields only; group fields are custom ones.
      return { reason: `field_not_readable: ${args.groupcf ?? args.fieldName ?? ''}` };
    default:
      return { reason: `kind_not_mapped: ${type}` };
  }
}

/** A validator as a check, or why it cannot be one. */
function checkOf(v: WfFunction): Leaf<CheckDef> {
  if (v.className === null) return { reason: `script_not_mapped: ${v.type}` };
  const type = JIRA_FUNCTION_MAP[v.className];
  if (type === undefined) return { reason: 'class_not_mapped' };
  if (type !== 'permission') return { reason: `kind_not_mapped: ${type}` };
  const permission = permissionOf(v);
  return permission
    ? { ok: { type, permission } }
    : { reason: `permission_not_mapped: ${v.args.permissionKey ?? v.args.permission ?? ''}` };
}

/** A post function as an effect, nothing (an essential one), or why it cannot be one. */
function effectOf(f: WfFunction): Leaf<EffectDef | null> {
  if (f.className === null) return { reason: `script_not_mapped: ${f.type}` };
  const type = JIRA_FUNCTION_MAP[f.className];
  if (type === undefined) {
    return {
      reason: f.className.includes('.webhooks.') ? 'webhook_not_imported' : 'class_not_mapped',
    };
  }
  switch (type) {
    case 'essential':
      return { ok: null };
    case 'assign-to-current-user':
    case 'assign-to-owner':
    case 'assign-to-requester':
      return { ok: { type } };
    case 'update-system-field': {
      const name = f.args['field.name'] ?? '';
      const field = (
        UPDATE_FIELDS as Record<string, (typeof UPDATE_FIELDS)[keyof typeof UPDATE_FIELDS]>
      )[name];
      if (!field) return { reason: `field_not_mapped: ${name}` };
      const raw = f.args['field.value'] ?? '';
      if (raw.trim() === '') return { ok: { type, field, value: null } };
      if (REFERENCE_FIELDS.has(field))
        return { reason: `value_not_mapped: ${name}=${raw.slice(0, 40)}` };
      if (field === 'original-estimate' || field === 'remaining-estimate') {
        return /^\d+$/.test(raw.trim())
          ? { ok: { type, field, value: Number(raw.trim()) } }
          : { reason: `value_not_mapped: ${name}=${raw.slice(0, 40)}` };
      }
      return {
        ok: { type, field, value: field === 'summary' ? raw.trim() : (plainDoc(raw) as JsonValue) },
      };
    }
    case 'set-visibility-level-from-role':
      // Security levels by role need the levels the target gave them, which the format names
      // by the source's ids only.
      return { reason: 'levels_not_mapped' };
    default:
      return { reason: `kind_not_mapped: ${type}` };
  }
}

const label = (w: StagedWorkflow, a: WfAction) =>
  `${w.name}: ${a.name.trim() || 'Transition'} (${a.id})`;
const ruleName = (r: WfFunction) => r.className ?? `script:${r.type}`;
const unique = (warnings: Warning[]): Warning[] => {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}\u0000${w.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** A condition group as a guard tree; groups of one collapse to their item. */
function guardOf(c: WfConditions | WfCondition, where: string, ctx: Context): GuardNode | null {
  if (!isGroup(c)) {
    const leaf = guardLeaf(c, ctx);
    if ('ok' in leaf) return leaf.ok;
    ctx.warnings.push({
      code: 'condition_not_mapped',
      detail: `${where}: ${ruleName(c)}${leaf.reason === 'class_not_mapped' ? '' : ` (${leaf.reason})`}`,
    });
    // Held closed until someone replaces it: never wider than the source.
    return { type: 'always-false' };
  }
  const items = c.items.flatMap((x) => {
    const g = guardOf(x, where, ctx);
    return g === null ? [] : [g];
  });
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] as GuardNode;
  return c.operator === 'OR' ? { any: items } : { all: items };
}

interface Built {
  checks: CheckDef[];
  effects: EffectDef[];
  event: string | null;
}

/** The validators and post functions of an action, in their order. */
function actionRules(a: WfAction, where: string, ctx: Context, create: boolean): Built {
  const out: Built = { checks: [], effects: [], event: null };
  for (const v of [...a.validators, ...(a.result?.validators ?? [])]) {
    if (create) {
      // Creating a ticket asks for "Create tickets" in Taskmoor anyway.
      if (
        JIRA_FUNCTION_MAP[v.className ?? ''] === 'permission' &&
        permissionOf(v) === 'create_tickets'
      )
        continue;
      ctx.warnings.push({ code: 'create_check_not_mapped', detail: `${where}: ${ruleName(v)}` });
      continue;
    }
    const check = checkOf(v);
    if ('ok' in check) out.checks.push(check.ok);
    else {
      ctx.warnings.push({
        code: 'check_not_mapped',
        detail: `${where}: ${ruleName(v)}${check.reason === 'class_not_mapped' ? '' : ` (${check.reason})`}`,
      });
    }
  }
  const functions = [...a.preFunctions, ...(a.result?.postFunctions ?? []), ...a.postFunctions];
  for (const f of functions) {
    if (f.className !== null && JIRA_FUNCTION_MAP[f.className] === 'essential') {
      // The event an essential function fires: a custom one becomes the transition's own.
      const event = Number(f.args.eventTypeId);
      if (f.args.eventTypeId !== undefined && event >= FIRST_CUSTOM_EVENT && out.event === null) {
        const name = ctx.refs.events[String(event)];
        if (name === undefined)
          ctx.warnings.push({ code: 'event_not_found', detail: `${where}: ${event}` });
        else out.event = customEventName(name, event);
      }
      continue;
    }
    const effect = effectOf(f);
    if ('ok' in effect) {
      if (effect.ok !== null) out.effects.push(effect.ok);
      continue;
    }
    ctx.warnings.push({
      code: 'effect_not_mapped',
      detail: `${where}: ${ruleName(f)}${effect.reason === 'class_not_mapped' ? '' : ` (${effect.reason})`}`,
    });
    out.effects.push({ type: 'placeholder', jiraClass: ruleName(f).slice(0, 500) });
  }
  if (create && a.conditions) {
    for (const c of conditionLeaves(a.conditions)) {
      ctx.warnings.push({
        code: 'create_condition_not_mapped',
        detail: `${where}: ${ruleName(c)}`,
      });
    }
  }
  return out;
}

/** A step's properties as per-status permissions; the rest is reported. */
function statusPermissionsOf(step: WfStep, status: string, ctx: Context) {
  const lists: Record<string, ({ role: string } | { group: string })[]> = {};
  const where = `${ctx.w.name}: ${ctx.statusName(status)}`;
  for (const [key, value] of Object.entries(step.meta)) {
    if (key === META.status) continue;
    if (key === META.editable) continue;
    if (!key.startsWith(META.permission)) {
      ctx.warnings.push({ code: 'status_property_not_mapped', detail: `${where}: ${key}` });
      continue;
    }
    // `jira.permission.<permission>.<grantee type>[.<n>]`.
    const [permission = '', grantee = ''] = key.slice(META.permission.length).split('.');
    if (!STATUS_PERMISSIONS.has(permission) || (grantee !== 'group' && grantee !== 'projectrole')) {
      ctx.warnings.push({ code: 'status_property_not_mapped', detail: `${where}: ${key}` });
      continue;
    }
    // The list stays even when its grantee did not come along: an empty list allows nobody.
    const list = lists[permission] ?? [];
    lists[permission] = list;
    if (grantee === 'group') {
      const group = ctx.refs.groups[value] ?? null;
      if (group === null)
        ctx.warnings.push({
          code: 'status_property_not_mapped',
          detail: `${where}: ${key} (group_not_found: ${value})`,
        });
      else list.push({ group });
    } else if (ctx.refs.roles.includes(value)) {
      list.push({ role: value });
    } else {
      ctx.warnings.push({
        code: 'status_property_not_mapped',
        detail: `${where}: ${key} (role_not_found: ${value})`,
      });
    }
  }
  // Not editable in the step: nobody edits, whatever else the step allows.
  if (step.meta[META.editable]?.trim().toLowerCase() === 'false') lists.edit = [];
  return Object.keys(lists).length > 0 ? (lists as JsonValue) : null;
}

/** A transition's layout from its screen: the fields Taskmoor's layouts take, each once. */
function layoutOf(a: WfAction, where: string, ctx: Context): string[] {
  const id = a.meta[META.screen];
  if (id === undefined) return [];
  const screen = ctx.refs.screens[id] ?? null;
  if (screen === null) {
    ctx.warnings.push({ code: 'screen_not_found', detail: `${where}: ${id}` });
    return [];
  }
  const out: string[] = [];
  for (const tab of screen.tabs) {
    for (const field of tab.fields) {
      const mapped = LAYOUT_FIELDS[field];
      if (mapped) {
        for (const m of mapped) if (!out.includes(m)) out.push(m);
      } else if (!LAYOUT_IMPLIED.has(field)) {
        ctx.warnings.push({ code: 'layout_field_not_mapped', detail: `${where}: ${field}` });
      }
    }
  }
  return out.slice(0, 50);
}

export function mapWorkflow(w: StagedWorkflow): Mapped {
  if (w.mergedInto) {
    // Identical to an earlier workflow: maps use that one (IMP-005).
    return {
      skip: 'merged_identical',
      warnings: [{ code: 'merged_into', detail: w.mergedInto.name }],
    };
  }
  if (w.system) {
    // The built-in workflow is not in the backup: its tickets use the target's default.
    if (w.someStatus === null) return { fail: 'no_statuses' };
    const status = Number(w.someStatus);
    return {
      command: {
        kind: 'workflow',
        name: w.name,
        description: '',
        isDefault: true,
        definition: { initialStatusId: status, statuses: [{ statusId: status }], transitions: [] },
      },
      warnings: [{ code: 'system_workflow_linked_to_default' }],
    };
  }
  const d = w.descriptor;
  if (d === null) return { fail: `invalid_descriptor: ${(w.problem ?? '').slice(0, 200)}` };
  const statusOfStep = new Map<number, string>();
  const stepsOfStatus = new Map<string, WfStep[]>();
  const statusNames = new Map(d.steps.map((s) => [s.meta[META.status] ?? '', s.name]));
  const ctx: Context = {
    w,
    refs: w.refs,
    warnings: [],
    statusName: (id) => statusNames.get(id) ?? id,
  };
  for (const s of d.steps) {
    const status = s.meta[META.status];
    if (status === undefined) return { fail: `step_without_status: ${s.id}` };
    if (!w.refs.statuses.includes(status)) return { fail: `unknown_status: ${status}` };
    statusOfStep.set(s.id, status);
    const list = stepsOfStatus.get(status) ?? [];
    if (list.length > 0)
      ctx.warnings.push({ code: 'duplicate_step_status', detail: `${w.name}: ${s.name}` });
    list.push(s);
    stepsOfStatus.set(status, list);
  }
  const create = d.initialActions[0];
  const initial = create?.result?.step == null ? undefined : statusOfStep.get(create.result.step);
  if (!create || initial === undefined) return { fail: 'no_initial_status' };
  for (const extra of d.initialActions.slice(1)) {
    ctx.warnings.push({ code: 'initial_action_not_mapped', detail: label(w, extra) });
  }

  const transitions: Record<string, JsonValue>[] = [];
  const add = (a: WfAction, from: number[] | 'any') => {
    const where = label(w, a);
    const target = a.result?.step == null ? undefined : statusOfStep.get(a.result.step);
    if (target === undefined) {
      ctx.warnings.push({ code: 'transition_target_unknown', detail: where });
      return;
    }
    for (const r of a.conditionalResults) {
      const to = r.step === null ? '?' : ctx.statusName(statusOfStep.get(r.step) ?? '');
      ctx.warnings.push({ code: 'conditional_result_not_mapped', detail: `${where}: to ${to}` });
    }
    const guards = a.conditions ? guardOf(a.conditions, where, ctx) : null;
    const built = actionRules(a, where, ctx, false);
    const layout = layoutOf(a, where, ctx);
    const properties = Object.fromEntries(
      Object.entries(a.meta)
        .filter(([k]) => k !== META.description && k !== META.screen && k.length <= 255)
        .map(([k, v]) => [k, v.slice(0, 4000)]),
    );
    const description = a.meta[META.description]?.slice(0, 2000);
    transitions.push({
      id: a.id,
      name: (a.name.trim() || `Transition ${a.id}`).slice(0, 255),
      ...(description ? { description } : {}),
      from: from === 'any' ? 'any' : from,
      to: Number(target),
      ...(layout.length > 0 ? { layout } : {}),
      ...(guards ? { guards: guards as unknown as JsonValue } : {}),
      ...(built.checks.length > 0
        ? { checks: built.checks.slice(0, 50) as unknown as JsonValue }
        : {}),
      ...(built.effects.length > 0
        ? { effects: built.effects.slice(0, 50) as unknown as JsonValue }
        : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(built.event ? { event: built.event } : {}),
    });
  };
  for (const a of d.globalActions) add(a, 'any');
  for (const a of d.commonActions) {
    const from = [
      ...new Set(
        d.steps
          .filter((s) => s.commonActions.includes(a.id))
          .map((s) => Number(statusOfStep.get(s.id))),
      ),
    ];
    if (from.length === 0) {
      ctx.warnings.push({ code: 'unused_common_action', detail: label(w, a) });
      continue;
    }
    add(a, from);
  }
  for (const s of d.steps) for (const a of s.actions) add(a, [Number(statusOfStep.get(s.id))]);
  transitions.sort((a, b) => Number(a.id) - Number(b.id));

  const onCreate = actionRules(create, label(w, create), ctx, true);
  const statusPermissions: Record<string, JsonValue> = {};
  for (const s of d.steps) {
    const status = statusOfStep.get(s.id) as string;
    const p = statusPermissionsOf(s, status, ctx);
    if (p) {
      statusPermissions[status] = {
        ...((statusPermissions[status] as object) ?? {}),
        ...(p as object),
      };
    }
  }
  const definition: Record<string, JsonValue> = {
    initialStatusId: Number(initial),
    statuses: [...stepsOfStatus.keys()].map((statusId) => ({ statusId: Number(statusId) })),
    transitions: transitions as JsonValue,
    ...(onCreate.effects.length > 0 || onCreate.event
      ? {
          onCreate: {
            ...(onCreate.effects.length > 0
              ? { effects: onCreate.effects as unknown as JsonValue }
              : {}),
            ...(onCreate.event ? { event: onCreate.event } : {}),
          },
        }
      : {}),
    ...(Object.keys(statusPermissions).length > 0 ? { statusPermissions } : {}),
  };
  return {
    command: {
      kind: 'workflow',
      name: w.name.trim().slice(0, 255),
      description: w.description.slice(0, 2000),
      isDefault: false,
      definition,
    },
    warnings: unique(ctx.warnings),
  };
}

export function mapWorkflowMap(s: StagedWorkflowScheme): Mapped {
  if (s.mergedInto) {
    // Identical to an earlier scheme once their workflows merged: its tracks use that one.
    return {
      skip: 'merged_identical',
      warnings: [{ code: 'merged_into', detail: s.mergedInto.name }],
    };
  }
  return {
    command: {
      kind: 'workflow_map',
      name: s.name.trim().slice(0, 255),
      description: s.description,
      isDefault: false,
      defaultWorkflow: ref('workflow', s.defaultWorkflow),
      entries: s.entries.map((e) => ({
        type: ref('ticket_type', e.type),
        workflow: ref('workflow', e.workflow),
      })),
      tracks: s.tracks.map((t) => ref('track', t)),
    },
    warnings: unique(s.problems.map((p) => ({ code: p.code, detail: p.detail }))),
  };
}
