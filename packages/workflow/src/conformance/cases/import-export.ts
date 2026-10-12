import type { WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { section, W1, W2 } from './fixtures';

const c = section('WF-011', 'import-export', 'WF-011');

/** A workflow using every kind of configuration the format carries. */
const everything: WorkflowDef = {
  ...W1,
  transitions: W1.transitions.map((t) =>
    t.id === 'finish'
      ? {
          ...t,
          layout: ['resolution', 'fix-version'],
          conditions: {
            all: [
              { type: 'only-assignee' },
              {
                any: [
                  { type: 'permission', permission: 'resolve' },
                  { type: 'user-in-group', group: 'qa' },
                ],
              },
            ],
          },
          validators: [
            { type: 'field-required', field: 'resolution', message: 'Pick one' },
            { type: 'regex', field: 'fix-version', pattern: '^[0-9]+' },
          ],
          postFunctions: [
            { type: 'assign-to-reporter' },
            { type: 'webhook', url: 'https://hooks.example/done' },
            { type: 'placeholder', jiraClass: 'com.example.Custom' },
          ],
          properties: { 'opsbar-sequence': '30' },
          event: 'item-resolved',
        }
      : t,
  ),
  rules: { start: [{ type: 'assign', to: 'current-user' }] },
  statusPermissions: { done: { edit: [{ role: 'admins' }], comment: [{ group: 'staff' }] } },
};

const entry = (kind: 'condition' | 'validator' | 'post-function', jiraClass: string) => ({
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
      'Conditions, validators, post functions, layouts, rules, properties, events and status permissions survive a round trip',
    workflow: everything,
    expect: { identical: true },
  }),
  c('roundtrip-board-managed', {
    kind: 'export-roundtrip',
    title: 'A board-managed workflow survives a round trip',
    workflow: {
      id: 'b',
      statuses: [
        { id: 'a', name: 'A', category: 'todo' },
        { id: 'b', name: 'B', category: 'done' },
      ],
      initial: 'a',
      transitions: [],
      board: { columns: ['a', 'b'] },
    },
    expect: { identical: true },
  }),
  c('conditions-map-by-class', {
    kind: 'import',
    title: 'Jira conditions map to the catalogue by class name',
    entries: [
      entry('condition', 'com.atlassian.jira.workflow.condition.AllowOnlyAssignee'),
      entry('condition', 'com.atlassian.jira.workflow.condition.AllowOnlyReporter'),
      entry('condition', 'com.atlassian.jira.workflow.condition.AlwaysFalseCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.PermissionCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.SubTaskBlockingCondition'),
    ],
    expect: {
      mapped: ['only-assignee', 'only-reporter', 'always-false', 'permission', 'subtask-blocking'],
      report: [],
    },
    verify: 'class names to be confirmed against a Jira workflow export before the importer ships',
  }),
  c('group-and-role-conditions-map', {
    kind: 'import',
    title: 'Group, role and user-field conditions map',
    entries: [
      entry('condition', 'com.atlassian.jira.workflow.condition.UserInGroupCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.InGroupCFCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.InProjectRoleCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.InAnyProjectRoleCondition'),
      entry('condition', 'com.atlassian.jira.workflow.condition.UserIsInCustomFieldCondition'),
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
  c('sunsetted-user-permission-validator-maps-to-permission', {
    kind: 'import',
    title: 'The sunsetted user permission validator imports as Permission',
    entries: [
      entry('validator', 'com.atlassian.jira.workflow.validator.UserPermissionValidator'),
      entry('validator', 'com.atlassian.jira.workflow.validator.PermissionValidator'),
    ],
    expect: { mapped: ['permission', 'permission'], report: [] },
  }),
  c('post-functions-map', {
    kind: 'import',
    title: 'Optional post functions map by class',
    entries: [
      entry(
        'post-function',
        'com.atlassian.jira.workflow.function.issue.AssignToCurrentUserFunction',
      ),
      entry('post-function', 'com.atlassian.jira.workflow.function.issue.AssignToLeadFunction'),
      entry('post-function', 'com.atlassian.jira.workflow.function.issue.AssignToReporterFunction'),
      entry('post-function', 'com.atlassian.jira.workflow.function.issue.UpdateIssueFieldFunction'),
      entry(
        'post-function',
        'com.atlassian.jira.workflow.function.issue.SetIssueSecurityFromRoleFunction',
      ),
    ],
    expect: {
      mapped: [
        'assign-to-current-user',
        'assign-to-lead',
        'assign-to-reporter',
        'update-system-field',
        'set-security-level-from-role',
      ],
      report: [],
    },
  }),
  c('essential-functions-recognised', {
    kind: 'import',
    title: 'The essential post functions are recognised and need no mapping of their own',
    entries: [
      entry(
        'post-function',
        'com.atlassian.jira.workflow.function.issue.UpdateIssueStatusFunction',
      ),
      entry('post-function', 'com.atlassian.jira.workflow.function.misc.CreateCommentFunction'),
      entry(
        'post-function',
        'com.atlassian.jira.workflow.function.issue.GenerateChangeHistoryFunction',
      ),
      entry('post-function', 'com.atlassian.jira.workflow.function.issue.IssueReindexFunction'),
      entry('post-function', 'com.atlassian.jira.workflow.function.event.FireIssueEventFunction'),
    ],
    expect: {
      mapped: ['essential', 'essential', 'essential', 'essential', 'essential'],
      report: [],
    },
  }),
  c('unknown-class-becomes-placeholder', {
    kind: 'import',
    title: 'An unmapped function becomes a disabled placeholder and is reported',
    entries: [entry('post-function', 'com.example.scripts.RunScriptFunction')],
    expect: { mapped: ['placeholder'], report: ['com.example.scripts.RunScriptFunction'] },
  }),
  c('unknown-condition-reported', {
    kind: 'import',
    title: 'An unmapped condition is reported too',
    entries: [entry('condition', 'com.example.conditions.MoonPhaseCondition')],
    expect: { mapped: ['placeholder'], report: ['com.example.conditions.MoonPhaseCondition'] },
  }),
  c('mixed-import-keeps-order', {
    kind: 'import',
    title: 'A mixed import keeps the order and reports only the unknown ones',
    entries: [
      entry('condition', 'com.atlassian.jira.workflow.condition.AllowOnlyAssignee'),
      entry('validator', 'com.example.validators.Weather'),
      entry('post-function', 'com.atlassian.jira.workflow.function.issue.AssignToReporterFunction'),
      entry('post-function', 'com.example.functions.Fax'),
    ],
    expect: {
      mapped: ['only-assignee', 'placeholder', 'assign-to-reporter', 'placeholder'],
      report: ['com.example.validators.Weather', 'com.example.functions.Fax'],
    },
  }),
  c('empty-import', {
    kind: 'import',
    title: 'An import with no functions reports nothing',
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
          ? { ...t, postFunctions: [{ type: 'placeholder', jiraClass: 'com.example.Custom' }] }
          : t,
      ),
    },
    expect: { identical: true },
  }),
];
