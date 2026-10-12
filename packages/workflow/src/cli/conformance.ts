// pnpm conformance [workflow] [--json]: runs the workflow conformance suite (M1-022) on the
// reference model and prints one line per section. Exit code 1 when any case fails.
import { WORKFLOW_CASES } from '../conformance/cases';
import { formatReport, runConformance } from '../conformance/run';
import { ReferenceEngine } from '../reference';

const args = process.argv.slice(2);
const suite = args.find((a) => !a.startsWith('--')) ?? 'workflow';
if (suite !== 'workflow') {
  process.stderr.write(`Unknown suite "${suite}"; only "workflow" exists.\n`);
  process.exit(2);
}

const report = runConformance(new ReferenceEngine(), WORKFLOW_CASES);
if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `Workflow conformance suite: ${report.total} cases on the reference model\n\n`,
  );
  process.stdout.write(formatReport(report));
}
if (report.fail > 0) process.exitCode = 1;
