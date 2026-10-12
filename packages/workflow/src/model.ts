/**
 * The workflow behaviour model (spec 01a, sections 3.1 to 3.6 and WF-001 to WF-012): the data
 * a workflow is made of and the state a transition reads and writes. The conformance cases are
 * written against these types; the reference model and, later, the engine implement them.
 *
 * A transition has guards (who may see or run it), checks (what must hold before it completes)
 * and effects (what happens after it); Jira calls these conditions, validators and post
 * functions. Identifiers are the catalogue names from the spec in kebab-case. Nothing here
 * depends on storage; the engine (M1-023) maps these onto the database.
 */

/** The stage of a status (Jira: status category). */
export type Stage = 'new' | 'active' | 'closed';

export interface StatusDef {
  id: string;
  name: string;
  stage: Stage;
}

export type CompareOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

/** Section 3.2. Guards (Jira: conditions) nest in all/any groups to any depth. */
export type GuardNode =
  | { all: GuardNode[] }
  | { any: GuardNode[] }
  | { type: 'always-false' }
  | { type: 'block-until-approval' }
  | { type: 'compare-number'; field: string; op: CompareOp; value: number }
  | { type: 'hide-from-user' }
  | { type: 'only-assignee' }
  | { type: 'only-requester' }
  | { type: 'permission'; permission: string }
  | { type: 'previous-status'; status: string; mostRecentOnly?: boolean }
  | { type: 'separation-of-duties'; transition: string }
  | { type: 'subticket-blocking'; statuses: string[] }
  | { type: 'user-in-group'; group: string }
  | { type: 'user-in-any-group'; groups: string[] }
  | { type: 'user-in-role'; role: string }
  | { type: 'user-in-any-role'; roles: string[] }
  | { type: 'user-in-field'; field: string }
  | { type: 'user-in-group-field'; field: string }
  | { type: 'value-field'; field: string; op: CompareOp; value: unknown };

/** Section 3.3. Every check (Jira: validator) takes an optional message shown when it blocks. */
export type CheckDef = { message?: string } & (
  | { type: 'field-required'; field: string }
  | { type: 'field-modified'; field: string }
  | { type: 'field-single-value'; field: string }
  | { type: 'date-compare'; field: string; op: CompareOp; other: string; includeTime?: boolean }
  | { type: 'date-window'; field: string; other: string; days: number }
  | { type: 'regex'; field: string; pattern: string }
  | { type: 'forms-attached' }
  | { type: 'forms-submitted' }
  | { type: 'parent-status'; statuses: string[] }
  | { type: 'permission'; permission: string }
  | { type: 'previous-state'; status: string; mostRecentOnly?: boolean }
);

/**
 * Section 3.4, the optional effects (Jira: post functions). The essential five are implied on
 * every transition.
 */
export type EffectDef =
  | { type: 'assign-to-current-user' }
  | { type: 'assign-to-owner' }
  | { type: 'assign-to-requester' }
  | { type: 'clear-field'; field: string }
  | { type: 'copy-field'; from: string; to: string; fromParent?: boolean }
  | { type: 'set-visibility-level-from-role'; levels: Record<string, string> }
  | { type: 'webhook'; url: string }
  | { type: 'update-field'; field: string; value: unknown }
  | { type: 'update-system-field'; field: SystemField; value: unknown }
  | { type: 'placeholder'; jiraClass: string };

export type SystemField =
  | 'assignee'
  | 'description'
  | 'environment'
  | 'priority'
  | 'close-reason'
  | 'summary'
  | 'original-estimate'
  | 'remaining-estimate';

/** The essential effects, in the only order they run (section 3.4). */
export const ESSENTIAL_ORDER = ['status', 'comment', 'history', 'index', 'event'] as const;

export interface TransitionDef {
  id: string;
  name: string;
  /** Source statuses, or 'any' for a global transition. */
  from: string[] | 'any';
  to: string;
  /** Field ids shown on the transition layout (Jira: transition screen); empty means none. */
  layout?: string[];
  guards?: GuardNode;
  checks?: CheckDef[];
  effects?: EffectDef[];
  properties?: Record<string, string>;
  /** The event fired by the essential effect; 'generic' unless a custom event is named. */
  event?: string;
}

/** Section 3.5 rules of local-mode workflows (Jira: team-managed). */
export type RuleDef =
  | { type: 'assign'; to: 'current-user' | 'requester' | { user: string } }
  | { type: 'restrict-field-value'; field: string; value: unknown }
  | {
      type: 'restrict-been-through';
      status: string;
      includeCurrent?: boolean;
      reverse?: boolean;
      mostRecentOnly?: boolean;
      ignoreLoops?: boolean;
    }
  | { type: 'restrict-who'; users?: string[]; groups?: string[]; roles?: string[] }
  | { type: 'validate-permission'; permission: string }
  | { type: 'copy-field'; from: string; to: string }
  | { type: 'update-field'; field: string; value: unknown };

/** WF-007: who may do what while a ticket sits in a status. */
export interface StatusPermissions {
  edit?: Principal[];
  comment?: Principal[];
  attach?: Principal[];
  assign?: Principal[];
  transition?: Principal[];
}

export type Principal = { role: string } | { group: string };

export interface WorkflowDef {
  id: string;
  name?: string;
  statuses: StatusDef[];
  initial: string;
  transitions: TransitionDef[];
  /** Local-mode rules keyed by the transition they apply to (section 3.5, WF-009). */
  rules?: Record<string, RuleDef[]>;
  statusPermissions?: Record<string, StatusPermissions>;
  /** A board-managed workflow: the columns are the statuses, in order (section 3.6). */
  board?: { columns: string[] };
}

/** One recorded change (section 3.4, essential effect 3). */
export interface HistoryEntry {
  field: string;
  from: unknown;
  to: unknown;
  by: string;
  /** The transition that made the change, when one did. */
  transition?: string;
}

export interface TicketState {
  status: string;
  assignee?: string | null;
  requester?: string;
  closeReason?: string | null;
  /** The closed stamp: set when a close reason is set, cleared with it (WF-008). */
  closedAt?: string | null;
  visibilityLevel?: string | null;
  fields: Record<string, unknown>;
  history: HistoryEntry[];
  comments?: { by: string; text: string }[];
  parent?: { status: string; fields?: Record<string, unknown> };
  subtickets?: { status: string }[];
  /** Owners consulted by "assign to owner" (Jira: assign to lead developer). */
  areaOwner?: string | null;
  trackOwner?: string | null;
  /** Forms attached to the ticket and whether each was submitted (checks of section 3.3). */
  forms?: { submitted: boolean }[];
}

export interface Actor {
  user: string;
  groups?: string[];
  roles?: string[];
  permissions?: string[];
}

/** How the transition was requested; "hide from user" only hides the UI path. */
export type Channel = 'ui' | 'rest' | 'automation' | 'effect';

export interface TransitionRequest {
  transition: string;
  channel?: Channel;
  /** Values entered on the transition layout. */
  fields?: Record<string, unknown>;
  comment?: string;
  /** The wall clock the engine stamps with; cases fix it for stable expectations. */
  now?: string;
}

export interface TransitionBlocked {
  outcome: 'blocked';
  by: 'guard' | 'check' | 'rule' | 'permission' | 'unknown-transition' | 'wrong-status';
  /** The guard type, check type or rule type that blocked, as named in the spec. */
  name: string;
  message?: string;
  /** The ticket as it stands after the refusal: identical to the input. */
  ticket: TicketState;
}

export interface TransitionDone {
  outcome: 'ok';
  ticket: TicketState;
  /** The essential effects, in the order they ran. */
  order: string[];
  /** The event fired by the transition: 'generic' or the custom event id. */
  event: string;
  webhooks: string[];
  /** True when notifications were queued only after the whole sequence (section 3.4). */
  notificationsAfterSequence: boolean;
}

export type TransitionResult = TransitionBlocked | TransitionDone;
