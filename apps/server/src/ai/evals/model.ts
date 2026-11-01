/** The shapes of the eval dataset (M1-133; ADR-107); the data is in `dataset.ts`. */
export type Handle = 'ana' | 'ben' | 'chen' | 'dara' | 'elif' | 'farid' | 'grace' | 'hiro';
export type TrackKey = 'WEB' | 'API' | 'MOB' | 'OPS';
export type GroupName = 'web-team' | 'platform-team' | 'mobile-team' | 'security';
export type TypeName = 'Outcome' | 'Feature' | 'Bug' | 'Chore';
export type PriorityName = 'Urgent' | 'High' | 'Normal' | 'Low';
export type StatusName = 'New' | 'Active' | 'In Review' | 'Closed';
export type CloseReasonName = 'Completed' | 'Not planned' | 'Duplicate' | 'Not reproducible';

export interface CommentSpec {
  /** The comment's name within its ticket: c1, c2, ... in the order they are written. */
  ref: string;
  author: Handle;
  text: string;
  /** Readable only by this group's members. */
  restrictedTo?: GroupName;
  /** When it was written, in days before `EVAL_NOW`. */
  daysAgo: number;
}

export interface TicketSpec {
  /** A stable name: `g-WEB-007` for generated tickets, the case id for summary cases. */
  name: string;
  track: TrackKey;
  type: TypeName;
  summary: string;
  description: string;
  creator: Handle;
  assignee: Handle | null;
  priority: PriorityName | null;
  status: StatusName;
  closeReason?: CloseReasonName;
  labels: readonly string[];
  areas: readonly string[];
  targetRelease?: string;
  foundIn?: string;
  /** YYYY-MM-DD. */
  due?: string;
  points?: number;
  /** The name of the parent ticket (an Outcome). */
  parent?: string;
  /** Days before `EVAL_NOW`; fractions are hours. */
  createdDaysAgo: number;
  updatedDaysAgo: number;
  comments: readonly CommentSpec[];
}
