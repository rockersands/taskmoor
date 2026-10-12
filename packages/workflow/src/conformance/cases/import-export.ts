import type { WorkflowDef } from '../../model';
import type { ConformanceCase, ImportEntry } from '../case';
import { section, W1, W2 } from './fixtures';

const c = section('WF-011', 'import-export', 'WF-011');

/** A workflow using every kind of configuration the format carries. */
const everything: WorkflowDef = {
  ...W1,
  transitions: W1.transitions.map((t) =>
    t.id === 'finish'
      ? {
          ...t,
          layout: ['close-reason', 'target-release'],
          guards: {
            all: [
              { type: 'only-assignee' },
              {
                any: [
                  { type: 'permission', permission: 'close' },
                  { type: 'user-in-group', group: 'qa' },
                ],
              },
            ],
          },
          checks: [
            { type: 'field-required', field: 'close-reason', message: 'Pick one' },
            { type: 'regex', field: 'target-release', pattern: '^[0-9]+' },
          ],
          effects: [
            { type: 'assign-to-requester' },
            { type: 'webhook', url: 'https://hooks.example/done' },
            { type: 'placeholder', jiraClass: 'com.example.Custom' },
          ],
          properties: { 'opsbar-sequence': '30' },
          event: 'ticket-closed',
        }
      : t,
  ),
  rules: { start: [{ type: 'assign', to: 'current-user' }] },
  statusPermissions: { done: { edit: [{ role: 'admins' }], comment: [{ group: 'staff' }] } },
};

/** One Jira class and the kind it imports as (see ImportEntry). */
const entry = (kind: ImportEntry['kind'], jiraClass: string): ImportEntry => ({
  kind,
  jiraClass,
});

export const IMPORT_EXPORT_CASES: ConformanceCase[] = [
  c('roundtrip-standard', {
    kind: 'export-roundtrip',
    title: 'Export then import yields the standard workflow unchanged',
    workflow: W1,
    expect: { identical: true },
  }),
  c('roundtrip-simple', {
    kind: 'export-roundtrip',
    title: 'Export then import yields the simple workflow unchanged',
    workflow: W2,
    expect: { identical: true },
  }),
  c('roundtrip-everything', {
    kind: 'export-roundtrip',
    title:
      'Guards, checks, effects, layouts, rules, properties, events and status permissions survive a round trip',
    workflow: everything,
    expect: { identical: true },
  }),
  c('roundtrip-board-managed', {
    kind: 'export-roundtrip',
    title: 'A board-managed workflow survives a round trip',
    workflow: {
      id: 'b',
      statuses: [
        { id: 'a', name: 'A', stage: 'new' },
        { id: 'b', name: 'B', stage: 'closed' },
      ],
      initial: 'a',
      transitions: [],
      board: { columns: ['a', 'b'] },
    },
    expect: { identical: true },
  }),
  c('jira-conditions-map-to-guards', {
    kind: 'import',
    title: 'Jira conditions map to guards by class name',
    entries: [
      entry('guard', 'com.atlassian.jira.workflow.condition.AllowOnlyAssignee'),
      entry('guard', 'com.atlassian.jira.workflow.condition.AllowOnlyReporter'),
      entry('guard', 'com.atlassian.jira.workflow.condition.AlwaysFalseCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.PermissionCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.SubTaskBlockingCondition'),
    ],
    expect: {
      mapped: [
        'only-assignee',
        'only-requester',
        'always-false',
        'permission',
        'subticket-blocking',
      ],
      report: [],
    },
    verify: 'class names to be confirmed against a Jira workflow export before the importer ships',
  }),
  c('jira-group-and-role-conditions-map-to-guards', {
    kind: 'import',
    title: 'Jira group, role and user-field conditions map to guards',
    entries: [
      entry('guard', 'com.atlassian.jira.workflow.condition.UserInGroupCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.InGroupCFCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.InProjectRoleCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.InAnyProjectRoleCondition'),
      entry('guard', 'com.atlassian.jira.workflow.condition.UserIsInCustomFieldCondition'),
    ],
    expect: {
      mapped: [
        'user-in-group',
        'user-in-group-field',
        'user-in-role',
        'user-in-any-role',
        'user-in-field',
      ],
      report: [],
    },
  }),
  c('jira-user-permission-validator-maps-to-permission-check', {
    kind: 'import',
    title: 'The sunsetted Jira user permission validator imports as the Permission check',
    entries: [
      entry('check', 'com.atlassian.jira.workflow.validator.UserPermissionValidator'),
      entry('check', 'com.atlassian.jira.workflow.validator.PermissionValidator'),
    ],
    expect: { mapped: ['permission', 'permission'], report: [] },
  }),
  c('jira-post-functions-map-to-effects', {
    kind: 'import',
    title: 'Optional Jira post functions map to effects by class',
    entries: [
      entry('effect', 'com.atlassian.jira.workflow.function.issue.AssignToCurrentUserFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.AssignToLeadFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.AssignToReporterFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.UpdateIssueFieldFunction'),
      entry(
        'effect',
        'com.atlassian.jira.workflow.function.issue.SetIssueSecurityFromRoleFunction',
      ),
    ],
    expect: {
      mapped: [
        'assign-to-current-user',
        'assign-to-owner',
        'assign-to-requester',
        'update-system-field',
        'set-visibility-level-from-role',
      ],
      report: [],
    },
  }),
  c('essential-functions-recognised', {
    kind: 'import',
    title:
      'Jira essential post functions are recognised and need no mapping: every transition has the essential effects',
    entries: [
      entry('effect', 'com.atlassian.jira.workflow.function.issue.UpdateIssueStatusFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.misc.CreateCommentFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.GenerateChangeHistoryFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.IssueReindexFunction'),
      entry('effect', 'com.atlassian.jira.workflow.function.event.FireIssueEventFunction'),
    ],
    expect: {
      mapped: ['essential', 'essential', 'essential', 'essential', 'essential'],
      report: [],
    },
  }),
  c('unknown-class-becomes-placeholder', {
    kind: 'import',
    title: 'An unmapped Jira post function becomes a disabled placeholder and is reported',
    entries: [entry('effect', 'com.example.scripts.RunScriptFunction')],
    expect: { mapped: ['placeholder'], report: ['com.example.scripts.RunScriptFunction'] },
  }),
  c('unknown-jira-condition-reported', {
    kind: 'import',
    title: 'An unmapped Jira condition is reported too',
    entries: [entry('guard', 'com.example.conditions.MoonPhaseCondition')],
    expect: { mapped: ['placeholder'], report: ['com.example.conditions.MoonPhaseCondition'] },
  }),
  c('mixed-import-keeps-order', {
    kind: 'import',
    title: 'A mixed import keeps the order and reports only the unknown ones',
    entries: [
      entry('guard', 'com.atlassian.jira.workflow.condition.AllowOnlyAssignee'),
      entry('check', 'com.example.validators.Weather'),
      entry('effect', 'com.atlassian.jira.workflow.function.issue.AssignToReporterFunction'),
      entry('effect', 'com.example.functions.Fax'),
    ],
    expect: {
      mapped: ['only-assignee', 'placeholder', 'assign-to-requester', 'placeholder'],
      report: ['com.example.validators.Weather', 'com.example.functions.Fax'],
    },
  }),
  c('empty-import', {
    kind: 'import',
    title: 'An import with no Jira classes reports nothing',
    entries: [],
    expect: { mapped: [], report: [] },
  }),
  c('placeholder-is-exportable', {
    kind: 'export-roundtrip',
    title: 'A placeholder keeps its original class through export and import',
    workflow: {
      ...W2,
      transitions: W2.transitions.map((t) =>
        t.id === 'close'
          ? { ...t, effects: [{ type: 'placeholder', jiraClass: 'com.example.Custom' }] }
          : t,
      ),
    },
    expect: { identical: true },
  }),
];
