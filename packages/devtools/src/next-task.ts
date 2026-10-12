import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Plan,
  parseBacklog,
  parseProgress,
  planWork,
  type Task,
  validateBacklog,
} from './backlog';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BACKLOG_PATH = join(ROOT, 'docs', 'plan', 'backlog.csv');
export const PROGRESS_PATH = join(ROOT, 'docs', 'plan', 'progress.csv');

export function loadPlan(): Plan {
  const tasks = parseBacklog(readFileSync(BACKLOG_PATH, 'utf8'));
  const progress = parseProgress(readFileSync(PROGRESS_PATH, 'utf8'));
  const problems = validateBacklog(tasks, progress);
  if (problems.length > 0) throw new Error(`Backlog problems:\n- ${problems.join('\n- ')}`);
  return planWork(tasks, progress);
}

export function formatPlan(plan: Plan, options: { all?: boolean } = {}): string {
  const line = (t: Task) => `  ${t.id} [${t.size}] ${t.title}`;
  const out: string[] = [];
  const next = plan.inProgress[0] ?? plan.ready[0];
  if (next) {
    const verb = plan.inProgress.includes(next) ? 'Resume' : 'Next';
    out.push(`${verb}: ${next.id} [${next.size}, ${next.modules}] ${next.title}`);
    out.push(`  Done when: ${next.doneWhen}`);
  } else {
    out.push('Nothing is ready: every remaining task waits on another task or on the user.');
  }
  if (plan.inProgress.length > 0) {
    out.push('', 'In progress:', ...plan.inProgress.map(line));
  }
  const ready = options.all ? plan.ready : plan.ready.slice(0, 5);
  if (ready.length > 0) {
    out.push('', `Ready (${plan.ready.length}):`, ...ready.map(line));
    if (ready.length < plan.ready.length)
      out.push(`  ... ${plan.ready.length - ready.length} more (--all)`);
  }
  if (plan.waitingOnUser.length > 0) {
    out.push('', 'Waiting on the user:', ...plan.waitingOnUser.map(line));
  }
  out.push('', `Done: ${plan.done} of ${plan.total} tasks`);
  return out.join('\n');
}
