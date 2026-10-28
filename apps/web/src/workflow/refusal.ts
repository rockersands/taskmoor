import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

/**
 * Why the server refused a transition (409 `transition_refused`, M1-024 to M1-026), worded in
 * the reader's language. A check names its type and parameters; a message an administrator
 * wrote for it is shown as written, as only they know what it should say (WF-004).
 */
export interface TransitionRefusal {
  error: 'transition_refused';
  by: 'guard' | 'check' | 'rule';
  /** The guard, check or rule type, as the workflow model names it. */
  name: string;
  /** The server's English text, or the administrator's own. */
  message?: string;
  check?: { type: string; configured: boolean } & Record<string, unknown>;
}

const FIELDS: Record<string, MessageId> = {
  summary: 'workflow.field.summary',
  description: 'workflow.field.description',
  environment: 'workflow.field.environment',
  assignee: 'workflow.field.assignee',
  'close-reason': 'workflow.field.closeReason',
  priority: 'workflow.field.priority',
  labels: 'workflow.field.labels',
  'start-date': 'workflow.field.startDate',
  'due-date': 'workflow.field.dueDate',
  'original-estimate': 'workflow.field.originalEstimate',
  'remaining-estimate': 'workflow.field.remainingEstimate',
  'target-release': 'workflow.field.targetRelease',
  'found-in-release': 'workflow.field.foundInRelease',
  area: 'workflow.field.area',
  'time-spent': 'workflow.field.timeSpent',
  'ticket-type': 'workflow.field.ticketType',
  requester: 'workflow.field.requester',
  creator: 'workflow.field.creator',
};

export const CHECK_MESSAGES: Record<string, MessageId> = {
  'field-required': 'workflow.check.fieldRequired',
  'field-modified': 'workflow.check.fieldModified',
  'field-single-value': 'workflow.check.fieldSingleValue',
  'date-compare': 'workflow.check.dateCompare',
  'date-window': 'workflow.check.dateWindow',
  regex: 'workflow.check.regex',
  'forms-attached': 'workflow.check.formsAttached',
  'forms-submitted': 'workflow.check.formsSubmitted',
  'parent-status': 'workflow.check.parentStatus',
  permission: 'workflow.check.permission',
  'previous-state': 'workflow.check.previousState',
};

const GUARD_MESSAGES: Record<string, MessageId> = {
  'only-assignee': 'workflow.guard.onlyAssignee',
  'only-requester': 'workflow.guard.onlyRequester',
  'separation-of-duties': 'workflow.guard.separationOfDuties',
  'subticket-blocking': 'workflow.guard.subticketBlocking',
  'block-until-approval': 'workflow.guard.blockUntilApproval',
};

/** A table's own entry for a key the server sent, never an inherited property. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** A field's label; a field this client does not know shows its name. */
export function fieldLabel(t: Translate, name: string): string {
  const id = own(FIELDS, name);
  return id ? t(id) : name;
}

export function refusalMessage(t: Translate, refusal: TransitionRefusal): string {
  if (refusal.by === 'rule') return t('workflow.rule.refused');
  if (refusal.by === 'guard')
    return t(own(GUARD_MESSAGES, refusal.name) ?? 'workflow.guard.refused');
  const check = refusal.check;
  if (check?.configured && refusal.message) return refusal.message;
  const id = own(CHECK_MESSAGES, refusal.name);
  if (!id || !check) return t('workflow.check.unknown');
  const text = (key: string) => (typeof check[key] === 'string' ? (check[key] as string) : '');
  return t(id, {
    field: fieldLabel(t, text('field')),
    other: fieldLabel(t, text('other')),
    op: text('op'),
    days: typeof check.days === 'number' ? check.days : 0,
  });
}
