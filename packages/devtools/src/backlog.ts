import { parseCsvRecords } from './csv';

export interface Task {
  id: string;
  milestone: string;
  epic: string;
  title: string;
  dependsOn: string[];
  doneWhen: string;
  size: string;
  modules: string;
}

export type TaskState = 'todo' | 'in-progress' | 'done' | 'waiting-on-user';

export interface ProgressEntry {
  id: string;
  state: Exclude<TaskState, 'todo'>;
  date: string;
  note: string;
}

const TASK_ID = /^M(\d+)-(\d+)$/;

/**
 * Parses a "Depends on" cell: IDs separated by semicolons or commas, ranges written
 * `M2-001..M2-020` (same milestone, inclusive), or "None"/empty for no dependencies.
 */
export function parseDependencies(cell: string): string[] {
  const text = cell.trim();
  if (text === '' || /^none$/i.test(text)) return [];
  const ids: string[] = [];
  for (const raw of text.split(/[;,]/)) {
    const part = raw.trim();
    if (part === '') continue;
    const [from, to, ...rest] = part.split('..').map((s) => s.trim());
    if (rest.length > 0 || from === undefined) throw new Error(`Bad dependency "${part}"`);
    if (to === undefined) {
      if (!TASK_ID.test(from)) throw new Error(`Bad task ID "${from}"`);
      ids.push(from);
      continue;
    }
    const a = TASK_ID.exec(from);
    const b = TASK_ID.exec(to);
    if (!a || !b) throw new Error(`Bad range "${part}"`);
    if (a[1] !== b[1]) throw new Error(`Range "${part}" spans milestones`);
    const start = Number(a[2]);
    const end = Number(b[2]);
    if (end < start) throw new Error(`Range "${part}" runs backwards`);
    const width = a[2]?.length ?? 3;
    for (let n = start; n <= end; n++) ids.push(`M${a[1]}-${String(n).padStart(width, '0')}`);
  }
  return ids;
}

export function parseBacklog(csvText: string): Task[] {
  return parseCsvRecords(csvText).map((r) => {
    const id = (r['Task ID'] ?? '').trim();
    if (!TASK_ID.test(id)) throw new Error(`Bad task ID "${id}" in backlog`);
    return {
      id,
      milestone: r.Milestone ?? '',
      epic: r.Epic ?? '',
      title: r.Task ?? '',
      dependsOn: parseDependencies(r['Depends on'] ?? ''),
      doneWhen: r['Done when'] ?? '',
      size: r.Size ?? '',
      modules: r.Modules ?? '',
    };
  });
}

const STATES = new Set(['in-progress', 'done', 'waiting-on-user']);

export function parseProgress(csvText: string): ProgressEntry[] {
  return parseCsvRecords(csvText).map((r) => {
    const state = (r.State ?? '').trim();
    if (!STATES.has(state)) throw new Error(`Unknown state "${state}" for ${r['Task ID']}`);
    return {
      id: (r['Task ID'] ?? '').trim(),
      state: state as ProgressEntry['state'],
      date: r.Date ?? '',
      note: r.Note ?? '',
    };
  });
}

/** Problems that make the backlog unusable: duplicate IDs, unknown dependencies, cycles. */
export function validateBacklog(tasks: readonly Task[], progress: readonly ProgressEntry[] = []) {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) problems.push(`Duplicate task ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) problems.push(`${t.id} depends on unknown task ${d}`);
      if (d === t.id) problems.push(`${t.id} depends on itself`);
    }
  }
  for (const p of progress) {
    if (!ids.has(p.id)) problems.push(`Progress entry for unknown task ${p.id}`);
  }
  const cycle = findCycle(tasks);
  if (cycle) problems.push(`Dependency cycle: ${cycle.join(' -> ')}`);
  return problems;
}

function findCycle(tasks: readonly Task[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const t of tasks) {
    const found = visit(t.id);
    if (found) return found;
  }
  return undefined;
}

export interface Plan {
  /** Started but not finished: resume these first. */
  inProgress: Task[];
  /** Not started, every dependency done; in backlog order. */
  ready: Task[];
  /** Need something from the user before they can continue. */
  waitingOnUser: Task[];
  done: number;
  total: number;
}

export function planWork(tasks: readonly Task[], progress: readonly ProgressEntry[]): Plan {
  const stateOf = new Map<string, TaskState>(progress.map((p) => [p.id, p.state]));
  const state = (id: string): TaskState => stateOf.get(id) ?? 'todo';
  return {
    inProgress: tasks.filter((t) => state(t.id) === 'in-progress'),
    ready: tasks.filter(
      (t) => state(t.id) === 'todo' && t.dependsOn.every((d) => state(d) === 'done'),
    ),
    waitingOnUser: tasks.filter((t) => state(t.id) === 'waiting-on-user'),
    done: tasks.filter((t) => state(t.id) === 'done').length,
    total: tasks.length,
  };
}
