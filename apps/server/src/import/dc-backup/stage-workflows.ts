import type { StagedScreen } from './stage-fields';
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
  WORKFLOW_ELEMENTS,
} from './workflow-format';

/**
 * The workflow part of the stage (M1-090; IMP-004, IMP-005; ADR-093): workflows with their
 * descriptors read into the format's model, workflow schemes with their entities, custom
 * events, and the projects using each scheme. All small: kept, and resolved after the file.
 * Each workflow carries what its steps and rules name (statuses, groups, roles, screens,
 * custom events) resolved against the rest of the backup, so the mapper (`../dc-workflows.ts`)
 * can leave out what is missing instead of guessing. Identical workflows (names and
 * descriptions aside) merge into the one with the lowest id, and so do the schemes that become
 * identical with them. A scheme that names the built-in workflow, which the backup does not
 * hold, gets a record of it that the mapper links to the target's default workflow.
 */
export { WORKFLOW_ELEMENTS };

export interface StagedWorkflowRefs {
  /** Status ids the descriptor names that have a row. */
  statuses: string[];
  /** Group names as written to staged ids (lower-case names), null when there is no row. */
  groups: Record<string, string | null>;
  /** Role ids the descriptor names that have a row. */
  roles: string[];
  /** Screens by id, null when there is no row. */
  screens: Record<string, StagedScreen | null>;
  /** Custom events by id, with their names. */
  events: Record<string, string>;
}

export interface StagedWorkflow {
  id: string;
  name: string;
  description: string;
  /** The built-in workflow, named by a scheme but not in the backup. */
  system: boolean;
  descriptor: WfDescriptor | null;
  /** Why the descriptor could not be read. */
  problem: string | null;
  refs: StagedWorkflowRefs;
  /** The workflow this one repeats (names and descriptions aside). */
  mergedInto: { id: string; name: string } | null;
  /** Any status of the backup, for the built-in workflow's stand-in definition. */
  someStatus: string | null;
}

export interface StagedWorkflowScheme {
  id: string;
  name: string;
  description: string;
  /** The workflow of every type the entries do not name (staged id). */
  defaultWorkflow: string;
  entries: { type: string; workflow: string }[];
  /** Entities left out, with why. */
  problems: { code: string; detail: string }[];
  /** Project ids using it, the merged schemes' included. */
  tracks: string[];
  mergedInto: { id: string; name: string } | null;
}

interface Named {
  id: string;
  name: string;
  description: string;
}

const byId = <T extends { id: string }>(rows: Iterable<T>) =>
  [...rows].sort(
    (a, b) => Number(a.id) - Number(b.id) || String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );
const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

export class WorkflowCollector {
  private readonly workflows = new Map<string, Named & { descriptor: string }>();
  private readonly schemes = new Map<string, Named>();
  private readonly entities: { id: string; scheme: string; workflow: string; type: string }[] = [];
  private readonly events = new Map<string, string>();
  private readonly parsed = new Map<string, WfDescriptor | DescriptorError>();

  row(name: string, v: Record<string, string>): void {
    const id = v.id ?? '';
    switch (name) {
      case 'Workflow':
        this.workflows.set(id, {
          id,
          name: v.name ?? '',
          description: v.description ?? '',
          descriptor: v.descriptor ?? '',
        });
        return;
      case 'WorkflowScheme':
        this.schemes.set(id, { id, name: v.name ?? '', description: v.description ?? '' });
        return;
      case 'WorkflowSchemeEntity':
        this.entities.push({
          id,
          scheme: v.scheme ?? '',
          workflow: v.workflow ?? '',
          type: v.issuetype ?? ALL_OTHER_TYPES,
        });
        return;
      case 'EventType':
        if (v.name) this.events.set(id, v.name);
        return;
    }
  }

  private descriptor(id: string): WfDescriptor | DescriptorError {
    let out = this.parsed.get(id);
    if (!out) {
      try {
        out = parseDescriptor(this.workflows.get(id)?.descriptor ?? '');
      } catch (error) {
        out = error instanceof DescriptorError ? error : new DescriptorError(String(error));
      }
      this.parsed.set(id, out);
    }
    return out;
  }

  /** Custom event ids to their names (notification schemes name them too). */
  eventNames(): ReadonlyMap<number, string> {
    return new Map([...this.events].map(([id, name]) => [Number(id), name]));
  }

  /** Status ids some workflow's step names. */
  statusesInWorkflows(): Set<string> {
    const out = new Set<string>();
    for (const id of this.workflows.keys()) {
      const d = this.descriptor(id);
      if (d instanceof DescriptorError) continue;
      for (const s of d.steps) {
        const status = s.meta[META.status];
        if (status !== undefined) out.add(status);
      }
    }
    return out;
  }

  resolve(
    projects: ReadonlySet<string>,
    associations: ReadonlyMap<string, Map<string, string[]>>,
    refs: {
      statuses: ReadonlySet<string>;
      types: ReadonlySet<string>;
      roles: ReadonlySet<string>;
      group: (raw: string) => string | null;
      screen: (id: string) => StagedScreen | null;
    },
  ) {
    const someStatus = [...refs.statuses].sort((a, b) => Number(a) - Number(b))[0] ?? null;
    const named = (d: WfDescriptor): StagedWorkflowRefs => {
      const out: StagedWorkflowRefs = {
        statuses: [],
        groups: {},
        roles: [],
        screens: {},
        events: {},
      };
      const status = (v: string) => {
        if (refs.statuses.has(v) && !out.statuses.includes(v)) out.statuses.push(v);
      };
      const role = (v: string) => {
        if (refs.roles.has(v) && !out.roles.includes(v)) out.roles.push(v);
      };
      const value = (key: string, v: string) => {
        if (key === 'group' || key.endsWith('.group')) out.groups[v] = refs.group(v);
        else if (key === 'jira.projectrole.id' || key.endsWith('.projectrole')) role(v);
        else if (key === 'jira.projectrole.ids') list(v).forEach(role);
        else if (key === 'statuses') list(v).forEach(status);
        else if (key === META.status) status(v);
        else if (key === META.screen) out.screens[v] = refs.screen(v);
        else if (key === 'eventTypeId' && Number(v) >= FIRST_CUSTOM_EVENT) {
          const name = this.events.get(v);
          if (name !== undefined) out.events[v] = name;
        }
      };
      for (const s of d.steps) for (const [k, v] of Object.entries(s.meta)) value(k, v);
      for (const { action } of actionsOf(d)) {
        for (const [k, v] of Object.entries(action.meta)) value(k, v);
        for (const { rule } of rulesOf(action))
          for (const [k, v] of Object.entries(rule.args)) value(k, v);
      }
      out.statuses.sort((a, b) => Number(a) - Number(b));
      out.roles.sort((a, b) => Number(a) - Number(b));
      return out;
    };
    const empty: StagedWorkflowRefs = {
      statuses: [],
      groups: {},
      roles: [],
      screens: {},
      events: {},
    };

    // Workflows, identical ones merged into the first (by id).
    const first = new Map<string, Named>();
    const into = new Map<string, Named>();
    const workflows: { id: string; label: string; data: StagedWorkflow }[] = [];
    for (const w of byId(this.workflows.values())) {
      const d = this.descriptor(w.id);
      const ok = !(d instanceof DescriptorError);
      if (ok) {
        const print = JSON.stringify({ ...d, meta: {} });
        const earlier = first.get(print);
        if (earlier) into.set(w.id, earlier);
        else first.set(print, w);
      }
      const merged = into.get(w.id) ?? null;
      workflows.push({
        id: w.id,
        label: w.name,
        data: {
          id: w.id,
          name: w.name,
          description: w.description || (ok ? (d.meta[META.description] ?? '') : ''),
          system: false,
          descriptor: ok && !merged ? d : null,
          problem: ok ? null : d.message,
          refs: ok && !merged ? named(d) : empty,
          mergedInto: merged ? { id: merged.id, name: merged.name } : null,
          someStatus: null,
        },
      });
    }
    const byName = new Map<string, string>();
    for (const w of byId(this.workflows.values())) {
      if (!byName.has(w.name)) byName.set(w.name, w.id);
      if (!byName.has(w.name.toLowerCase())) byName.set(w.name.toLowerCase(), w.id);
    }
    let systemNamed = false;
    /** A workflow named by a scheme entity, as the staged id it ends in; null when unknown. */
    const workflowNamed = (name: string): string | null => {
      const id = byName.get(name) ?? byName.get(name.toLowerCase());
      if (id !== undefined) return into.get(id)?.id ?? id;
      if (name.toLowerCase() === SYSTEM_WORKFLOW) {
        systemNamed = true;
        return SYSTEM_WORKFLOW;
      }
      return null;
    };

    const tracksOf = (id: string) =>
      (associations.get('WorkflowScheme')?.get(id) ?? []).filter((p) => projects.has(p));
    const raw = byId(this.schemes.values()).map((s) => {
      const problems: StagedWorkflowScheme['problems'] = [];
      let defaultWorkflow: string | null = null;
      const entries: StagedWorkflowScheme['entries'] = [];
      for (const e of byId(this.entities.filter((x) => x.scheme === s.id))) {
        const workflow = workflowNamed(e.workflow);
        if (workflow === null) {
          problems.push({ code: 'workflow_not_found', detail: e.workflow });
          continue;
        }
        if (e.type === ALL_OTHER_TYPES || e.type === '') {
          defaultWorkflow ??= workflow;
        } else if (!refs.types.has(e.type)) {
          problems.push({ code: 'issue_type_not_found', detail: e.type });
        } else if (!entries.some((x) => x.type === e.type)) {
          entries.push({ type: e.type, workflow });
        }
      }
      // Types no entity names use the built-in workflow (Verify).
      defaultWorkflow ??= workflowNamed(SYSTEM_WORKFLOW) as string;
      entries.sort((a, b) => Number(a.type) - Number(b.type));
      return { s, defaultWorkflow, entries, problems };
    });
    // Schemes that are the same once their workflows merged, merged into the first.
    const firstScheme = new Map<string, Named>();
    const schemes = raw.map(({ s, defaultWorkflow, entries, problems }) => {
      const print = JSON.stringify({ defaultWorkflow, entries });
      const earlier = firstScheme.get(print) ?? null;
      if (!earlier) firstScheme.set(print, s);
      return { s, defaultWorkflow, entries, problems, earlier };
    });
    const maps = schemes.map(({ s, defaultWorkflow, entries, problems, earlier }) => {
      const merged = schemes.filter((x) => x.earlier?.id === s.id).map((x) => x.s.id);
      const data: StagedWorkflowScheme = {
        id: s.id,
        name: s.name,
        description: s.description,
        defaultWorkflow,
        entries,
        problems,
        tracks: earlier
          ? []
          : [s.id, ...merged].flatMap(tracksOf).sort((a, b) => Number(a) - Number(b)),
        mergedInto: earlier ? { id: earlier.id, name: earlier.name } : null,
      };
      return { id: s.id, label: s.name, data };
    });
    if (systemNamed && !this.workflows.has(SYSTEM_WORKFLOW)) {
      workflows.unshift({
        id: SYSTEM_WORKFLOW,
        label: SYSTEM_WORKFLOW,
        data: {
          id: SYSTEM_WORKFLOW,
          name: SYSTEM_WORKFLOW,
          description: '',
          system: true,
          descriptor: null,
          problem: null,
          refs: empty,
          mergedInto: null,
          someStatus,
        },
      });
    }
    return { workflow: workflows, workflow_map: maps };
  }
}
