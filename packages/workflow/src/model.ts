/**
 * The workflow behaviour model (spec 01a, sections 3.1 to 3.6 and WF-001 to WF-012): the data
 * a workflow is made of and the state a transition reads and writes. The conformance cases are
 * written against these types; the reference model and, later, the engine implement them.
 *
 * Identifiers are the catalogue names from the spec in kebab-case. Nothing here depends on
 * storage; the engine (M1-023) maps these onto the database.
 */

export type StatusCategory = 'todo' | 'in-progress' | 'done';

export interface StatusDef {
  id: string;
  name: string;
  category: StatusCategory;
}

export type CompareOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

/** Section 3.2. Conditions nest in all/any groups to any depth. */
export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { type: 'always-false' }
  | { type: 'block-until-approval' }
  | { type: 'compare-number'; field: string; op: CompareOp; value: number }
  | { type: 'hide-from-user' }
  | { type: 'only-assignee' }
  | { type: 'only-reporter' }
  | { type: 'permission'; permission: string }
  | { type: 'previous-status'; status: string; mostRecentOnly?: boolean }
  | { type: 'separation-of-duties'; transition: string }
  | { type: 'subtask-blocking'; statuses: string[] }
  | { type: 'user-in-group'; group: string }
  | { type: 'user-in-any-group'; groups: string[] }
  | { type: 'user-in-role'; role: string }
  | { type: 'user-in-any-role'; roles: string[] }
  | { type: 'user-in-field'; field: string }
  | { type: 'user-in-group-field'; field: string }
  | { type: 'value-field'; field: string; op: CompareOp; value: unknown };

/** Section 3.3. Every validator takes an optional message shown when it blocks. */
export type ValidatorDef = { message?: string } & (
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

/** Section 3.4, the optional post functions. The essential five are implied on every transition. */
export type PostFunctionDef =
  | { type: 'assign-to-current-user' }
  | { type: 'assign-to-lead' }
  | { type: 'assign-to-reporter' }
  | { type: 'clear-field'; field: string }
  | { type: 'copy-field'; from: string; to: string; fromParent?: boolean }
  | { type: 'set-security-level-from-role'; levels: Record<string, string> }
  | { type: 'webhook'; url: string }
  | { type: 'update-field'; field: string; value: unknown }
  | { type: 'update-system-field'; field: SystemField; value: unknown }
  | { type: 'placeholder'; jiraClass: string };

export type SystemField =
  | 'assignee'
  | 'description'
  | 'environment'
  | 'priority'
  | 'resolution'
  | 'summary'
  | 'original-estimate'
  | 'remaining-estimate';

/** The essential post functions, in the only order they run (section 3.4). */
export const ESSENTIAL_ORDER = ['status', 'comment', 'history', 'index', 'event'] as const;

export interface TransitionDef {
  id: string;
  name: string;
  /** Source statuses, or 'any' for a global transition. */
  from: string[] | 'any';
  to: string;
  /** Field ids shown on the transition layout (screen); empty means no layout. */
  layout?: string[];
  conditions?: ConditionNode;
  validators?: ValidatorDef[];
  postFunctions?: PostFunctionDef[];
  properties?: Record<string, string>;
  /** The event fired by the essential post function; 'generic' unless a custom event is named. */
  event?: string;
}

/** Section 3.5 rules of space-local workflows. */
export type RuleDef =
  | { type: 'assign'; to: 'current-user' | 'reporter' | { user: string } }
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

/** WF-007: who may do what while an item sits in a status. */
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
  /** Space-local rules keyed by the transition they apply to (section 3.5, WF-009). */
  rules?: Record<string, RuleDef[]>;
  statusPermissions?: Record<string, StatusPermissions>;
  /** A board-managed workflow: the columns are the statuses, in order (section 3.6). */
  board?: { columns: string[] };
}

/** One recorded change (section 3.4, essential post function 3). */
export interface HistoryEntry {
  field: string;
  from: unknown;
  to: unknown;
  by: string;
  /** The transition that made the change, when one did. */
  transition?: string;
}

export interface ItemState {
  status: string;
  assignee?: string | null;
  reporter?: string;
  resolution?: string | null;
  /** Set when a resolution is set, cleared with it (WF-008). */
  resolvedAt?: string | null;
  securityLevel?: string | null;
  fields: Record<string, unknown>;
  history: HistoryEntry[];
  comments?: { by: string; text: string }[];
  parent?: { status: string; fields?: Record<string, unknown> };
  subtasks?: { status: string }[];
  /** Leads consulted by "assign to lead developer". */
  componentLead?: string | null;
  spaceLead?: string | null;
  /** Forms attached to the item and whether each was submitted (validators of section 3.3). */
  forms?: { submitted: boolean }[];
}

export interface Actor {
  user: string;
  groups?: string[];
  roles?: string[];
  permissions?: string[];
}

/** How the transition was requested; "hide from user" only hides the UI path. */
export type Channel = 'ui' | 'rest' | 'automation' | 'post-function';

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
  by: 'condition' | 'validator' | 'rule' | 'permission' | 'unknown-transition' | 'wrong-status';
  /** The condition type, validator type or rule type that blocked, as named in the spec. */
  name: string;
  message?: string;
  /** The item as it stands after the refusal: identical to the input. */
  item: ItemState;
}

export interface TransitionDone {
  outcome: 'ok';
  item: ItemState;
  /** The essential post functions, in the order they ran. */
  order: string[];
  /** The event fired by the transition: 'generic' or the custom event id. */
  event: string;
  webhooks: string[];
  /** True when notifications were queued only after the whole sequence (section 3.4). */
  notificationsAfterSequence: boolean;
}

export type TransitionResult = TransitionBlocked | TransitionDone;
