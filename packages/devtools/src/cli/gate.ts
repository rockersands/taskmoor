// pnpm gate [M0] [--ci]: the milestone's exit checklist. --ci asks the GitHub CLI for the latest
// run on main. Exit code 1 while anything fails or waits.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatGate, loadGateInputs, runGate } from '../gate';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const milestone = args.find((a) => /^M\d$/.test(a)) ?? 'M0';

let ci: { conclusion: string; title: string } | undefined;
if (args.includes('--ci')) {
  try {
    const out = execFileSync(
      'gh',
      ['run', 'list', '--branch', 'main', '--limit', '1', '--json', 'conclusion,displayTitle'],
      { encoding: 'utf8', cwd: ROOT },
    );
    const [run] = JSON.parse(out) as { conclusion: string; displayTitle: string }[];
    if (run) ci = { conclusion: run.conclusion || 'in progress', title: run.displayTitle };
  } catch (error) {
    console.error(`GitHub CLI unavailable: ${error instanceof Error ? error.message : error}`);
  }
}

const checks = runGate(loadGateInputs(ROOT, milestone, ci));
process.stdout.write(formatGate(milestone, checks));
if (checks.some((c) => c.state !== 'ok')) process.exitCode = 1;
