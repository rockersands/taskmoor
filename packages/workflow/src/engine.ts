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
  type Stage,
  type StatusPermissions,
  type TicketState,
  type TransitionBlocked,
  type TransitionDef,
  type TransitionRequest,
  type TransitionResult,
  type WorkflowDef,
} from './model';
import { JIRA_FUNCTION_MAP } from './reference';

/**
 * The workflow engine (M1-024 to M1-027; WF-001 to WF-012; spec 01a sections 3.1 to 3.6): the
 * behaviour the server runs for every transition. It is pure (no storage, no clock unless the
 * caller gives none), so the conformance suite runs on it directly and the server only maps
 * rows onto `WorkflowDef`, `TicketState` and `Actor` and stores the result.
 *
 * It is written apart from the reference model (`reference.ts`), which stays the oracle: the
 * same suite runs on both and a property test compares their guard verdicts. Where they
 * differ is in how the work is done: a workflow is compiled once (transitions indexed by id
 * and by source status), and what a decision needs from the ticket (the statuses it has been
 * in, the actor's groups and roles) is computed once per call and only when asked for.
 *
 * Behaviour the spec leaves open follows the reference, so both pass the same cases:
 * - a transition's history is the status, then layout fields in layout order, then effect and
 *   rule changes in list order, then the comment;
 * - "has been in" a status excludes the current one unless a rule asks to include it;
 * - a parent-status check blocks a ticket without a parent.
 */

interface Compiled {
  byId: ReadonlyMap<string, TransitionDef>;
  /** Transitions offered from a status, in definition order; filled as statuses are asked. */
  offered: Map<string, TransitionDef[]>;
  stages: ReadonlyMap<string, Stage>;
}

const compiledCache = new WeakMap<WorkflowDef, Compiled>();

function compiled(workflow: WorkflowDef): Compiled {
  let c = compiledCache.get(workflow);
  if (!c) {
    c = {
      byId: new Map(workflow.transitions.map((t) => [t.id, t])),
      offered: new Map(),
      stages: new Map(workflow.statuses.map((s) => [s.id, s.stage])),
    };
    compiledCache.set(workflow, c);
  }
  return c;
}

/** A transition is offered from a status it lists, or from every status when global. */
const startsFrom = (t: TransitionDef, status: string) =>
  t.from === 'any' || t.from.includes(status);

function offeredFrom(workflow: WorkflowDef, status: string): TransitionDef[] {
  const c = compiled(workflow);
  let list = c.offered.get(status);
  if (!list) {
    list = workflow.transitions.filter((t) => startsFrom(t, status));
    c.offered.set(status, list);
  }
  return list;
}

/** Values compare by content: the same JSON is the same value; missing reads as null. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isEmpty = (x: unknown) =>
  x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);

function compare(left: unknown, op: CompareOp, right: unknown): boolean {
  if (op === '=') return same(left, right);
  if (op === '!=') return !same(left, right);
  const l = Number(left);
  const r = Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  return op === '>' ? l > r : op === '>=' ? l >= r : op === '<' ? l < r : l <= r;
}

const day = (value: unknown) => Date.parse(String(value ?? '').slice(0, 10));

/** What one decision reads, each part computed at most once. */
class Situation {
  private visited: string[] | undefined;
  readonly groups: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly permissions: ReadonlySet<string>;

  constructor(
    readonly workflow: WorkflowDef,
    readonly ticket: TicketState,
    readonly actor: Actor,
    readonly channel: Channel,
  ) {
    this.groups = new Set(actor.groups ?? []);
    this.roles = new Set(actor.roles ?? []);
    this.permissions = new Set(actor.permissions ?? []);
  }

  /** The statuses the ticket was in before its current one, oldest first. */
  pastStatuses(): readonly string[] {
    if (!this.visited) {
      const moves = this.ticket.history.filter((h) => h.field === 'status');
      const visited: string[] = [];
      moves.forEach((h, i) => {
        if (i === 0 && typeof h.from === 'string') visited.push(h.from);
        if (typeof h.to === 'string') visited.push(h.to);
      });
      if (visited.at(-1) === this.ticket.status) visited.pop();
      this.visited = visited;
    }
    return this.visited;
  }

  hasBeenIn(status: string, mostRecentOnly = false): boolean {
    const past = this.pastStatuses();
    return mostRecentOnly ? past.at(-1) === status : past.includes(status);
  }

  holds(p: Principal): boolean {
    return 'role' in p ? this.roles.has(p.role) : this.groups.has(p.group);
  }
}

/** Whether a principal list allows the actor in the ticket's status (WF-007). */
function statusPermission(
  s: Situation,
  permission: keyof StatusPermissions,
): { allowed: boolean; reason?: string } {
  const allowed = s.workflow.statusPermissions?.[s.ticket.status]?.[permission];
  if (!allowed || allowed.some((p) => s.holds(p))) return { allowed: true };
  const who = allowed.map((p) => ('role' in p ? `role ${p.role}` : `group ${p.group}`)).join(', ');
  return {
    allowed: false,
    reason: `in status ${s.ticket.status} only ${who} may ${permission}`,
  };
}

type Leaf = Exclude<GuardNode, { all: unknown } | { any: unknown }>;

function leafHolds(g: Leaf, s: Situation): boolean {
  const { ticket, actor } = s;
  switch (g.type) {
    case 'always-false':
      return false;
    case 'block-until-approval':
      return ticket.fields['approval-pending'] !== true;
    case 'compare-number': {
      const value = ticket.fields[g.field];
      return value !== undefined && value !== null && value !== '' && compare(value, g.op, g.value);
    }
    case 'hide-from-user':
      return s.channel !== 'ui';
    case 'only-assignee':
      return ticket.assignee === actor.user;
    case 'only-requester':
      return ticket.requester === actor.user;
    case 'permission':
      return s.permissions.has(g.permission);
    case 'previous-status':
      return s.hasBeenIn(g.status, g.mostRecentOnly);
    case 'separation-of-duties':
      return !ticket.history.some((h) => h.transition === g.transition && h.by === actor.user);
    case 'subticket-blocking':
      return (ticket.subtickets ?? []).every((t) => g.statuses.includes(t.status));
    case 'user-in-group':
      return s.groups.has(g.group);
    case 'user-in-any-group':
      return g.groups.some((x) => s.groups.has(x));
    case 'user-in-role':
      return s.roles.has(g.role);
    case 'user-in-any-role':
      return g.roles.some((x) => s.roles.has(x));
    case 'user-in-field': {
      const value = ticket.fields[g.field];
      return Array.isArray(value) ? value.includes(actor.user) : value === actor.user;
    }
    case 'user-in-group-field': {
      const value = ticket.fields[g.field];
      const groups = Array.isArray(value) ? value : value === undefined ? [] : [value];
      return groups.some((x) => s.groups.has(x as string));
    }
    case 'value-field':
      return compare(ticket.fields[g.field], g.op, g.value);
  }
}

/**
 * The guard that refuses, named by its type, or undefined when the tree allows (WF-003). An
 * `all` group refuses with its first refusing member; an `any` group allows when one member
 * allows (an empty one allows) and otherwise refuses with its first member's reason.
 */
function refusingGuard(node: GuardNode | undefined, s: Situation): string | undefined {
  if (!node) return undefined;
  if ('all' in node) {
    for (const child of node.all) {
      const refused = refusingGuard(child, s);
      if (refused) return refused;
    }
    return undefined;
  }
  if ('any' in node) {
    let first: string | undefined;
    for (const child of node.any) {
      const refused = refusingGuard(child, s);
      if (!refused) return undefined;
      first ??= refused;
    }
    return first;
  }
  return leafHolds(node, s) ? undefined : node.type;
}

/** The local-mode restriction that refuses (WF-009), or undefined. */
function refusingRule(rules: readonly RuleDef[], s: Situation): string | undefined {
  for (const rule of rules) {
    if (rule.type === 'restrict-field-value') {
      if (!same(s.ticket.fields[rule.field], rule.value)) return rule.type;
    } else if (rule.type === 'restrict-been-through') {
      let past = [...s.pastStatuses()];
      if (rule.ignoreLoops) past = [...new Set(past)];
      if (rule.includeCurrent) past.push(s.ticket.status);
      const seen = rule.mostRecentOnly ? past.at(-1) === rule.status : past.includes(rule.status);
      if (seen === Boolean(rule.reverse)) return rule.type;
    } else if (rule.type === 'restrict-who') {
      const allowed =
        (rule.users ?? []).includes(s.actor.user) ||
        (rule.groups ?? []).some((g) => s.groups.has(g)) ||
        (rule.roles ?? []).some((r) => s.roles.has(r));
      if (!allowed) return rule.type;
    }
  }
  return undefined;
}

/** Why a check refuses, as its default message, or undefined when it passes (WF-004). */
function checkRefusal(
  check: CheckDef,
  s: Situation,
  entered: Readonly<Record<string, unknown>>,
): string | undefined {
  const { ticket } = s;
  const read = (field: string): unknown => {
    if (field in entered) return entered[field];
    return field === 'assignee' ? ticket.assignee : ticket.fields[field];
  };
  switch (check.type) {
    case 'field-required':
      return isEmpty(read(check.field)) ? `${check.field} is required` : undefined;
    case 'field-modified':
      return check.field in entered && !same(entered[check.field], ticket.fields[check.field])
        ? undefined
        : `${check.field} must be changed`;
    case 'field-single-value': {
      const value = read(check.field);
      return Array.isArray(value) && value.length > 1
        ? `${check.field} takes one value`
        : undefined;
    }
    case 'date-compare': {
      const a = read(check.field);
      const b = read(check.other);
      if (isEmpty(a) || isEmpty(b)) return `${check.field} and ${check.other} must both be set`;
      const [left, right] = check.includeTime
        ? [Date.parse(String(a)), Date.parse(String(b))]
        : [day(a), day(b)];
      return compare(left, check.op, right)
        ? undefined
        : `${check.field} must be ${check.op} ${check.other}`;
    }
    case 'date-window': {
      const a = read(check.field);
      const b = read(check.other);
      if (isEmpty(a) || isEmpty(b)) return `${check.field} and ${check.other} must both be set`;
      return Math.abs(day(a) - day(b)) / 86_400_000 <= check.days
        ? undefined
        : `${check.field} must be within ${check.days} days of ${check.other}`;
    }
    case 'regex':
      return new RegExp(check.pattern).test(String(read(check.field) ?? ''))
        ? undefined
        : `${check.field} does not match ${check.pattern}`;
    case 'forms-attached':
      return (ticket.forms ?? []).length > 0 ? undefined : 'a form must be attached';
    case 'forms-submitted': {
      const forms = ticket.forms ?? [];
      return forms.length > 0 && forms.every((f) => f.submitted)
        ? undefined
        : 'every form must be submitted';
    }
    case 'parent-status':
      return ticket.parent && check.statuses.includes(ticket.parent.status)
        ? undefined
        : `the parent must be in ${check.statuses.join(' or ')}`;
    case 'permission':
      return s.permissions.has(check.permission)
        ? undefined
        : `needs the ${check.permission} permission`;
    case 'previous-state':
      return s.hasBeenIn(check.status, check.mostRecentOnly)
        ? undefined
        : `the ticket must have been in ${check.status}`;
  }
}

/**
 * The changes one transition makes to a copy of the ticket, recorded in order for the history
 * (essential effect 3).
 */
class Changes {
  readonly ticket: TicketState;
  readonly added: HistoryEntry[] = [];
  readonly webhooks: string[] = [];

  constructor(
    original: TicketState,
    private readonly by: string,
    private readonly now: string,
    private readonly transition: string | undefined,
  ) {
    this.ticket = structuredClone(original);
  }

  private record(field: string, from: unknown, to: unknown) {
    if (same(from, to)) return;
    this.added.push({
      field,
      from,
      to,
      by: this.by,
      ...(this.transition !== undefined ? { transition: this.transition } : {}),
    });
  }

  status(to: string) {
    this.record('status', this.ticket.status, to);
    this.ticket.status = to;
  }

  /** Sets a field; the close reason also sets or clears the Closed stamp (WF-008). */
  set(field: string, value: unknown) {
    const t = this.ticket;
    if (field === 'close-reason') {
      this.record(field, t.closeReason ?? null, value ?? null);
      t.closeReason = (value as string | null | undefined) ?? null;
      t.closedAt = t.closeReason ? this.now : null;
    } else if (field === 'assignee') {
      this.record(field, t.assignee ?? null, value ?? null);
      t.assignee = (value as string | null | undefined) ?? null;
    } else {
      this.record(field, t.fields[field] ?? null, value ?? null);
      if (value === null || value === undefined) delete t.fields[field];
      else t.fields[field] = value;
    }
  }

  comment(text: string) {
    this.ticket.comments = [...(this.ticket.comments ?? []), { by: this.by, text }];
    this.added.push({
      field: 'comment',
      from: null,
      to: text,
      by: this.by,
      ...(this.transition !== undefined ? { transition: this.transition } : {}),
    });
  }
}

/** An optional effect (WF-005); runs on the copy, in list order. */
function runEffect(effect: EffectDef, c: Changes, actor: Actor, original: TicketState) {
  const t = c.ticket;
  switch (effect.type) {
    case 'assign-to-current-user':
      return c.set('assignee', actor.user);
    case 'assign-to-owner':
      return c.set('assignee', t.areaOwner ?? t.trackOwner ?? null);
    case 'assign-to-requester':
      return c.set('assignee', t.requester ?? null);
    case 'clear-field':
      return c.set(effect.field, null);
    case 'copy-field': {
      const source = effect.fromParent
        ? original.parent?.fields?.[effect.from]
        : t.fields[effect.from];
      if (source !== undefined) c.set(effect.to, source);
      return;
    }
    case 'set-visibility-level-from-role': {
      const role = (actor.roles ?? []).find((r) => r in effect.levels);
      if (role) t.visibilityLevel = effect.levels[role] ?? null;
      return;
    }
    case 'webhook':
      c.webhooks.push(effect.url);
      return;
    case 'update-field':
    case 'update-system-field':
      return c.set(effect.field, effect.value);
    case 'placeholder':
      // Imported but not mapped: disabled until an administrator replaces it (WF-011).
      return;
  }
}

/** A local-mode rule that changes the ticket (WF-009). */
function runRule(rule: RuleDef, c: Changes, actor: Actor) {
  const t = c.ticket;
  if (rule.type === 'assign') {
    c.set(
      'assignee',
      rule.to === 'current-user'
        ? actor.user
        : rule.to === 'requester'
          ? (t.requester ?? null)
          : rule.to.user,
    );
  } else if (rule.type === 'copy-field') {
    if (t.fields[rule.from] !== undefined) c.set(rule.to, t.fields[rule.from]);
  } else if (rule.type === 'update-field') {
    c.set(rule.field, rule.value);
  }
}

/** True when no actor and no ticket can satisfy a guard tree (WF-012). */
function neverHolds(node: GuardNode): boolean {
  if ('any' in node) return node.any.length > 0 && node.any.every(neverHolds);
  if ('all' in node) {
    if (node.all.some(neverHolds)) return true;
    // Bounds on one number field that no value meets, such as > 5 and < 3.
    type Bound = Extract<GuardNode, { type: 'compare-number' }>;
    const bounds = node.all.filter((g): g is Bound => 'type' in g && g.type === 'compare-number');
    const lowest = (b: Bound) =>
      b.op === '>' ? b.value + 1e-9 : b.op === '>=' || b.op === '=' ? b.value : undefined;
    const highest = (b: Bound) =>
      b.op === '<' ? b.value - 1e-9 : b.op === '<=' || b.op === '=' ? b.value : undefined;
    return bounds.some((a) =>
      bounds.some((b) => {
        if (a.field !== b.field) return false;
        const low = lowest(a);
        const high = highest(b);
        return low !== undefined && high !== undefined && low > high;
      }),
    );
  }
  return node.type === 'always-false';
}

export class WorkflowEngineImpl implements WorkflowEngine {
  availableTransitions(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    channel: Channel,
  ): string[] {
    const s = new Situation(workflow, ticket, actor, channel);
    if (!statusPermission(s, 'transition').allowed) return [];
    return offeredFrom(workflow, ticket.status)
      .filter((t) => !refusingGuard(t.guards, s) && !refusingRule(workflow.rules?.[t.id] ?? [], s))
      .map((t) => t.id);
  }

  transition(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    request: TransitionRequest,
  ): TransitionResult {
    const s = new Situation(workflow, ticket, actor, request.channel ?? 'ui');
    const refuse = (by: TransitionBlocked['by'], name: string, message?: string) =>
      ({
        outcome: 'blocked',
        by,
        name,
        ...(message !== undefined ? { message } : {}),
        ticket,
      }) satisfies TransitionBlocked;

    const transition = compiled(workflow).byId.get(request.transition);
    if (!transition) return refuse('unknown-transition', request.transition);
    if (!startsFrom(transition, ticket.status)) return refuse('wrong-status', transition.id);
    const permission = statusPermission(s, 'transition');
    if (!permission.allowed) return refuse('permission', 'transition', permission.reason);
    const guard = refusingGuard(transition.guards, s);
    if (guard) return refuse('guard', guard);
    const rules = workflow.rules?.[transition.id] ?? [];
    const rule = refusingRule(rules, s);
    if (rule) return refuse('rule', rule);
    const entered = request.fields ?? {};
    for (const check of transition.checks ?? []) {
      const problem = checkRefusal(check, s, entered);
      if (problem) return refuse('check', check.type, check.message ?? problem);
    }
    const needed = rules.find(
      (r): r is Extract<RuleDef, { type: 'validate-permission' }> =>
        r.type === 'validate-permission' && !s.permissions.has(r.permission),
    );
    if (needed) {
      return refuse('rule', needed.type, `needs the ${needed.permission} permission`);
    }

    // Nothing refused: the essential sequence runs in its fixed order (section 3.4).
    const c = new Changes(
      ticket,
      actor.user,
      request.now ?? new Date().toISOString(),
      transition.id,
    );
    // 1. The status, with what the layout entered (WF-006: saved with the transition).
    c.status(transition.to);
    for (const field of transition.layout ?? []) {
      if (field in entered) c.set(field, entered[field]);
    }
    for (const effect of transition.effects ?? []) runEffect(effect, c, actor, ticket);
    for (const r of rules) runRule(r, c, actor);
    // 2. The comment, if one was entered.
    if (request.comment) c.comment(request.comment);
    // 3. History and store, 4. index, 5. event; notifications only after all five.
    c.ticket.history = [...c.ticket.history, ...c.added];
    return {
      outcome: 'ok',
      ticket: c.ticket,
      order: [...ESSENTIAL_ORDER],
      event: transition.event ?? 'generic',
      webhooks: c.webhooks,
      notificationsAfterSequence: true,
    };
  }

  /** A new ticket in the initial status, with the create transition's effects (WF-005 (3)). */
  create(
    workflow: WorkflowDef,
    actor: Actor,
    fields: Record<string, unknown>,
  ): { ticket: TicketState; event: string; webhooks: string[] } {
    const start: TicketState = {
      status: workflow.initial,
      requester: actor.user,
      assignee: null,
      closeReason: null,
      closedAt: null,
      fields: { ...fields },
      history: [],
    };
    const create = compiled(workflow).byId.get('create');
    const c = new Changes(start, actor.user, new Date().toISOString(), undefined);
    for (const effect of create?.effects ?? []) runEffect(effect, c, actor, start);
    // A creation's history is its initial status; the values it starts with are its own.
    c.ticket.history = [
      { field: 'status', from: null, to: workflow.initial, by: actor.user, transition: 'create' },
    ];
    return { ticket: c.ticket, event: create?.event ?? 'generic', webhooks: c.webhooks };
  }

  checkPermission(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    permission: keyof StatusPermissions,
  ): { allowed: boolean; reason?: string } {
    return statusPermission(new Situation(workflow, ticket, actor, 'ui'), permission);
  }

  /**
   * A board-managed workflow (WF-010): any card to any column; the rightmost column closes it
   * as Completed and leaving it clears the close reason.
   */
  boardMove(
    workflow: WorkflowDef,
    ticket: TicketState,
    actor: Actor,
    column: string,
  ): { outcome: 'ok' | 'blocked'; ticket: TicketState } {
    const columns = workflow.board?.columns ?? [];
    if (!columns.includes(column)) return { outcome: 'blocked', ticket };
    const c = new Changes(ticket, actor.user, new Date().toISOString(), 'board');
    const last = columns.at(-1);
    c.ticket.history = [
      ...c.ticket.history,
      { field: 'status', from: ticket.status, to: column, by: actor.user, transition: 'board' },
    ];
    c.ticket.status = column;
    if (column === last) {
      c.ticket.closeReason = 'Completed';
      c.ticket.closedAt = new Date().toISOString();
    } else if (ticket.status === last) {
      c.ticket.closeReason = null;
      c.ticket.closedAt = null;
    }
    return { outcome: 'ok', ticket: c.ticket };
  }

  /**
   * What publishing a draft does (WF-002): refused for read-only actors or an unknown version;
   * a status the draft removes takes its tickets to the mapped status or the publish waits.
   */
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
    const version = versions.length + 1;
    if (change.rollbackTo !== undefined) {
      return change.rollbackTo >= 1 && change.rollbackTo <= versions.length
        ? { outcome: 'published', version, impact: assignments, downtime: false }
        : { outcome: 'refused', reason: 'unknown-version' };
    }
    const removed = change.removeStatus;
    const target = removed === undefined ? undefined : mapping[removed];
    if (removed !== undefined && !target && tickets.some((t) => t.status === removed)) {
      return { outcome: 'refused', reason: 'mapping-required' };
    }
    let moved = 0;
    const statuses = tickets.map((t) => {
      if (removed === undefined || !target || t.status !== removed) return t.status;
      t.history.push({ field: 'status', from: t.status, to: target, by: 'system' });
      t.status = target;
      moved++;
      return target;
    });
    return { outcome: 'published', version, statuses, moved, impact: assignments, downtime: false };
  }

  /** Imported Jira functions as guards, checks and effects; the rest as placeholders (WF-011). */
  importFunctions(entries: ImportEntry[]): ImportExpectation {
    const known = (e: ImportEntry) => Object.hasOwn(JIRA_FUNCTION_MAP, e.jiraClass);
    return {
      mapped: entries.map((e) =>
        known(e) ? (JIRA_FUNCTION_MAP[e.jiraClass] as string) : 'placeholder',
      ),
      report: entries.filter((e) => !known(e)).map((e) => e.jiraClass),
    };
  }

  /** Export and import are the definition as JSON; nothing is lost on the way (WF-011). */
  exportImport(workflow: WorkflowDef): WorkflowDef {
    return JSON.parse(JSON.stringify(workflow)) as WorkflowDef;
  }

  /** Warnings the editor shows before publishing (WF-012). */
  lint(workflow: WorkflowDef, boards: { id: string; columns: string[] }[]): LintWarning[] {
    const warnings: LintWarning[] = [];
    const ids = workflow.statuses.map((s) => s.id);
    const stages = compiled(workflow).stages;
    // Any card goes to any column on a board-managed workflow (section 3.6): nothing is stuck.
    if (!workflow.board) {
      for (const id of ids) {
        const entered =
          id === workflow.initial ||
          workflow.transitions.some(
            (t) =>
              t.to === id &&
              t.id !== 'create' &&
              (t.from === 'any' ? ids.some((x) => x !== id) : t.from.some((x) => x !== id)),
          );
        if (!entered) warnings.push({ kind: 'unreachable-status', at: id });
        const leaves = workflow.transitions.some((t) => startsFrom(t, id) && t.to !== id);
        if (!leaves && stages.get(id) !== 'closed') warnings.push({ kind: 'no-exit', at: id });
      }
    }
    for (const board of boards) {
      for (const id of ids) {
        if (!board.columns.includes(id)) {
          warnings.push({ kind: 'unmapped-on-board', at: `${board.id}:${id}` });
        }
      }
    }
    for (const t of workflow.transitions) {
      if (t.guards && neverHolds(t.guards)) {
        warnings.push({ kind: 'unsatisfiable-guard', at: t.id });
      }
    }
    return warnings;
  }
}

/** The guard verdict alone, for tests that compare it with the reference model. */
export function guardVerdict(
  workflow: WorkflowDef,
  guards: GuardNode,
  ticket: TicketState,
  actor: Actor,
  channel: Channel = 'ui',
): string | undefined {
  return refusingGuard(guards, new Situation(workflow, ticket, actor, channel));
}

export const engine = new WorkflowEngineImpl();
