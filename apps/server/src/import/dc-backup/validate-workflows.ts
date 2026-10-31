import {
  ALL_OTHER_TYPES,
  actionsOf,
  DescriptorError,
  FIRST_CUSTOM_EVENT,
  META,
  parseDescriptor,
  rulesOf,
  SYSTEM_WORKFLOW,
  type WfDescriptor,
  workflowCases,
} from './workflow-format';

/**
 * The validator's workflow checks (M1-090): every descriptor reads, each step names a status
 * row once, action ids are unique, results go to steps of the workflow, shared actions exist,
 * screens, groups, roles and custom events named by a workflow have rows, scheme entities name
 * workflows and issue types, and every issue's status is a step of the workflow its project's
 * scheme gives its type. It also counts the cases the manifest lists from the descriptors it
 * reads, so the writer and the reader must agree.
 */
interface Ids {
  has(id: number): boolean;
}

export interface WorkflowCheckContext {
  ids: (entity: string) => Ids | undefined;
  groupNames: ReadonlySet<string>;
  /** Scheme rows each project names (`NodeAssociation`). */
  associations: readonly { entity: string; id: number; project: number }[];
}

type Problem = (message: string) => void;

export class WorkflowChecks {
  private readonly workflows: { id: string; name: string; descriptor: WfDescriptor | string }[] =
    [];
  private readonly entities: { scheme: string; workflow: string; type: string; id: string }[] = [];
  private readonly events = new Set<number>();
  /** `project:type:status` of every issue, counted. */
  private readonly issues = new Map<string, number>();

  /** Called for every row; reads the ones of this part. */
  row(name: string, v: Record<string, string>, note: (key: string, by: number) => void): void {
    switch (name) {
      case 'Workflow': {
        let descriptor: WfDescriptor | string;
        try {
          descriptor = parseDescriptor(v.descriptor ?? '');
          for (const [k, n] of Object.entries(workflowCases(descriptor))) note(k, n);
        } catch (error) {
          descriptor = error instanceof DescriptorError ? error.message : String(error);
        }
        this.workflows.push({ id: v.id ?? '', name: v.name ?? '', descriptor });
        return;
      }
      case 'WorkflowSchemeEntity':
        this.entities.push({
          id: v.id ?? '',
          scheme: v.scheme ?? '',
          workflow: v.workflow ?? '',
          type: v.issuetype ?? '',
        });
        return;
      case 'EventType':
        this.events.add(Number(v.id));
        return;
      case 'Issue': {
        const key = `${v.project}:${v.type}:${v.status}`;
        this.issues.set(key, (this.issues.get(key) ?? 0) + 1);
        return;
      }
    }
  }

  check(ctx: WorkflowCheckContext, problem: Problem): void {
    const has = (entity: string, id: string) =>
      /^\d+$/.test(id) && (ctx.ids(entity)?.has(Number(id)) ?? false);
    const statusesOf = new Map<string, Set<string>>();
    for (const w of this.workflows) {
      const where = `Workflow ${w.id} (${w.name.slice(0, 60)})`;
      if (typeof w.descriptor === 'string') {
        problem(`${where}: the descriptor does not read: ${w.descriptor.slice(0, 120)}`);
        continue;
      }
      const d = w.descriptor;
      const steps = new Map<number, string>();
      const statuses = new Set<string>();
      for (const s of d.steps) {
        const status = s.meta[META.status];
        if (steps.has(s.id)) problem(`${where}: step ${s.id} twice`);
        if (status === undefined) problem(`${where}: step ${s.id} names no status`);
        else if (!has('Status', status))
          problem(`${where}: step ${s.id} names status ${status}, which has no row`);
        else if (statuses.has(status)) problem(`${where}: status ${status} is on two steps`);
        else statuses.add(status);
        steps.set(s.id, status ?? '');
      }
      statusesOf.set(w.name, statuses);
      if (d.initialActions.length === 0) problem(`${where}: no initial action`);
      const actionIds = new Set<number>();
      const common = new Set(d.commonActions.map((a) => a.id));
      for (const { action, step } of actionsOf(d)) {
        const at = `${where} action ${action.id}`;
        if (actionIds.has(action.id)) problem(`${at}: the id is used twice`);
        actionIds.add(action.id);
        if (step && common.has(action.id))
          problem(`${at}: a step's own action uses a common action's id`);
        for (const r of [action.result, ...action.conditionalResults]) {
          if (r && (r.step === null || !steps.has(r.step)))
            problem(`${at}: goes to step ${r.step}, which the workflow lacks`);
        }
        if (!action.result) problem(`${at}: no unconditional result`);
        const screen = action.meta[META.screen];
        if (screen !== undefined && !has('FieldScreen', screen))
          problem(`${at}: screen ${screen} has no row`);
        for (const { rule } of rulesOf(action)) {
          for (const [k, v] of Object.entries(rule.args)) {
            if (k === 'group' && !ctx.groupNames.has(v))
              problem(`${at}: group ${v.slice(0, 60)} has no row`);
            if (k === 'jira.projectrole.id' && !has('ProjectRole', v))
              problem(`${at}: role ${v} has no row`);
            if (
              k === 'eventTypeId' &&
              Number(v) >= FIRST_CUSTOM_EVENT &&
              !this.events.has(Number(v))
            ) {
              problem(`${at}: event ${v} has no EventType row`);
            }
          }
        }
      }
      for (const s of d.steps) {
        for (const c of s.commonActions) {
          if (!common.has(c))
            problem(`${where}: step ${s.id} offers common action ${c}, which the workflow lacks`);
        }
      }
    }

    // Schemes: entities name workflows and types; one default each at most.
    const names = new Set(this.workflows.map((w) => w.name));
    const defaults = new Map<string, number>();
    for (const e of this.entities) {
      const at = `WorkflowSchemeEntity ${e.id}`;
      if (!names.has(e.workflow) && e.workflow !== SYSTEM_WORKFLOW)
        problem(`${at}: workflow ${e.workflow.slice(0, 60)} has no row`);
      if (e.type === ALL_OTHER_TYPES) defaults.set(e.scheme, (defaults.get(e.scheme) ?? 0) + 1);
      else if (!has('IssueType', e.type))
        problem(`${at}: issue type ${e.type.slice(0, 20)} has no row`);
    }
    for (const [scheme, n] of defaults)
      if (n > 1) problem(`WorkflowScheme ${scheme}: ${n} default entities`);

    // Each issue's status is a step of its workflow (projects without a scheme use the built-in
    // workflow, whose steps the backup does not hold).
    const schemeOf = new Map<string, string>();
    for (const a of ctx.associations)
      if (a.entity === 'WorkflowScheme') schemeOf.set(String(a.project), String(a.id));
    let outside = 0;
    let example = '';
    for (const [key, count] of this.issues) {
      const [project, type, status] = key.split(':') as [string, string, string];
      const scheme = schemeOf.get(project);
      if (scheme === undefined) continue;
      const mine = this.entities.filter((e) => e.scheme === scheme);
      const workflow = (
        mine.find((e) => e.type === type) ?? mine.find((e) => e.type === ALL_OTHER_TYPES)
      )?.workflow;
      const steps = workflow === undefined ? undefined : statusesOf.get(workflow);
      if (steps && !steps.has(status)) {
        outside += count;
        example = `project ${project}, type ${type}, status ${status}`;
      }
    }
    if (outside > 0)
      problem(`${outside} issues are in a status their workflow lacks (for example ${example})`);
  }
}
