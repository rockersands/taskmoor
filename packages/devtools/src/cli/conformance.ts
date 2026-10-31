// pnpm conformance <workflow | query | formula | compat> [--json] [--failures N]: runs a conformance
// suite and prints one line per section. The workflow suite runs on the engine and on its
// reference model, and both must pass in full (exit 1 on a failure); the query suite runs on
// this repository's parser and resolver and reports the pass rate per section (exit 0; the
// rates are a reviewed golden); the formula suite (M1-013) runs on the formula language and
// must pass in full. The compat suite (M1-068) runs the Jira-compatible API's cases against a
// running Taskmoor server (--url, --project, --issue-type, --board; the token from
// TASKMOOR_TOKEN) and prints each family's operations by state; it never runs against an
// Atlassian product (ADR-003).
import { formatSummary, runCompatContract } from '@taskmoor/api-jira-compat';
import { runFormulaConformance } from '@taskmoor/formula';
import {
  formatReport as formatQueryReport,
  nativeEngine,
  QUERY_CASES,
  runConformance as runQuery,
} from '@taskmoor/query';
import {
  engine,
  formatReport as formatWorkflowReport,
  ReferenceEngine,
  runConformance as runWorkflow,
  WORKFLOW_CASES,
} from '@taskmoor/workflow';

const args = process.argv.slice(2);
const suite = args.find((a) => !a.startsWith('--')) ?? 'workflow';
const json = args.includes('--json');
const failuresArg = args.find((a) => a.startsWith('--failures='));
const failures = failuresArg ? Number(failuresArg.slice('--failures='.length)) : 20;
const option = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? undefined;
/** Atlassian's hosted and own addresses: the clean room forbids testing against them. */
const ATLASSIAN_HOST = /(^|\.)(atlassian\.net|atlassian\.com|jira\.com)$/i;

if (suite === 'workflow') {
  const runs = [
    { on: 'the engine', report: runWorkflow(engine, WORKFLOW_CASES) },
    { on: 'the reference model', report: runWorkflow(new ReferenceEngine(), WORKFLOW_CASES) },
  ];
  process.stdout.write(
    json
      ? `${JSON.stringify(Object.fromEntries(runs.map((r) => [r.on, r.report])), null, 2)}\n`
      : runs
          .map(
            (r) =>
              `Workflow conformance suite: ${r.report.total} cases on ${r.on}\n\n${formatWorkflowReport(r.report)}`,
          )
          .join('\n'),
  );
  if (runs.some((r) => r.report.fail > 0)) process.exitCode = 1;
} else if (suite === 'query') {
  const report = runQuery(nativeEngine, QUERY_CASES);
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Query conformance suite: ${report.total} cases on the parser and resolver\n\n${formatQueryReport(report, { failures })}`,
  );
} else if (suite === 'formula') {
  const report = runFormulaConformance();
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Formula conformance suite: ${report.total} cases on the formula language\n\n${report.sections
          .map(
            (s) =>
              `${s.section.padEnd(14)} ${String(s.pass).padStart(4)} / ${s.total}${s.failed
                .slice(0, failures)
                .map((f) => `\n  ${f.id}: ${f.problem}`)
                .join('')}`,
          )
          .join('\n')}\n\n${report.pass} of ${report.total} pass\n`,
  );
  if (report.fail > 0) process.exitCode = 1;
} else if (suite === 'compat') {
  const url = option('url');
  const project = option('project');
  const token = process.env.TASKMOOR_TOKEN;
  if (!url || !project || !token) {
    process.stderr.write(
      'Usage: TASKMOOR_TOKEN=<an administrator token> pnpm conformance compat --url=https://tracker.example.com --project=KEY [--issue-type=Chore] [--board=<id>]\n',
    );
    process.exitCode = 2;
  } else if (ATLASSIAN_HOST.test(new URL(url).hostname)) {
    process.stderr.write('The suite runs against Taskmoor only, never an Atlassian product.\n');
    process.exitCode = 2;
  } else {
    const base = url.replace(/\/+$/, '');
    const report = await runCompatContract({
      project,
      issueType: option('issue-type') ?? 'Chore',
      boardId: option('board') ? Number(option('board')) : null,
      call: async (r) => {
        const query = r.query ? `?${new URLSearchParams(r.query)}` : '';
        const res = await fetch(`${base}${r.path}${query}`, {
          method: r.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { status: res.status, body };
      },
    });
    process.stdout.write(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `Jira-compatible API conformance against ${base}\n\n${formatSummary(report, failures)}`,
    );
  }
} else {
  process.stderr.write(`Unknown suite "${suite}"; use workflow, query, formula or compat.\n`);
  process.exitCode = 2;
}
