import type {
  Actor,
  CheckDef,
  EffectDef,
  GuardNode,
  TicketState,
  TransitionDef,
  WorkflowDef,
} from '../../model';
import type { ConformanceCase, Section } from '../case';

/** A fixed clock so stamped timestamps are predictable. */
export const NOW = '2026-10-12T12:00:00.000Z';

/**
 * The reference workflow most cases start from: open, in progress, review, done and cancelled,
 * with a global Cancel and a Reopen that clears the close reason.
 */
export const W1: WorkflowDef = {
  id: 'w1',
  name: 'Standard',
  statuses: [
    { id: 'open', name: 'Open', stage: 'new' },
    { id: 'in-progress', name: 'In Progress', stage: 'active' },
    { id: 'review', name: 'In Review', stage: 'active' },
    { id: 'done', name: 'Done', stage: 'closed' },
    { id: 'cancelled', name: 'Cancelled', stage: 'closed' },
  ],
  initial: 'open',
  transitions: [
    { id: 'start', name: 'Start', from: ['open'], to: 'in-progress' },
    { id: 'review', name: 'Review', from: ['in-progress'], to: 'review' },
    { id: 'back', name: 'Back to work', from: ['review'], to: 'in-progress' },
    { id: 'finish', name: 'Finish', from: ['review'], to: 'done', layout: ['close-reason'] },
    {
      id: 'reopen',
      name: 'Reopen',
      from: ['done', 'cancelled'],
      to: 'open',
      effects: [{ type: 'clear-field', field: 'close-reason' }],
    },
    { id: 'cancel', name: 'Cancel', from: 'any', to: 'cancelled' },
  ],
};

/** A second workflow (used for "Bug uses W1 and Chore uses W2"). */
export const W2: WorkflowDef = {
  id: 'w2',
  name: 'Simple',
  statuses: [
    { id: 'backlog', name: 'Backlog', stage: 'new' },
    { id: 'doing', name: 'Doing', stage: 'active' },
    { id: 'closed', name: 'Closed', stage: 'closed' },
  ],
  initial: 'backlog',
  transitions: [
    { id: 'take', name: 'Take', from: ['backlog'], to: 'doing' },
    { id: 'close', name: 'Close', from: ['doing'], to: 'closed' },
  ],
};

export const ticket = (over: Partial<TicketState> = {}): TicketState => ({
  status: 'open',
  assignee: 'alice',
  requester: 'bob',
  closeReason: null,
  closedAt: null,
  fields: {},
  history: [{ field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' }],
  ...over,
});

/** A ticket that went open -> in-progress -> review -> in-progress (current). */
export const travelled = (over: Partial<TicketState> = {}): TicketState =>
  ticket({
    status: 'in-progress',
    history: [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
      { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      { field: 'status', from: 'in-progress', to: 'review', by: 'alice', transition: 'review' },
      { field: 'status', from: 'review', to: 'in-progress', by: 'carol', transition: 'back' },
    ],
    ...over,
  });

/** A ticket that went open -> in-progress -> review -> open (current): its most recent previous status is review. */
export const reviewed = (over: Partial<TicketState> = {}): TicketState =>
  ticket({
    status: 'open',
    history: [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
      { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      { field: 'status', from: 'in-progress', to: 'review', by: 'alice', transition: 'review' },
      { field: 'status', from: 'review', to: 'open', by: 'carol', transition: 'reopen' },
    ],
    ...over,
  });

export const actor = (user: string, over: Partial<Actor> = {}): Actor => ({ user, ...over });

export const withTransition = (
  w: WorkflowDef,
  id: string,
  patch: Partial<TransitionDef>,
): WorkflowDef => ({
  ...w,
  transitions: w.transitions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

/** W1 with a guard tree on Start. */
export const withGuards = (guards: GuardNode): WorkflowDef =>
  withTransition(W1, 'start', { guards });

/** W1 with checks on Start, which gets a layout for the named fields. */
export const withChecks = (checks: CheckDef[], layout: string[] = []): WorkflowDef =>
  withTransition(W1, 'start', { checks, layout });

/** W1 with effects on Start. */
export const withEffects = (effects: EffectDef[]): WorkflowDef =>
  withTransition(W1, 'start', { effects });

type Omitted = 'id' | 'requirement' | 'section' | 'spec';
/** Omit that keeps a union a union (a plain Omit collapses it to the common keys). */
type CaseBody = ConformanceCase extends infer C
  ? C extends unknown
    ? Omit<C, Omitted>
    : never
  : never;

/** Builds the cases of one section with a shared requirement and spec reference. */
export function section<S extends Section>(
  requirement: ConformanceCase['requirement'],
  sectionName: S,
  spec: string,
) {
  let n = 0;
  return (slug: string, body: CaseBody): ConformanceCase => {
    n++;
    return {
      ...body,
      id: `${requirement}-${slug}-${String(n).padStart(2, '0')}`,
      requirement,
      section: sectionName,
      spec,
    } as ConformanceCase;
  };
}
