import type {
  Actor,
  Channel,
  HistoryEntry,
  ItemState,
  StatusPermissions,
  TransitionBlocked,
  TransitionRequest,
  WorkflowDef,
} from '../model';

/**
 * The conformance suite's case format (M1-022). A case states a workflow, a starting state and
 * an action, and what the spec says must come out. Cases are data: the reference model runs
 * them today, the engine of M1-023 runs them tomorrow, and an importer or a third-party
 * implementation can run them too.
 *
 * Provenance: every case cites the WF requirement it checks and the spec section its behaviour
 * is restated from (`docs/specs/01a-core-work-tracking.md`); the public pages behind those
 * sections are listed in `docs/research/sources.md`. Where the spec leaves a detail open the
 * case carries a `verify` note, as the clean-room protocol asks.
 */
export type Section =
  | 'model'
  | 'conditions'
  | 'validators'
  | 'post-functions'
  | 'layouts-properties-events'
  | 'status-permissions'
  | 'resolution'
  | 'rules'
  | 'board'
  | 'editor'
  | 'import-export'
  | 'lint';

export const SECTIONS: readonly Section[] = [
  'model',
  'conditions',
  'validators',
  'post-functions',
  'layouts-properties-events',
  'status-permissions',
  'resolution',
  'rules',
  'board',
  'editor',
  'import-export',
  'lint',
];

export interface CaseBase {
  /** Unique, stable, and starting with the requirement it checks: `WF-003-only-assignee-01`. */
  id: string;
  requirement: `WF-${string}`;
  section: Section;
  title: string;
  /** Spec section the behaviour is restated from, for example `01a 3.2`. */
  spec: string;
  /** An open question for the spec owner where the public description is not precise. */
  verify?: string;
}

/** What a transition must produce. Only the keys given are compared. */
export type TransitionExpectation =
  | {
      outcome: 'blocked';
      by: TransitionBlocked['by'];
      name: string;
      message?: string;
    }
  | {
      outcome: 'ok';
      status?: string;
      assignee?: string | null;
      resolution?: string | null;
      resolvedAt?: string | null;
      securityLevel?: string | null;
      fields?: Record<string, unknown>;
      /** The history entries the transition added, in order. */
      added?: HistoryEntry[];
      event?: string;
      webhooks?: string[];
      order?: readonly string[];
      notificationsAfterSequence?: boolean;
    };

export interface PublishChange {
  /** Remove a status; items in it need a mapping entry or the publish is refused. */
  removeStatus?: string;
  /** Add a status (and a global transition into it, for simplicity of the model). */
  addStatus?: { id: string; name: string; category: 'todo' | 'in-progress' | 'done' };
  /** Restore an earlier published version. */
  rollbackTo?: number;
}

export interface Assignment {
  space: string;
  type: string;
}

export interface PublishExpectation {
  outcome: 'published' | 'refused';
  /** Why a publish was refused, by name. */
  reason?: 'mapping-required' | 'unknown-version' | 'read-only';
  version?: number;
  /** Items after the publish, in the same order as given. */
  statuses?: string[];
  /** History entries added to each moved item. */
  moved?: number;
  /** The impact panel: assignments that use this workflow. */
  impact?: Assignment[];
  /** Whether the item's status can be changed while the editor has unpublished changes. */
  downtime?: false;
}

export interface ImportEntry {
  kind: 'condition' | 'validator' | 'post-function';
  jiraClass: string;
}

export interface ImportExpectation {
  /** Our catalogue type for each entry, or 'placeholder' where no mapping exists. */
  mapped: string[];
  /** The report lists every placeholder by its Jira class. */
  report: string[];
}

export interface LintWarning {
  kind: 'unreachable-status' | 'no-exit' | 'unmapped-on-board' | 'unsatisfiable-condition';
  /** The status, transition or board the warning points at. */
  at: string;
}

export type ConformanceCase = CaseBase &
  (
    | {
        kind: 'available';
        workflow: WorkflowDef;
        item: ItemState;
        actor: Actor;
        channel?: Channel;
        expect: { transitions: string[] };
      }
    | {
        kind: 'transition';
        workflow: WorkflowDef;
        item: ItemState;
        actor: Actor;
        request: TransitionRequest;
        expect: TransitionExpectation;
      }
    | {
        kind: 'create';
        workflow: WorkflowDef;
        actor: Actor;
        fields?: Record<string, unknown>;
        expect: { status: string; event?: string; webhooks?: string[]; history?: HistoryEntry[] };
      }
    | {
        kind: 'permission';
        workflow: WorkflowDef;
        item: ItemState;
        actor: Actor;
        permission: keyof StatusPermissions;
        expect: { allowed: boolean; reason?: string };
      }
    | {
        kind: 'board-move';
        workflow: WorkflowDef;
        item: ItemState;
        actor: Actor;
        column: string;
        expect: { status?: string; resolution?: string | null; outcome?: 'ok' | 'blocked' };
      }
    | {
        kind: 'publish';
        workflow: WorkflowDef;
        /** Published versions so far; the workflow given is the draft. */
        versions?: WorkflowDef[];
        assignments?: Assignment[];
        change: PublishChange;
        items?: ItemState[];
        mapping?: Record<string, string>;
        actor?: Actor;
        expect: PublishExpectation;
      }
    | { kind: 'import'; entries: ImportEntry[]; expect: ImportExpectation }
    | { kind: 'export-roundtrip'; workflow: WorkflowDef; expect: { identical: true } }
    | {
        kind: 'lint';
        workflow: WorkflowDef;
        boards?: { id: string; columns: string[] }[];
        expect: { warnings: LintWarning[] };
      }
  );

export type CaseKind = ConformanceCase['kind'];
