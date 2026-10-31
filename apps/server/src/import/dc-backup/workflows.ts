import { fieldWorldOf } from './fields';
import { customFieldKey, type EntityName, PROJECT_SCHEME } from './format';
import {
  ALL_OTHER_TYPES,
  CUSTOM_EVENT_TYPE,
  META,
  type WfAction,
  type WfCondition,
  type WfConditions,
  type WfDescriptor,
  type WfFunction,
  type WfResult,
  type WfStep,
  workflowCases,
  writeDescriptor,
} from './workflow-format';
import { FIRST_ID, type Group, type IssueType, type Status, type World } from './world';

/**
 * The synthetic instance's workflows (M1-090; ADR-093), written in our own words: four
 * workflows in use, a copy of one that differs only in its name, and one no scheme uses. They
 * hold every status the issues can be in, so each issue's status is a step of its workflow.
 * Their transitions come from every place a descriptor allows (the initial action, global
 * actions, common actions shared by two steps, a step's own actions), with screens, nested
 * condition groups, validators and post functions of the common built-in kinds, and rules a
 * Taskmoor workflow cannot hold: a negated condition, a conditional result, a script, conditions
 * on custom fields, app classes, a webhook and a security level from a role. Three workflow
 * schemes give each issue type its workflow; the third repeats the first through the copy.
 * One custom event is fired by a transition (and named by a notification scheme, M1-092).
 *
 * The class names of the built-in kinds are the ones `@taskmoor/workflow` maps (WF-011,
 * `JIRA_FUNCTION_MAP`), plus the webhook function; every one of them is **Verify** in the format
 * notes. Apps' classes are invented under `com.example`.
 */

export interface WorkflowDef {
  id: number;
  name: string;
  descriptor: WfDescriptor;
}

export interface WorkflowSchemeDef {
  id: number;
  name: string;
  description: string;
  /** Issue type id (null: every other type, written as `0`) to a workflow's name. */
  entries: { type: number | null; workflow: string }[];
}

export interface EventTypeDef {
  id: number;
  name: string;
  description: string;
}

export interface WorkflowWorld {
  workflows: WorkflowDef[];
  schemes: WorkflowSchemeDef[];
  /** Project id to its workflow scheme. */
  schemeOf: Map<number, number>;
  events: EventTypeDef[];
  /** The transition screen (with one tab), written beside the field screens of M1-089. */
  screen: { id: number; tab: number; name: string; fields: string[]; firstItem: number };
}

/** Ids of this part's rows in the field screen elements, clear of the ones `fields.ts` writes. */
const SCREEN_ID = FIRST_ID + 500;
/** The custom event the transitions fire; the notification schemes name it too (M1-092). */
export const ESCALATED_EVENT = 10_001;

const A = 'com.atlassian.jira.workflow.';
/** Built-in classes (Verify). */
export const CLASSES = {
  onlyAssignee: `${A}condition.AllowOnlyAssignee`,
  onlyReporter: `${A}condition.AllowOnlyReporter`,
  alwaysFalse: `${A}condition.AlwaysFalseCondition`,
  permission: `${A}condition.PermissionCondition`,
  subtaskBlocking: `${A}condition.SubTaskBlockingCondition`,
  inGroup: `${A}condition.UserInGroupCondition`,
  inGroupField: `${A}condition.InGroupCFCondition`,
  inRole: `${A}condition.InProjectRoleCondition`,
  inAnyRole: `${A}condition.InAnyProjectRoleCondition`,
  inUserField: `${A}condition.UserIsInCustomFieldCondition`,
  permissionValidator: `${A}validator.PermissionValidator`,
  userPermissionValidator: `${A}validator.UserPermissionValidator`,
  assignToCurrentUser: `${A}function.issue.AssignToCurrentUserFunction`,
  assignToLead: `${A}function.issue.AssignToLeadFunction`,
  assignToReporter: `${A}function.issue.AssignToReporterFunction`,
  updateField: `${A}function.issue.UpdateIssueFieldFunction`,
  securityFromRole: `${A}function.issue.SetIssueSecurityFromRoleFunction`,
  updateStatus: `${A}function.issue.UpdateIssueStatusFunction`,
  createComment: `${A}function.misc.CreateCommentFunction`,
  history: `${A}function.issue.GenerateChangeHistoryFunction`,
  reindex: `${A}function.issue.IssueReindexFunction`,
  fireEvent: `${A}function.event.FireIssueEventFunction`,
  create: `${A}function.issue.IssueCreateFunction`,
  webhook: 'com.atlassian.jira.plugins.webhooks.workflow.TriggerWebhookFunction',
} as const;

/** Apps' classes: invented, so nothing can map them. */
export const APP_CLASSES = {
  businessHours: 'com.example.timeclock.BusinessHoursCondition',
  scriptedValidator: 'com.example.scripts.ScriptedValidator',
  exportToSheet: 'com.example.reports.ExportToSheetFunction',
  checklistDone: 'com.example.checklists.ChecklistDoneValidator',
} as const;

const fn = (className: string, args: Record<string, string> = {}): WfFunction => ({
  type: 'class',
  className,
  args,
});
const cond = (
  className: string,
  args: Record<string, string> = {},
  negate = false,
): WfCondition => ({
  ...fn(className, args),
  negate,
});
const and = (...items: (WfConditions | WfCondition)[]): WfConditions => ({
  operator: 'AND',
  items,
});
const or = (...items: (WfConditions | WfCondition)[]): WfConditions => ({ operator: 'OR', items });

/** The functions every transition runs, firing an event (13: the generic one). */
const essentials = (event = 13): WfFunction[] => [
  fn(CLASSES.updateStatus),
  fn(CLASSES.createComment),
  fn(CLASSES.history),
  fn(CLASSES.reindex),
  fn(CLASSES.fireEvent, { eventTypeId: String(event) }),
];

interface ActionSpec {
  id: number;
  name: string;
  /** The step it moves to. */
  to: number;
  conditions?: WfConditions;
  validators?: WfFunction[];
  /** Optional functions, before the essential ones. */
  functions?: WfFunction[];
  event?: number;
  screen?: boolean;
  meta?: Record<string, string>;
  conditional?: WfResult[];
}

function action(spec: ActionSpec, screen: number): WfAction {
  return {
    id: spec.id,
    name: spec.name,
    view: spec.screen ? 'fieldscreen' : null,
    meta: {
      [META.description]: `${spec.name}, as people here do it`,
      ...(spec.screen ? { [META.screen]: String(screen) } : {}),
      ...spec.meta,
    },
    conditions: spec.conditions ?? null,
    validators: spec.validators ?? [],
    preFunctions: [],
    result: {
      step: spec.to,
      oldStatus: 'Not Done',
      status: 'Done',
      conditions: null,
      validators: [],
      postFunctions: [...(spec.functions ?? []), ...essentials(spec.event)],
    },
    conditionalResults: spec.conditional ?? [],
    postFunctions: [],
  };
}

function initial(step: number, validators: WfFunction[] = []): WfAction {
  return {
    id: 1,
    name: 'Create',
    view: null,
    meta: {},
    conditions: null,
    validators,
    preFunctions: [],
    result: {
      step,
      oldStatus: 'null',
      status: 'open',
      conditions: null,
      validators: [],
      postFunctions: [
        fn(CLASSES.create),
        fn(CLASSES.reindex),
        fn(CLASSES.fireEvent, { eventTypeId: '1' }),
      ],
    },
    conditionalResults: [],
    postFunctions: [],
  };
}

/** One step per status, numbered from 1 in the statuses' order. */
function steps(
  statuses: readonly Status[],
  actions: Record<string, { own?: WfAction[]; common?: number[]; meta?: Record<string, string> }>,
): WfStep[] {
  return statuses.map((s, k) => ({
    id: k + 1,
    name: s.name,
    meta: { [META.status]: String(s.id), ...(actions[s.name]?.meta ?? {}) },
    actions: actions[s.name]?.own ?? [],
    commonActions: actions[s.name]?.common ?? [],
  }));
}

const built = new WeakMap<World, WorkflowWorld>();

export function workflowWorldOf(world: World): WorkflowWorld {
  let out = built.get(world);
  if (!out) {
    out = buildWorkflowWorld(world);
    built.set(world, out);
  }
  return out;
}

function buildWorkflowWorld(world: World): WorkflowWorld {
  const statuses = world.statuses;
  const step = (name: string) => statuses.findIndex((s) => s.name === name) + 1;
  const statusId = (name: string) => String((statuses.find((s) => s.name === name) as Status).id);
  const [managers, contributors] = world.roles.map((r) => String(r.id)) as [string, string, string];
  const groups = world.groups as Group[];
  const team = ((groups[1] ?? groups[0]) as Group).name;
  const lastTeam = ((groups[groups.length - 1] ?? groups[0]) as Group).name;
  const fields = fieldWorldOf(world).fields;
  const cf = (name: string) =>
    customFieldKey((fields.find((f) => f.name === name) as { id: number }).id);
  const type = (name: string) => (world.issueTypes.find((t) => t.name === name) as IssueType).id;
  const screen = SCREEN_ID;
  const a = (spec: ActionSpec) => action(spec, screen);
  const reopen = (id: number) =>
    a({
      id,
      name: 'Reopen',
      to: step('Backlog'),
      // Clearing the resolution: an empty value.
      functions: [fn(CLASSES.updateField, { 'field.name': 'resolution', 'field.value': '' })],
      meta: { 'opsbar-sequence': '90' },
    });

  const delivery: WfDescriptor = {
    meta: { [META.description]: 'How software work moves from the backlog to done' },
    initialActions: [
      initial(step('Backlog'), [
        fn(CLASSES.permissionValidator, { permissionKey: 'CREATE_ISSUES' }),
      ]),
    ],
    globalActions: [
      a({
        id: 61,
        name: 'Decline',
        to: step('Declined'),
        screen: true,
        conditions: and(cond(CLASSES.permission, { permissionKey: 'RESOLVE_ISSUES' })),
      }),
      a({
        id: 62,
        name: 'Escalate',
        to: step('In Review'),
        event: ESCALATED_EVENT,
        conditions: and(cond(APP_CLASSES.businessHours, { zone: 'Europe/Madrid' })),
      }),
    ],
    commonActions: [reopen(51)],
    steps: steps(statuses, {
      Backlog: {
        own: [
          a({
            id: 11,
            name: 'Select',
            to: step('Selected'),
            conditions: or(
              cond(CLASSES.inRole, { 'jira.projectrole.id': managers }),
              cond(CLASSES.inGroup, { group: team }),
            ),
            meta: { 'opsbar-sequence': '10' },
          }),
        ],
      },
      Selected: {
        own: [
          a({
            id: 21,
            name: 'Start work',
            to: step('Working'),
            conditions: and(cond(CLASSES.permission, { permissionKey: 'TRANSITION_ISSUES' })),
            functions: [fn(CLASSES.assignToCurrentUser)],
            event: 11,
            meta: { 'opsbar-sequence': '20' },
          }),
          a({
            id: 22,
            name: 'Retire path',
            to: step('Backlog'),
            conditions: and(cond(CLASSES.alwaysFalse)),
          }),
        ],
      },
      Working: {
        own: [
          a({
            id: 31,
            name: 'Send to review',
            to: step('In Review'),
            conditions: and(cond(CLASSES.onlyAssignee)),
            validators: [
              fn(CLASSES.permissionValidator, { permissionKey: 'EDIT_ISSUES' }),
              fn(APP_CLASSES.scriptedValidator, { script: 'issue.summary.length() > 5' }),
            ],
          }),
        ],
      },
      'In Review': {
        meta: { [`${META.permission}comment.projectrole`]: contributors },
        own: [
          a({
            id: 41,
            name: 'Approve',
            to: step('Finished'),
            screen: true,
            conditions: and(
              cond(CLASSES.subtaskBlocking, {
                statuses: `${statusId('Finished')},${statusId('Declined')}`,
              }),
              or(
                cond(CLASSES.inRole, { 'jira.projectrole.id': managers }),
                cond(CLASSES.onlyReporter),
              ),
            ),
            functions: [fn(APP_CLASSES.exportToSheet, { sheet: 'done-log' })],
            // Taken instead of the unconditional result when someone of the last team approves.
            conditional: [
              {
                step: step('Declined'),
                oldStatus: 'Not Done',
                status: 'Done',
                conditions: and(cond(CLASSES.inGroup, { group: lastTeam })),
                validators: [],
                postFunctions: essentials(),
              },
            ],
          }),
          a({
            id: 42,
            name: 'Rework',
            to: step('Working'),
            functions: [fn(CLASSES.updateField, { 'field.name': 'assignee', 'field.value': '' })],
          }),
        ],
      },
      Finished: { meta: { [META.editable]: 'false' }, common: [51] },
      Declined: { meta: { [`${META.permission}delete.group`]: team }, common: [51] },
    }),
  };

  const defect: WfDescriptor = {
    meta: { [META.description]: 'Defects from report to fix' },
    initialActions: [initial(step('Backlog'))],
    globalActions: [],
    commonActions: [reopen(151)],
    steps: steps(statuses, {
      Backlog: {
        own: [
          a({
            id: 111,
            name: 'Accept',
            to: step('Selected'),
            conditions: and(cond(CLASSES.inGroup, { group: team })),
            functions: [
              fn(CLASSES.securityFromRole, {
                'jira.projectrole.id': managers,
                'jira.securitylevel.id': '10000',
              }),
            ],
          }),
          a({
            id: 112,
            name: 'Reject',
            to: step('Declined'),
            screen: true,
            functions: [fn(CLASSES.assignToReporter)],
          }),
        ],
      },
      Selected: {
        own: [
          a({
            id: 121,
            name: 'Fix',
            to: step('Working'),
            functions: [fn(CLASSES.assignToCurrentUser)],
          }),
        ],
      },
      Working: {
        own: [
          a({
            id: 131,
            name: 'Verify',
            to: step('In Review'),
            conditions: and(cond(CLASSES.inUserField, { fieldName: cf('Reviewer') })),
            validators: [
              fn(CLASSES.userPermissionValidator, {
                permissionKey: 'RESOLVE_ISSUES',
                'vars.key': 'pkey',
              }),
            ],
          }),
        ],
      },
      'In Review': {
        own: [
          a({
            id: 141,
            name: 'Close',
            to: step('Finished'),
            screen: true,
            // The reporter may not close their own defect.
            conditions: and(
              cond(CLASSES.onlyReporter, {}, true),
              cond(CLASSES.permission, { permissionKey: 'CLOSE_ISSUES' }),
            ),
            functions: [fn(CLASSES.webhook, { 'field.webhookId': '7' })],
          }),
        ],
      },
      Finished: { common: [151] },
      Declined: { common: [151] },
    }),
  };

  const stepFlow: WfDescriptor = {
    meta: { [META.description]: 'Small steps of a larger issue' },
    initialActions: [initial(step('Backlog'))],
    globalActions: [
      a({
        id: 201,
        name: 'Start',
        to: step('Working'),
        functions: [fn(CLASSES.assignToCurrentUser)],
      }),
      a({ id: 202, name: 'Done', to: step('Finished') }),
      a({ id: 203, name: 'Drop', to: step('Declined') }),
      a({
        id: 204,
        name: 'Reset',
        to: step('Backlog'),
        functions: [fn(CLASSES.updateField, { 'field.name': 'resolution', 'field.value': '' })],
      }),
    ],
    commonActions: [],
    steps: steps(statuses, {
      Backlog: { own: [a({ id: 211, name: 'Plan', to: step('Selected') })] },
      Working: {
        own: [
          a({
            id: 231,
            name: 'Review',
            to: step('In Review'),
            functions: [
              { type: 'beanshell', className: null, args: { script: 'issue.setPriorityId("3")' } },
            ],
          }),
        ],
      },
    }),
  };

  const business: WfDescriptor = {
    meta: { [META.description]: 'Requests in business projects' },
    initialActions: [initial(step('Backlog'))],
    globalActions: [a({ id: 301, name: 'Decline', to: step('Declined'), screen: true })],
    commonActions: [reopen(351)],
    steps: steps(statuses, {
      Backlog: {
        own: [
          a({
            id: 311,
            name: 'Plan',
            to: step('Selected'),
            conditions: and(
              cond(CLASSES.inAnyRole, { 'jira.projectrole.ids': `${managers},${contributors}` }),
            ),
          }),
        ],
      },
      Selected: {
        own: [
          a({ id: 321, name: 'Start', to: step('Working'), functions: [fn(CLASSES.assignToLead)] }),
        ],
      },
      Working: {
        own: [
          a({
            id: 331,
            name: 'Review',
            to: step('In Review'),
            conditions: and(cond(CLASSES.onlyAssignee)),
          }),
        ],
      },
      'In Review': {
        own: [
          a({
            id: 341,
            name: 'Complete',
            to: step('Finished'),
            conditions: or(
              cond(CLASSES.inGroupField, { groupcf: cf('Owning group') }),
              cond(CLASSES.inGroup, { group: team }),
            ),
            validators: [fn(APP_CLASSES.checklistDone)],
            functions: [
              fn(CLASSES.updateField, {
                'field.name': 'priority',
                'field.value': String(world.priorities[2]?.id),
              }),
            ],
          }),
        ],
      },
      Finished: { common: [351] },
      Declined: { common: [351] },
    }),
  };

  const archived: WfDescriptor = {
    meta: { [META.description]: 'An old flow no project uses' },
    initialActions: [initial(1)],
    globalActions: [],
    commonActions: [],
    steps: [
      {
        id: 1,
        name: 'Backlog',
        meta: { [META.status]: statusId('Backlog') },
        commonActions: [],
        actions: [
          a({
            id: 401,
            name: 'Finish',
            to: 2,
            conditions: and(cond(APP_CLASSES.businessHours, { zone: 'UTC' })),
          }),
        ],
      },
      {
        id: 2,
        name: 'Finished',
        meta: { [META.status]: statusId('Finished') },
        commonActions: [],
        actions: [],
      },
    ],
  };

  // Descriptions live in the descriptors' meta: the row has none (Verify).
  const workflows: WorkflowDef[] = [
    { id: FIRST_ID, name: 'Delivery flow', descriptor: delivery },
    { id: FIRST_ID + 1, name: 'Defect flow', descriptor: defect },
    { id: FIRST_ID + 2, name: 'Step flow', descriptor: stepFlow },
    { id: FIRST_ID + 3, name: 'Business flow', descriptor: business },
    // The same as the first but for its name: the import merges them (IMP-005).
    { id: FIRST_ID + 4, name: 'Delivery flow (copy)', descriptor: delivery },
    { id: FIRST_ID + 5, name: 'Archived flow', descriptor: archived },
  ];
  const schemes: WorkflowSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Software workflows',
      description: 'Software projects',
      entries: [
        { type: null, workflow: 'Delivery flow' },
        { type: type('Defect'), workflow: 'Defect flow' },
        { type: type('Step'), workflow: 'Step flow' },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Business workflows',
      description: 'Business projects',
      entries: [
        { type: null, workflow: 'Business flow' },
        { type: type('Step'), workflow: 'Step flow' },
      ],
    },
    {
      id: FIRST_ID + 2,
      name: 'Legacy software workflows',
      description: 'Older software projects',
      entries: [
        { type: null, workflow: 'Delivery flow (copy)' },
        { type: type('Defect'), workflow: 'Defect flow' },
        { type: type('Step'), workflow: 'Step flow' },
      ],
    },
  ];
  // Business projects use the business scheme; the third project the legacy one.
  const schemeOf = new Map<number, number>();
  for (const p of world.projects) {
    schemeOf.set(
      p.id,
      p.type === 'business' ? FIRST_ID + 1 : p.index === 2 ? FIRST_ID + 2 : FIRST_ID,
    );
  }
  return {
    workflows,
    schemes,
    schemeOf,
    events: [
      { id: ESCALATED_EVENT, name: 'Escalated', description: 'Someone asked for attention' },
    ],
    screen: {
      id: screen,
      tab: screen,
      name: 'Close screen',
      fields: ['resolution', 'assignee', 'fixVersions', 'timetracking', cf('Effort')],
      firstItem: screen,
    },
  };
}

/** The workflow a project's scheme gives an issue type, by name. */
export function workflowFor(ww: WorkflowWorld, projectId: number, typeId: number): WorkflowDef {
  const scheme = ww.schemes.find((s) => s.id === ww.schemeOf.get(projectId)) as WorkflowSchemeDef;
  const entry =
    scheme.entries.find((e) => e.type === typeId) ?? scheme.entries.find((e) => e.type === null);
  return ww.workflows.find((w) => w.name === entry?.workflow) as WorkflowDef;
}

/** What the writer needs of the generator's row writer. */
export interface RowWriter {
  row(
    name: EntityName,
    values: Record<string, string | number | null | undefined | { text: string }>,
  ): Promise<void>;
  note(name: string, by?: number): void;
}

/** The workflow elements, and this part's rows of the screen and association elements. */
export async function writeWorkflowEntity(
  world: World,
  w: RowWriter,
  name: EntityName,
): Promise<void> {
  const ww = workflowWorldOf(world);
  switch (name) {
    case 'Workflow':
      for (const x of ww.workflows) {
        for (const [k, n] of Object.entries(workflowCases(x.descriptor))) w.note(k, n);
        await w.row(name, {
          id: x.id,
          name: x.name,
          creatorname: world.users[0]?.username,
          descriptor: { text: writeDescriptor(x.descriptor) },
        });
      }
      return;
    case 'WorkflowScheme':
      for (const s of ww.schemes)
        await w.row(name, { id: s.id, name: s.name, description: s.description });
      return;
    case 'WorkflowSchemeEntity': {
      let id = FIRST_ID;
      for (const s of ww.schemes) {
        for (const e of s.entries) {
          await w.row(name, {
            id: id++,
            scheme: s.id,
            workflow: e.workflow,
            issuetype: e.type === null ? ALL_OTHER_TYPES : String(e.type),
          });
        }
      }
      return;
    }
    case 'EventType':
      for (const e of ww.events) {
        await w.row(name, {
          id: e.id,
          name: e.name,
          description: e.description,
          type: CUSTOM_EVENT_TYPE,
        });
      }
      return;
    case 'FieldScreen':
      await w.row(name, {
        id: ww.screen.id,
        name: ww.screen.name,
        description: 'Asked when work closes',
      });
      return;
    case 'FieldScreenTab':
      await w.row(name, {
        id: ww.screen.tab,
        name: 'Close',
        sequence: 0,
        fieldscreen: ww.screen.id,
      });
      return;
    case 'FieldScreenLayoutItem':
      for (const [k, field] of ww.screen.fields.entries()) {
        await w.row(name, {
          id: ww.screen.firstItem + k,
          fieldidentifier: field,
          sequence: k,
          fieldscreentab: ww.screen.tab,
        });
      }
      return;
    case 'NodeAssociation':
      for (const project of world.projects) {
        const sink = ww.schemeOf.get(project.id);
        if (sink === undefined) continue;
        await w.row(name, {
          sourceNodeId: project.id,
          sourceNodeEntity: 'Project',
          sinkNodeId: sink,
          sinkNodeEntity: 'WorkflowScheme',
          associationType: PROJECT_SCHEME,
        });
      }
      return;
  }
}
