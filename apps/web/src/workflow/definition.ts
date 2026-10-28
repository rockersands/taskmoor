import type {
  CheckDef,
  EffectDef,
  GuardNode,
  Principal,
  RuleDef,
  StatusPermissions,
} from '@taskmoor/workflow';

/**
 * A workflow version's definition as the API stores it (M1-023 to M1-027, ADR-039): statuses and
 * transitions by database id, guards, checks, effects and rules in the workflow model's own
 * shapes (`@taskmoor/workflow`, imported for its types only). The editor (M1-030) changes a copy
 * through the pure operations below; nothing here talks to the backend.
 */
export type { CheckDef, EffectDef, GuardNode, Principal, RuleDef, StatusPermissions };

export type Stage = 'new' | 'active' | 'closed';
export const STAGES: readonly Stage[] = ['new', 'active', 'closed'];

/** A workspace status, as `GET /api/v1/statuses` lists it. */
export interface Status {
  id: number;
  name: string;
  description: string;
  stage: Stage;
  order: number;
}

export interface Transition {
  /** Stable across versions, so history and integrations can name it. */
  id: number;
  name: string;
  description?: string;
  /** Source statuses, or 'any' for a global transition offered from every status. */
  from: 'any' | number[];
  to: number;
  /** Fields entered with the transition (WF-006). */
  layout?: string[];
  guards?: GuardNode;
  checks?: CheckDef[];
  effects?: EffectDef[];
  properties?: Record<string, string>;
  /** The custom event it fires; generic when absent. */
  event?: string;
  triggers?: { event: string }[];
}

export interface WorkflowDefinition {
  initialStatusId: number;
  /** Optional x and y are kept as they are; the diagram lays itself out (ADR-039, M1-030). */
  statuses: { statusId: number; x?: number; y?: number }[];
  transitions: Transition[];
  onCreate?: { effects?: EffectDef[]; event?: string };
  /** Local-mode rules by transition id (WF-009). */
  rules?: Record<string, RuleDef[]>;
  /** Who may do what in a status (WF-007), by status id. */
  statusPermissions?: Record<string, StatusPermissions>;
}

/** Limits the server enforces (spec 01a section 1.7, `workflows/model.ts`). */
export const LIMITS = {
  statuses: 200,
  transitions: 2000,
  guardDepth: 10,
  rulesPerList: 50,
  groupChildren: 100,
  layoutFields: 50,
  triggers: 20,
} as const;

export const statusIdsOf = (definition: WorkflowDefinition): number[] =>
  definition.statuses.map((s) => s.statusId);

/** True when two definitions hold the same data, whatever their key order. */
export function sameDefinition(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : v,
  );
}

/** A transition's source statuses; a global one starts from every status of the workflow. */
export function sourcesOf(definition: WorkflowDefinition, transition: Transition): number[] {
  return transition.from === 'any' ? statusIdsOf(definition) : transition.from;
}

/** Whether a transition is offered while a ticket is in `statusId` (globals from every one). */
export const startsFrom = (transition: Transition, statusId: number) =>
  transition.from === 'any' || transition.from.includes(statusId);

/**
 * The id for a new transition: above every id this draft and the versions it came from use, so
 * a removed transition's id is never given to another one (history names transitions by id).
 */
export function nextTransitionId(
  definition: WorkflowDefinition,
  reserved: Iterable<number> = [],
): number {
  let max = 0;
  for (const t of definition.transitions) max = Math.max(max, t.id);
  for (const id of reserved) max = Math.max(max, id);
  return max + 1;
}

/** Every transition id a set of definitions uses: the ones a new id must not repeat. */
export const transitionIdsOf = (...definitions: (WorkflowDefinition | null | undefined)[]) =>
  definitions.flatMap((d) => (d ? d.transitions.map((t) => t.id) : []));

export function addStatus(definition: WorkflowDefinition, statusId: number): WorkflowDefinition {
  if (definition.statuses.some((s) => s.statusId === statusId)) return definition;
  return { ...definition, statuses: [...definition.statuses, { statusId }] };
}

export function setInitialStatus(
  definition: WorkflowDefinition,
  statusId: number,
): WorkflowDefinition {
  return { ...definition, initialStatusId: statusId };
}

/** What removing a status from the workflow takes with it (WF-002, guided removal). */
export interface StatusRemoval {
  /** Transitions into the status, or out of it alone: removed with it. */
  removed: Transition[];
  /** Transitions that also start elsewhere: they keep their other sources. */
  trimmed: Transition[];
}

export function statusRemoval(definition: WorkflowDefinition, statusId: number): StatusRemoval {
  const removed: Transition[] = [];
  const trimmed: Transition[] = [];
  for (const t of definition.transitions) {
    if (t.to === statusId) removed.push(t);
    else if (t.from !== 'any' && t.from.includes(statusId)) {
      if (t.from.length === 1) removed.push(t);
      else trimmed.push(t);
    }
  }
  return { removed, trimmed };
}

/**
 * The workflow without a status: transitions into it go, transitions out of it alone go, the
 * others lose it as a source; its permissions and the removed transitions' rules go too. The
 * initial status cannot be removed: choose another first. Tickets in the status move where
 * the publish mapping says (WF-002 (1)).
 */
export function removeStatus(definition: WorkflowDefinition, statusId: number): WorkflowDefinition {
  if (definition.initialStatusId === statusId) return definition;
  const { removed } = statusRemoval(definition, statusId);
  const gone = new Set(removed.map((t) => t.id));
  let next: WorkflowDefinition = {
    ...definition,
    statuses: definition.statuses.filter((s) => s.statusId !== statusId),
    transitions: definition.transitions
      .filter((t) => !gone.has(t.id))
      .map((t) =>
        t.from !== 'any' && t.from.includes(statusId)
          ? { ...t, from: t.from.filter((s) => s !== statusId) }
          : t,
      ),
  };
  for (const id of gone) next = withRules(next, id, []);
  if (next.statusPermissions && String(statusId) in next.statusPermissions) {
    const { [String(statusId)]: _dropped, ...rest } = next.statusPermissions;
    next = withOptional(next, 'statusPermissions', Object.keys(rest).length ? rest : undefined);
  }
  return next;
}

export function addTransition(
  definition: WorkflowDefinition,
  transition: Transition,
): WorkflowDefinition {
  return { ...definition, transitions: [...definition.transitions, transition] };
}

export function updateTransition(
  definition: WorkflowDefinition,
  id: number,
  change: (transition: Transition) => Transition,
): WorkflowDefinition {
  return {
    ...definition,
    transitions: definition.transitions.map((t) => (t.id === id ? change(t) : t)),
  };
}

/** Removes a transition with its local-mode rules. */
export function removeTransition(definition: WorkflowDefinition, id: number): WorkflowDefinition {
  return withRules(
    { ...definition, transitions: definition.transitions.filter((t) => t.id !== id) },
    id,
    [],
  );
}

/** Sets a transition's rules; an empty list removes the entry (and `rules` when it empties). */
export function withRules(
  definition: WorkflowDefinition,
  transitionId: number,
  rules: RuleDef[],
): WorkflowDefinition {
  const key = String(transitionId);
  const current = definition.rules ?? {};
  if (rules.length === 0 && !(key in current)) return definition;
  const { [key]: _old, ...others } = current;
  const next = rules.length > 0 ? { ...others, [key]: rules } : others;
  return withOptional(definition, 'rules', Object.keys(next).length > 0 ? next : undefined);
}

/** Sets an optional key, leaving it out entirely when the value is undefined. */
export function withOptional<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: T[K] | undefined,
): T {
  const { [key]: _old, ...rest } = object;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

/** The text of the text mode: the definition as JSON, the API's own format (WF-011). */
export function formatDefinition(definition: WorkflowDefinition): string {
  return `${JSON.stringify(definition, null, 2)}\n`;
}

/**
 * Where JSON text stops being valid, as an offset, or null when it is valid. Browsers word
 * JSON.parse errors differently and not all of them say where, so the editor finds it itself.
 */
export function jsonErrorOffset(text: string): number | null {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++;
  };
  const string = () => {
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c < ' ') fail();
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) fail();
        i += 2;
        continue;
      }
      i++;
    }
  };
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (): void => {
    space();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      space();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (c === '{') {
          space();
          if (text[i] !== '"') fail();
          string();
          space();
          if (text[i] !== ':') fail();
          i++;
        }
        value();
        space();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail();
      }
    }
    if (c === '"') {
      string();
      return;
    }
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    number.lastIndex = i;
    if (!number.test(text)) fail();
    i = number.lastIndex;
  };
  try {
    value();
    space();
    if (i < text.length) fail();
    return null;
  } catch (offset) {
    if (typeof offset === 'number') return offset;
    throw offset;
  }
}

/** Where JSON text stops being valid, as a line and column counted from 1. */
export function jsonErrorPosition(text: string): { line: number; column: number } | null {
  const offset = jsonErrorOffset(text);
  if (offset === null) return null;
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}
