// pnpm conformance <workflow | query> [--json] [--failures N]: runs a conformance suite and
// prints one line per section. The workflow suite runs on its reference model and must pass
// in full (exit 1 on a failure); the query suite runs on this repository's parser and resolver
// and reports the pass rate per section (exit 0; the rates are a reviewed golden).
import {
  formatReport as formatQueryReport,
  nativeEngine,
  QUERY_CASES,
  runConformance as runQuery,
} from '@tracksmith/query';
import {
  formatReport as formatWorkflowReport,
  ReferenceEngine,
  runConformance as runWorkflow,
  WORKFLOW_CASES,
} from '@tracksmith/workflow';

const args = process.argv.slice(2);
const suite = args.find((a) => !a.startsWith('--')) ?? 'workflow';
const json = args.includes('--json');
const failuresArg = args.find((a) => a.startsWith('--failures='));
const failures = failuresArg ? Number(failuresArg.slice('--failures='.length)) : 20;

if (suite === 'workflow') {
  const report = runWorkflow(new ReferenceEngine(), WORKFLOW_CASES);
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Workflow conformance suite: ${report.total} cases on the reference model\n\n${formatWorkflowReport(report)}`,
  );
  if (report.fail > 0) process.exitCode = 1;
} else if (suite === 'query') {
  const report = runQuery(nativeEngine, QUERY_CASES);
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Query conformance suite: ${report.total} cases on the parser and resolver\n\n${formatQueryReport(report, { failures })}`,
  );
} else {
  process.stderr.write(`Unknown suite "${suite}"; use workflow or query.\n`);
  process.exitCode = 2;
}
