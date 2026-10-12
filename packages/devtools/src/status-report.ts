import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProgressEntry, parseBacklog, parseProgress, planWork, type Task } from './backlog';
import { checkBudgets, loadResults, measurements } from './bench';
import { parseCsvRecords } from './csv';

/**
 * The weekly status report (M0-033): what was done against the estimate, what is next, how the
 * benchmarks and CI look, and which decisions the user owes, from the plan files and the spike
 * results. `pnpm status-report` writes it to docs/status/<date>.md; the file is then copied to
 * the user's Drive folder.
 */
export interface StatusInputs {
  /** The day the week ends (the report date). */
  date: string;
  tasks: Task[];
  progress: ProgressEntry[];
  decisions: Record<string, string>[];
  risks: Record<string, string>[];
  results: Record<string, unknown>;
  /** One line about CI, for example from `gh run list`; omitted when unknown. */
  ci?: string;
}

export function loadStatusInputs(root: string, date: string, ci?: string): StatusInputs {
  const plan = (file: string) => readFileSync(join(root, 'docs', 'plan', file), 'utf8');
  return {
    date,
    tasks: parseBacklog(plan('backlog.csv')),
    progress: parseProgress(plan('progress.csv')),
    decisions: parseCsvRecords(plan('decisions.csv')),
    risks: parseCsvRecords(plan('risks.csv')),
    results: loadResults(join(root, 'docs', 'spikes', 'data')),
    ...(ci ? { ci } : {}),
  };
}

/** Sessions per task size from the build plan: S = 1, M = 2 to 3, L = 4 to 6. */
const SESSIONS: Record<string, number> = { S: 1, M: 2.5, L: 5 };

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function buildStatusReport(input: StatusInputs): string {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const plan = planWork(input.tasks, input.progress);
  const thisWeek = input.progress.filter(
    (p) =>
      p.state === 'done' &&
      daysBetween(p.date, input.date) >= 0 &&
      daysBetween(p.date, input.date) < 7,
  );
  const sessions = thisWeek.reduce((n, p) => n + (SESSIONS[byId.get(p.id)?.size ?? ''] ?? 1), 0);
  const milestones = [...new Set(input.tasks.map((t) => t.milestone))];
  const doneIn = (m: string) =>
    input.tasks.filter(
      (t) => t.milestone === m && input.progress.some((p) => p.id === t.id && p.state === 'done'),
    ).length;
  const totalIn = (m: string) => input.tasks.filter((t) => t.milestone === m).length;

  const lines: string[] = [
    `# Weekly status: week ending ${input.date}`,
    '',
    `Tasks done: ${plan.done} of ${plan.total} overall; ${thisWeek.length} this week (about ${sessions} planned sessions of work). ` +
      `In progress: ${plan.inProgress.length}. Waiting on you: ${plan.waitingOnUser.length}.`,
    '',
    '## Milestones',
    '',
    '| Milestone | Done | Total |',
    '|---|---:|---:|',
    ...milestones.map((m) => `| ${m} | ${doneIn(m)} | ${totalIn(m)} |`),
    '',
    '## Done this week',
    '',
  ];
  if (thisWeek.length === 0) lines.push('Nothing closed this week.');
  for (const p of thisWeek) {
    const t = byId.get(p.id);
    lines.push(`- **${p.id}** ${t?.title ?? ''} (${t?.size ?? '?'}): ${p.note}`);
  }
  lines.push('', '## In progress', '');
  if (plan.inProgress.length === 0) lines.push('Nothing half-done.');
  for (const t of plan.inProgress) {
    const note = input.progress.find((p) => p.id === t.id)?.note ?? '';
    lines.push(`- **${t.id}** ${t.title}: ${note}`);
  }

  lines.push('', '## Benchmarks', '');
  const problems = checkBudgets(input.results);
  const all = measurements(input.results);
  if (all.length === 0) lines.push('No results in docs/spikes/data.');
  else {
    const headline = (spike: string, pick: (name: string) => boolean, label: string) => {
      const values = all.filter((m) => m.spike === spike && pick(m.name));
      if (values.length === 0) return;
      const worst = values.reduce((a, b) => (b.value > a.value ? b : a));
      lines.push(`- ${label}: ${worst.value} ${worst.unit} (${worst.name})`);
    };
    const items = (input.results['query-compiler'] as { items?: number } | undefined)?.items;
    headline(
      'query-compiler',
      (n) => n.endsWith('p95'),
      `Slowest query p95${items ? ` at ${items.toLocaleString('en')} items` : ''}`,
    );
    headline('field-storage', (n) => n.includes('edit'), 'Field edit p95');
    headline('authz', (n) => n.startsWith('inprocess-cold'), 'Permission check p95');
    headline('sync', (n) => n.startsWith('delta'), 'Sync delta p95');
    headline('xml', (n) => n.startsWith('minutes'), 'Backup parse, minutes per 5 GB');
    lines.push(
      problems.length === 0
        ? '- Every budget met.'
        : `- **${problems.length} budget problem(s):** ${problems.map((p) => p.message).join('; ')}`,
    );
  }

  lines.push('', '## CI', '', input.ci ?? 'See the Actions tab on GitHub.');

  const open = input.decisions.filter((d) => !/decided/i.test(d["Claude's recommendation"] ?? ''));
  lines.push('', '## Decisions needed from you', '');
  if (open.length === 0) lines.push('None open.');
  for (const d of open) {
    lines.push(
      `- **${d.Decision}** (needed by: ${d['Needed by']}). Recommendation: ${d["Claude's recommendation"]}`,
    );
  }
  if (plan.waitingOnUser.length > 0) {
    lines.push('', 'Tasks waiting on you:', '');
    for (const t of plan.waitingOnUser) {
      const note = input.progress.find((p) => p.id === t.id)?.note ?? '';
      lines.push(`- **${t.id}** ${t.title}: ${note}`);
    }
  }

  lines.push('', '## Risks watched', '');
  for (const r of input.risks.slice(0, 5))
    lines.push(`- ${r.Risk} (${r.Severity}): ${r.Mitigation}`);

  lines.push('', '## Next week', '');
  const next = [...plan.inProgress, ...plan.ready].slice(0, 8);
  if (next.length === 0) lines.push('Nothing ready: every remaining task waits on another.');
  for (const t of next) lines.push(`- ${t.id} [${t.size}] ${t.title}`);
  return `${lines.join('\n')}\n`;
}
