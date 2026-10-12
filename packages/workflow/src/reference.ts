import type {
  Assignment,
  ImportEntry,
  ImportExpectation,
  LintWarning,
  PublishChange,
  PublishExpectation,
} from './conformance/case';
import type { WorkflowEngine } from './conformance/run';
import {
  type Actor,
  type Channel,
  type CheckDef,
  type CompareOp,
  type EffectDef,
  ESSENTIAL_ORDER,
  type GuardNode,
  type HistoryEntry,
  type Principal,
  type RuleDef,
  type StatusPermissions,
  type TicketState,
  type TransitionDef,
  type TransitionRequest,
  type TransitionResult,
  type WorkflowDef,
} from './model';

/**
 * The reference model: an in-memory, storage-free implementation of the workflow behaviour in
 * spec 01a sections 3.1 to 3.6, used to execute the conformance suite before the engine exists
 * and, after M1-023, as the oracle the engine is compared with. It favours clarity over speed.
 *
 * Choices the spec leaves open (each has a `verify` note on its cases):
 * - History entries of one transition are recorded as: status, then the layout fields in
 *   layout order, then effect changes in list order, then the comment.
 * - "Has been in status X" excludes the current status unless the rule says to include it.
 * - A parent-status check blocks a ticket without a parent.
 */
export class ReferenceEngine implements WorkflowEngine {
  availableTransitions(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    channel: Channel,
  ): string[] {
    if (!statusAllows(workflow, ticket, actor, 'transition').allowed) return [];
    return workflow.transitions
      .filter((t) => leavesFrom(t, ticket.status))
      .filter((t) => !failingGuard(t.guards, { workflow, ticket, actor, channel }))
      .filter((t) => !failingRestriction(workflow.rules?.[t.id] ?? [], ticket, actor))
      .map((t) => t.id);
  }

  transition(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    request: TransitionRequest,
  ): TransitionResult {
    const channel = request.channel ?? 'ui';
    const transition = workflow.transitions.find((t) => t.id === request.transition);
    const blocked = (
      by: Extract<TransitionResult, { outcome: 'blocked' }>['by'],
      name: string,
      message?: string,
    ): TransitionResult => ({
      outcome: 'blocked',
      by,
      name,
      ...(message ? { message } : {}),
      ticket,
    });
    if (!transition) return blocked('unknown-transition', request.transition);
    if (!leavesFrom(transition, ticket.status)) return blocked('wrong-status', transition.id);
    const permission = statusAllows(workflow, ticket, actor, 'transition');
    if (!permission.allowed) return blocked('permission', 'transition', permission.reason);
    const guard = failingGuard(transition.guards, { workflow, ticket, actor, channel });
    if (guard) return blocked('guard', guard);
    const rules = workflow.rules?.[transition.id] ?? [];
    const restriction = failingRestriction(rules, ticket, actor);
    if (restriction) return blocked('rule', restriction);
    const entered = request.fields ?? {};
    for (const check of transition.checks ?? []) {
      const problem = checkProblem(check, ticket, entered, actor);
      if (problem) return blocked('check', check.type, check.message ?? problem);
    }
    for (const rule of rules) {
      if (
        rule.type === 'validate-permission' &&
        !(actor.permissions ?? []).includes(rule.permission)
      ) {
        return blocked('rule', rule.type, `needs the ${rule.permission} permission`);
      }
    }

    // Everything passed: the essential sequence runs, in its fixed order (section 3.4).
    const next = structuredClone(ticket);
    const now = request.now ?? new Date().toISOString();
    const by = actor.user;
    const added: HistoryEntry[] = [];
    const change = (field: string, from: unknown, to: unknown) => {
      if (deepEqual(from, to)) return;
      added.push({ field, from, to, by, transition: transition.id });
    };
    const setField = (field: string, value: unknown) => {
      if (field === 'close-reason') {
        change('close-reason', next.closeReason ?? null, value ?? null);
        setCloseReason(next, value as string | null, now);
      } else if (field === 'assignee') {
        change('assignee', next.assignee ?? null, value ?? null);
        next.assignee = (value as string | null) ?? null;
      } else {
        change(field, next.fields[field] ?? null, value ?? null);
        if (value === null || value === undefined) delete next.fields[field];
        else next.fields[field] = value;
      }
    };

    // 1. Set the status.
    change('status', ticket.status, transition.to);
    next.status = transition.to;
    // Layout values save atomically with the transition (WF-006).
    for (const field of transition.layout ?? []) {
      if (field in entered) setField(field, entered[field]);
    }
    // Optional effects and local-mode rules change the ticket before it is stored.
    const webhooks: string[] = [];
    for (const effect of transition.effects ?? []) {
      runEffect(effect, next, actor, setField, webhooks);
    }
    for (const rule of rules) runRule(rule, next, actor, setField);
    // 2. The comment, if entered.
    if (request.comment) {
      next.comments = [...(next.comments ?? []), { by, text: request.comment }];
      added.push({
        field: 'comment',
        from: null,
        to: request.comment,
        by,
        transition: transition.id,
      });
    }
    // 3. History and store, 4. index, 5. event; notifications only after all five.
    next.history = [...next.history, ...added];
    return {
      outcome: 'ok',
      ticket: next,
      order: [...ESSENTIAL_ORDER],
      event: transition.event ?? 'generic',
      webhooks,
      notificationsAfterSequence: true,
    };
  }

  create(
    workflow: WorkflowDef,
    actor: Actor,
    fields: Record<string, unknown>,
  ): { ticket: TicketState; event: string; webhooks: string[] } {
    const ticket: TicketState = {
      status: workflow.initial,
      requester: actor.user,
      assignee: null,
      closeReason: null,
      closedAt: null,
      fields: { ...fields },
      history: [
        { field: 'status', from: null, to: workflow.initial, by: actor.user, transition: 'create' },
      ],
    };
    const create = workflow.transitions.find((t) => t.id === 'create');
    const webhooks: string[] = [];
    if (create) {
      const setField = (field: string, value: unknown) => {
        if (field === 'assignee') ticket.assignee = (value as string | null) ?? null;
        else if (field === 'close-reason')
          setCloseReason(ticket, value as string | null, new Date().toISOString());
        else ticket.fields[field] = value;
      };
      for (const effect of create.effects ?? [])
        runEffect(effect, ticket, actor, setField, webhooks);
    }
    return { ticket, event: create?.event ?? 'generic', webhooks };
  }

  checkPermission(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    permission: keyof StatusPermissions,
  ): { allowed: boolean; reason?: string } {
    return statusAllows(workflow, ticket, actor, permission);
  }

  boardMove(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    column: string,
  ): { outcome: 'ok' | 'blocked'; ticket: TicketState } {
    const columns = workflow.board?.columns ?? [];
    if (!columns.includes(column)) return { outcome: 'blocked', ticket };
    const next = structuredClone(ticket);
    const last = columns[columns.length - 1];
    const now = new Date().toISOString();
    next.history = [
      ...next.history,
      { field: 'status', from: ticket.status, to: column, by: actor.user, transition: 'board' },
    ];
    next.status = column;
    if (column === last) setCloseReason(next, 'Completed', now);
    else if (ticket.status === last) setCloseReason(next, null, now);
    return { outcome: 'ok', ticket: next };
  }

  publish(input: {
    draft: WorkflowDef;
    versions: WorkflowDef[];
    assignments: Assignment[];
    change: PublishChange;
    tickets: TicketState[];
    mapping: Record<string, string>;
    actor?: Actor;
  }): PublishExpectation {
    const { change, tickets, mapping, versions, assignments, actor } = input;
    if (actor && !(actor.permissions ?? []).includes('administer-workflows')) {
      return { outcome: 'refused', reason: 'read-only' };
    }
    if (change.rollbackTo !== undefined) {
      if (change.rollbackTo < 1 || change.rollbackTo > versions.length) {
        return { outcome: 'refused', reason: 'unknown-version' };
      }
      return {
        outcome: 'published',
        version: versions.length + 1,
        impact: assignments,
        downtime: false,
      };
    }
    let moved = 0;
    const statuses = tickets.map((i) => i.status);
    if (change.removeStatus) {
      const stranded = tickets.filter((i) => i.status === change.removeStatus);
      if (stranded.length > 0 && !mapping[change.removeStatus]) {
        return { outcome: 'refused', reason: 'mapping-required' };
      }
      const target = mapping[change.removeStatus];
      if (target) {
        for (const [index, ticket] of tickets.entries()) {
          if (ticket.status !== change.removeStatus) continue;
          ticket.history.push({ field: 'status', from: ticket.status, to: target, by: 'system' });
          ticket.status = target;
          statuses[index] = target;
          moved++;
        }
      }
    }
    return {
      outcome: 'published',
      version: versions.length + 1,
      statuses,
      moved,
      impact: assignments,
      downtime: false,
    };
  }

  importFunctions(entries: ImportEntry[]): ImportExpectation {
    const mapped = entries.map((e) => JIRA_FUNCTION_MAP[e.jiraClass] ?? 'placeholder');
    const report = entries
      .filter((e) => !(e.jiraClass in JIRA_FUNCTION_MAP))
      .map((e) => e.jiraClass);
    return { mapped, report };
  }

  exportImport(workflow: WorkflowDef): WorkflowDef {
    return JSON.parse(JSON.stringify(workflow)) as WorkflowDef;
  }

  lint(workflow: WorkflowDef, boards: { id: string; columns: string[] }[]): LintWarning[] {
    const warnings: LintWarning[] = [];
    const ids = workflow.statuses.map((s) => s.id);
    const stage = new Map(workflow.statuses.map((s) => [s.id, s.stage]));
    for (const id of ids) {
      // Any card moves to any column on a board-managed workflow (section 3.6).
      if (workflow.board) break;
      const reachable =
        id === workflow.initial ||
        workflow.transitions.some(
          (t) => t.to === id && t.id !== 'create' && leavesSomewhereElse(t, id, ids),
        );
      if (!reachable) warnings.push({ kind: 'unreachable-status', at: id });
      const exits = workflow.transitions.some((t) => leavesFrom(t, id) && t.to !== id);
      if (!exits && stage.get(id) !== 'closed') warnings.push({ kind: 'no-exit', at: id });
    }
    for (const board of boards) {
      for (const id of ids) {
        if (!board.columns.includes(id))
          warnings.push({ kind: 'unmapped-on-board', at: `${board.id}:${id}` });
      }
    }
    for (const t of workflow.transitions) {
      if (t.guards && unsatisfiable(t.guards)) {
        warnings.push({ kind: 'unsatisfiable-guard', at: t.id });
      }
    }
    return warnings;
  }
}

// --- helpers ---------------------------------------------------------------------------------

function leavesFrom(t: TransitionDef, status: string): boolean {
  return t.from === 'any' || t.from.includes(status);
}

function leavesSomewhereElse(t: TransitionDef, target: string, all: string[]): boolean {
  if (t.from === 'any') return all.some((s) => s !== target);
  return t.from.some((s) => s !== target);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function setCloseReason(ticket: TicketState, value: string | null, now: string): void {
  ticket.closeReason = value;
  ticket.closedAt = value ? now : null;
}

function matchesPrincipal(actor: Actor, p: Principal): boolean {
  if ('role' in p) return (actor.roles ?? []).includes(p.role);
  return (actor.groups ?? []).includes(p.group);
}

function statusAllows(
  workflow: WorkflowDef,
  ticket: TicketState,
  actor: Actor,
  permission: keyof StatusPermissions,
): { allowed: boolean; reason?: string } {
  const allowed = workflow.statusPermissions?.[ticket.status]?.[permission];
  if (!allowed) return { allowed: true };
  if (allowed.some((p) => matchesPrincipal(actor, p))) return { allowed: true };
  const who = allowed.map((p) => ('role' in p ? `role ${p.role}` : `group ${p.group}`)).join(', ');
  return { allowed: false, reason: `in status ${ticket.status} only ${who} may ${permission}` };
}

interface Ctx {
  workflow: WorkflowDef;
  ticket: TicketState;
  actor: Actor;
  channel: Channel;
}

function compare(left: unknown, op: CompareOp, right: unknown): boolean {
  if (op === '=') return deepEqual(left, right);
  if (op === '!=') return !deepEqual(left, right);
  const l = Number(left);
  const r = Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (op) {
    case '>':
      return l > r;
    case '>=':
      return l >= r;
    case '<':
      return l < r;
    case '<=':
      return l <= r;
  }
}

/** Statuses the ticket has been in before the current one, oldest first. */
function pastStatuses(ticket: TicketState): string[] {
  const entries = ticket.history.filter((h) => h.field === 'status');
  const visited: string[] = [];
  for (const [i, h] of entries.entries()) {
    if (i === 0 && typeof h.from === 'string') visited.push(h.from);
    if (typeof h.to === 'string') visited.push(h.to);
  }
  // The last entry's target is the current status, which "has been in" excludes.
  if (visited.length > 0 && visited[visited.length - 1] === ticket.status) visited.pop();
  return visited;
}

function beenThrough(
  ticket: TicketState,
  status: string,
  mostRecentOnly: boolean | undefined,
): boolean {
  const past = pastStatuses(ticket);
  if (mostRecentOnly) return past[past.length - 1] === status;
  return past.includes(status);
}

function holdsUser(value: unknown, user: string): boolean {
  if (Array.isArray(value)) return value.includes(user);
  return value === user;
}

/** The type of the first guard that fails, or undefined when the tree passes. */
function failingGuard(node: GuardNode | undefined, ctx: Ctx): string | undefined {
  if (!node) return undefined;
  if ('all' in node) {
    for (const child of node.all) {
      const f = failingGuard(child, ctx);
      if (f) return f;
    }
    return undefined;
  }
  if ('any' in node) {
    if (node.any.length === 0) return undefined;
    let first: string | undefined;
    for (const child of node.any) {
      const f = failingGuard(child, ctx);
      if (!f) return undefined;
      first ??= f;
    }
    return first;
  }
  return guardHolds(node, ctx) ? undefined : node.type;
}

function guardHolds(
  node: Exclude<GuardNode, { all: unknown } | { any: unknown }>,
  ctx: Ctx,
): boolean {
  const { ticket, actor, channel } = ctx;
  const groups = actor.groups ?? [];
  const roles = actor.roles ?? [];
  switch (node.type) {
    case 'always-false':
      return false;
    case 'block-until-approval':
      return ticket.fields['approval-pending'] !== true;
    case 'compare-number': {
      const value = ticket.fields[node.field];
      if (value === undefined || value === null || value === '') return false;
      return compare(value, node.op, node.value);
    }
    case 'hide-from-user':
      return channel !== 'ui';
    case 'only-assignee':
      return ticket.assignee === actor.user;
    case 'only-requester':
      return ticket.requester === actor.user;
    case 'permission':
      return (actor.permissions ?? []).includes(node.permission);
    case 'previous-status':
      return beenThrough(ticket, node.status, node.mostRecentOnly);
    case 'separation-of-duties':
      return !ticket.history.some((h) => h.transition === node.transition && h.by === actor.user);
    case 'subticket-blocking':
      return (ticket.subtickets ?? []).every((s) => node.statuses.includes(s.status));
    case 'user-in-group':
      return groups.includes(node.group);
    case 'user-in-any-group':
      return node.groups.some((g) => groups.includes(g));
    case 'user-in-role':
      return roles.includes(node.role);
    case 'user-in-any-role':
      return node.roles.some((r) => roles.includes(r));
    case 'user-in-field':
      return holdsUser(ticket.fields[node.field], actor.user);
    case 'user-in-group-field': {
      const value = ticket.fields[node.field];
      const held = Array.isArray(value) ? value : value === undefined ? [] : [value];
      return held.some((g) => groups.includes(g as string));
    }
    case 'value-field':
      return compare(ticket.fields[node.field], node.op, node.value);
  }
}

/** The type of the first local-mode restriction that fails. */
function failingRestriction(
  rules: RuleDef[],
  ticket: TicketState,
  actor: Actor,
): string | undefined {
  for (const rule of rules) {
    switch (rule.type) {
      case 'restrict-field-value':
        if (!deepEqual(ticket.fields[rule.field], rule.value)) return rule.type;
        break;
      case 'restrict-been-through': {
        let past = pastStatuses(ticket);
        if (rule.ignoreLoops) past = past.filter((s, i) => past.indexOf(s) === i);
        if (rule.includeCurrent) past = [...past, ticket.status];
        const seen = rule.mostRecentOnly
          ? past[past.length - 1] === rule.status
          : past.includes(rule.status);
        if (seen === Boolean(rule.reverse)) return rule.type;
        break;
      }
      case 'restrict-who': {
        const ok =
          (rule.users ?? []).includes(actor.user) ||
          (rule.groups ?? []).some((g) => (actor.groups ?? []).includes(g)) ||
          (rule.roles ?? []).some((r) => (actor.roles ?? []).includes(r));
        if (!ok) return rule.type;
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

const dateOnly = (value: unknown) => String(value ?? '').slice(0, 10);

/** A check's default message when it blocks, or undefined when it passes. */
function checkProblem(
  v: CheckDef,
  ticket: TicketState,
  entered: Record<string, unknown>,
  actor: Actor,
): string | undefined {
  const merged = { ...ticket.fields, ...entered };
  const value = (field: string) =>
    field === 'assignee' ? (field in entered ? entered.assignee : ticket.assignee) : merged[field];
  const empty = (x: unknown) =>
    x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);
  switch (v.type) {
    case 'field-required':
      return empty(value(v.field)) ? `${v.field} is required` : undefined;
    case 'field-modified':
      return v.field in entered && !deepEqual(entered[v.field], ticket.fields[v.field])
        ? undefined
        : `${v.field} must be changed`;
    case 'field-single-value': {
      const x = value(v.field);
      return Array.isArray(x) && x.length > 1 ? `${v.field} takes one value` : undefined;
    }
    case 'date-compare': {
      const a = value(v.field);
      const b = value(v.other);
      if (empty(a) || empty(b)) return `${v.field} and ${v.other} must both be set`;
      const left = v.includeTime ? Date.parse(String(a)) : Date.parse(dateOnly(a));
      const right = v.includeTime ? Date.parse(String(b)) : Date.parse(dateOnly(b));
      return compare(left, v.op, right) ? undefined : `${v.field} must be ${v.op} ${v.other}`;
    }
    case 'date-window': {
      const a = value(v.field);
      const b = value(v.other);
      if (empty(a) || empty(b)) return `${v.field} and ${v.other} must both be set`;
      const days = Math.abs(Date.parse(dateOnly(a)) - Date.parse(dateOnly(b))) / 86_400_000;
      return days <= v.days ? undefined : `${v.field} must be within ${v.days} days of ${v.other}`;
    }
    case 'regex':
      return new RegExp(v.pattern).test(String(value(v.field) ?? ''))
        ? undefined
        : `${v.field} does not match ${v.pattern}`;
    case 'forms-attached':
      return (ticket.forms ?? []).length > 0 ? undefined : 'a form must be attached';
    case 'forms-submitted':
      return (ticket.forms ?? []).length > 0 && (ticket.forms ?? []).every((f) => f.submitted)
        ? undefined
        : 'every form must be submitted';
    case 'parent-status':
      return ticket.parent && v.statuses.includes(ticket.parent.status)
        ? undefined
        : `the parent must be in ${v.statuses.join(' or ')}`;
    case 'permission':
      return (actor.permissions ?? []).includes(v.permission)
        ? undefined
        : `needs the ${v.permission} permission`;
    case 'previous-state':
      return beenThrough(ticket, v.status, v.mostRecentOnly)
        ? undefined
        : `the ticket must have been in ${v.status}`;
  }
}

function runEffect(
  effect: EffectDef,
  ticket: TicketState,
  actor: Actor,
  setField: (field: string, value: unknown) => void,
  webhooks: string[],
): void {
  switch (effect.type) {
    case 'assign-to-current-user':
      setField('assignee', actor.user);
      break;
    case 'assign-to-owner':
      setField('assignee', ticket.areaOwner ?? ticket.trackOwner ?? null);
      break;
    case 'assign-to-requester':
      setField('assignee', ticket.requester ?? null);
      break;
    case 'clear-field':
      setField(effect.field, null);
      break;
    case 'copy-field': {
      const source = effect.fromParent
        ? ticket.parent?.fields?.[effect.from]
        : ticket.fields[effect.from];
      if (source !== undefined) setField(effect.to, source);
      break;
    }
    case 'set-visibility-level-from-role': {
      const role = (actor.roles ?? []).find((r) => r in effect.levels);
      if (role) ticket.visibilityLevel = effect.levels[role] ?? null;
      break;
    }
    case 'webhook':
      webhooks.push(effect.url);
      break;
    case 'update-field':
      setField(effect.field, effect.value);
      break;
    case 'update-system-field':
      setField(effect.field, effect.value);
      break;
    case 'placeholder':
      // Disabled until an admin replaces it (WF-011).
      break;
  }
}

function runRule(
  rule: RuleDef,
  ticket: TicketState,
  actor: Actor,
  setField: (field: string, value: unknown) => void,
): void {
  switch (rule.type) {
    case 'assign':
      setField(
        'assignee',
        rule.to === 'current-user'
          ? actor.user
          : rule.to === 'requester'
            ? (ticket.requester ?? null)
            : rule.to.user,
      );
      break;
    case 'copy-field':
      if (ticket.fields[rule.from] !== undefined) setField(rule.to, ticket.fields[rule.from]);
      break;
    case 'update-field':
      setField(rule.field, rule.value);
      break;
    default:
      break;
  }
}

/** True when no actor and no ticket can satisfy the tree (WF-012). */
function unsatisfiable(node: GuardNode): boolean {
  if ('all' in node) {
    if (node.all.some(unsatisfiable)) return true;
    // Contradictory number bounds on one field.
    const bounds = node.all.filter(
      (c): c is Extract<GuardNode, { type: 'compare-number' }> =>
        'type' in c && c.type === 'compare-number',
    );
    for (const a of bounds) {
      for (const b of bounds) {
        if (a.field !== b.field) continue;
        const lower =
          a.op === '>'
            ? a.value + 1e-9
            : a.op === '>='
              ? a.value
              : a.op === '='
                ? a.value
                : undefined;
        const upper =
          b.op === '<'
            ? b.value - 1e-9
            : b.op === '<='
              ? b.value
              : b.op === '='
                ? b.value
                : undefined;
        if (lower !== undefined && upper !== undefined && lower > upper) return true;
      }
    }
    return false;
  }
  if ('any' in node) return node.any.length > 0 && node.any.every(unsatisfiable);
  return node.type === 'always-false';
}

/**
 * Jira workflow definitions name conditions, validators and post functions by class; they import
 * as guards, checks and effects. The entries here are the ones the public workflow format shows;
 * anything else imports as a disabled placeholder listed in the import report (WF-011).
 * Jira's essential post functions map to 'essential' because every transition already has the
 * essential effects.
 *
 * verify: confirm the class names against a Jira workflow export before the importer (M1) ships;
 * names not listed here (previous status, value field, compare number, date validators, field
 * required, clear field, copy field, webhook) are expected to come from the public export too.
 */
export const JIRA_FUNCTION_MAP: Readonly<Record<string, string>> = {
  'com.atlassian.jira.workflow.condition.AllowOnlyAssignee': 'only-assignee',
  'com.atlassian.jira.workflow.condition.AllowOnlyReporter': 'only-requester',
  'com.atlassian.jira.workflow.condition.AlwaysFalseCondition': 'always-false',
  'com.atlassian.jira.workflow.condition.PermissionCondition': 'permission',
  'com.atlassian.jira.workflow.condition.SubTaskBlockingCondition': 'subticket-blocking',
  'com.atlassian.jira.workflow.condition.UserInGroupCondition': 'user-in-group',
  'com.atlassian.jira.workflow.condition.InGroupCFCondition': 'user-in-group-field',
  'com.atlassian.jira.workflow.condition.InProjectRoleCondition': 'user-in-role',
  'com.atlassian.jira.workflow.condition.InAnyProjectRoleCondition': 'user-in-any-role',
  'com.atlassian.jira.workflow.condition.UserIsInCustomFieldCondition': 'user-in-field',
  'com.atlassian.jira.workflow.validator.PermissionValidator': 'permission',
  'com.atlassian.jira.workflow.validator.UserPermissionValidator': 'permission',
  'com.atlassian.jira.workflow.function.issue.AssignToCurrentUserFunction':
    'assign-to-current-user',
  'com.atlassian.jira.workflow.function.issue.AssignToLeadFunction': 'assign-to-owner',
  'com.atlassian.jira.workflow.function.issue.AssignToReporterFunction': 'assign-to-requester',
  'com.atlassian.jira.workflow.function.issue.UpdateIssueFieldFunction': 'update-system-field',
  'com.atlassian.jira.workflow.function.issue.SetIssueSecurityFromRoleFunction':
    'set-visibility-level-from-role',
  'com.atlassian.jira.workflow.function.issue.UpdateIssueStatusFunction': 'essential',
  'com.atlassian.jira.workflow.function.misc.CreateCommentFunction': 'essential',
  'com.atlassian.jira.workflow.function.issue.GenerateChangeHistoryFunction': 'essential',
  'com.atlassian.jira.workflow.function.issue.IssueStoreFunction': 'essential',
  'com.atlassian.jira.workflow.function.issue.IssueReindexFunction': 'essential',
  'com.atlassian.jira.workflow.function.event.FireIssueEventFunction': 'essential',
  'com.atlassian.jira.workflow.function.issue.IssueCreateFunction': 'essential',
};
