import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { entryOf, type RuleKind } from './catalogue';
import type { Stage, Status, WorkflowDefinition } from './definition';
import type { LintIssue } from './lint';
import type { ShapeProblem } from './shape';

/**
 * Words for the editor (M1-030): the names of statuses and transitions, the lint issues, the
 * text mode's shape problems and the server's refusals, all through the catalogue. Names that
 * people chose pass through `common.value`, so the pseudo-locale shows them as translated.
 */
export const STAGE_LABELS: Record<Stage, MessageId> = {
  new: 'workflow.stage.new',
  active: 'workflow.stage.active',
  closed: 'workflow.stage.closed',
};

export const STAGE_HINTS: Record<Stage, MessageId> = {
  new: 'workflow.stage.newHint',
  active: 'workflow.stage.activeHint',
  closed: 'workflow.stage.closedHint',
};

export interface Names {
  status: (id: number) => string;
  transition: (id: number) => string;
}

/** Names as people see them: the workspace's statuses and the definition's transitions. */
export function namesFor(
  t: Translate,
  statuses: readonly Status[],
  definition: WorkflowDefinition | null,
): Names {
  const statusNames = new Map(statuses.map((s) => [s.id, s.name]));
  const transitionNames = new Map((definition?.transitions ?? []).map((x) => [x.id, x.name]));
  return {
    status: (id) => {
      const name = statusNames.get(id);
      return name === undefined
        ? t('admin.workflow.unknownStatus', { id })
        : t('common.value', { value: name });
    },
    transition: (id) => {
      const name = transitionNames.get(id);
      return name === undefined
        ? t('admin.workflow.unknownTransition', { id })
        : t('common.value', { value: name });
    },
  };
}

export function ruleTypeLabel(t: Translate, kind: RuleKind, type: string): string {
  const entry = entryOf(kind, type);
  return entry ? t(entry.labelId) : t('admin.workflow.rule.unknownType', { type });
}

export function lintMessage(t: Translate, issue: LintIssue, names: Names): string {
  switch (issue.kind) {
    case 'unknown-status':
      return t('workflow.lint.unknownStatus', { id: issue.statusId });
    case 'duplicate-status':
      return t('workflow.lint.duplicateStatus', { status: names.status(issue.statusId) });
    case 'initial-missing':
      return t('workflow.lint.initialMissing', { status: names.status(issue.statusId) });
    case 'duplicate-transition':
      return t('workflow.lint.duplicateTransition', { id: issue.transitionId });
    case 'missing-target':
      return t('workflow.lint.missingTarget', {
        transition: names.transition(issue.transitionId),
        status: names.status(issue.statusId),
      });
    case 'missing-source':
      return t('workflow.lint.missingSource', {
        transition: names.transition(issue.transitionId),
        status: names.status(issue.statusId),
      });
    case 'guards-too-deep':
      return t('workflow.lint.guardsTooDeep', { transition: names.transition(issue.transitionId) });
    case 'unreachable-status':
      return t(issue.entered ? 'workflow.lint.unreachableVia' : 'workflow.lint.unreachable', {
        status: names.status(issue.statusId),
      });
    case 'no-exit':
      return t('workflow.lint.noExit', { status: names.status(issue.statusId) });
    case 'unsatisfiable-guard':
      return t('workflow.lint.unsatisfiable', { transition: names.transition(issue.transitionId) });
  }
}

const SHAPE_MESSAGES: Record<ShapeProblem['code'], MessageId> = {
  not_object: 'workflow.shape.not_object',
  missing: 'workflow.shape.missing',
  unknown_key: 'workflow.shape.unknown_key',
  not_id: 'workflow.shape.not_id',
  not_id_text: 'workflow.shape.not_id_text',
  not_text: 'workflow.shape.not_text',
  text_length: 'workflow.shape.text_length',
  not_list: 'workflow.shape.not_list',
  list_length: 'workflow.shape.list_length',
  unknown_type: 'workflow.shape.unknown_type',
  not_op: 'workflow.shape.not_op',
  not_number: 'workflow.shape.not_number',
  not_integer: 'workflow.shape.not_integer',
  not_boolean: 'workflow.shape.not_boolean',
  not_url: 'workflow.shape.not_url',
  not_event: 'workflow.shape.not_event',
  not_trigger: 'workflow.shape.not_trigger',
  not_system_field: 'workflow.shape.not_system_field',
  not_assign_target: 'workflow.shape.not_assign_target',
  not_guard: 'workflow.shape.not_guard',
};

export function shapeMessage(t: Translate, problem: ShapeProblem): string {
  return t(SHAPE_MESSAGES[problem.code], { path: problem.path, ...problem.args });
}

/** The server's `definitionProblem` codes (apps/server/src/workflows/model.ts). */
export const DEFINITION_PROBLEMS: Record<string, MessageId> = {
  unknown_status: 'workflow.problem.unknown_status',
  duplicate_status: 'workflow.problem.duplicate_status',
  initial_not_in_workflow: 'workflow.problem.initial_not_in_workflow',
  duplicate_transition: 'workflow.problem.duplicate_transition',
  transition_status_not_in_workflow: 'workflow.problem.transition_status_not_in_workflow',
  unknown_field: 'workflow.problem.unknown_field',
  field_not_writable: 'workflow.problem.field_not_writable',
  invalid_value: 'workflow.problem.invalid_value',
  unknown_close_reason: 'workflow.problem.unknown_close_reason',
  invalid_pattern: 'workflow.problem.invalid_pattern',
  guards_too_deep: 'workflow.problem.guards_too_deep',
  // A publish or a file imported as a new workflow that could get no move at all (T-260).
  no_moves: 'workflow.problem.no_moves',
};

/** Why the server refused a definition, from the `detail` of its 400 or 409 answer. */
export function definitionProblemMessage(t: Translate, detail: unknown, names: Names): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  const code = typeof d.problem === 'string' ? d.problem : '';
  const id = Object.hasOwn(DEFINITION_PROBLEMS, code) ? DEFINITION_PROBLEMS[code] : undefined;
  if (!id) return t('workflow.problem.refused');
  const num = (key: string) => (typeof d[key] === 'number' ? (d[key] as number) : 0);
  const where =
    typeof d.transitionId === 'number'
      ? names.transition(d.transitionId)
      : t('workflow.problem.onCreate');
  return t(id, {
    statusId: num('statusId'),
    status: names.status(num('statusId')),
    transition: names.transition(num('transitionId')),
    id: num('transitionId'),
    where,
    field: typeof d.field === 'string' ? d.field : '',
    pattern: typeof d.pattern === 'string' ? d.pattern : '',
  });
}

/** What to tell people about a failed save, publish or restore, or null for a generic line. */
export function refusalMessage(
  t: Translate,
  error: unknown,
  names: Names,
  restoring?: number,
): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = (error.body ?? {}) as { error?: string; detail?: unknown };
  switch (body.error) {
    case 'cannot_restore':
      return t('workflow.problem.cannotRestore', {
        version: restoring ?? 0,
        reason: definitionProblemMessage(t, body.detail, names),
      });
    case 'invalid_request':
      if (body.detail && typeof body.detail === 'object' && 'problem' in body.detail) {
        const detail = body.detail as { problem?: unknown };
        if (detail.problem === 'not_in_workflow') return t('workflow.problem.badMapping');
        return definitionProblemMessage(t, body.detail, names);
      }
      return t('workflow.problem.refused');
    case 'status_mapping_required':
      return t('workflow.problem.mappingRequired');
    case 'no_draft':
      return t('workflow.problem.noDraft');
    case 'is_draft':
      return t('workflow.problem.isDraft');
    default:
      return null;
  }
}
