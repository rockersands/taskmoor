// pnpm dco [range]: fails when a commit in the range lacks its author's Signed-off-by.
// Defaults to the commits not yet on origin/main (or every commit when there is no remote branch).
import { execFileSync } from 'node:child_process';
import { checkDco, readCommits } from '../dco';

function defaultRange(): string {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { stdio: 'ignore' });
    return 'origin/main..HEAD';
  } catch {
    return 'HEAD';
  }
}

const range = process.argv[2] ?? defaultRange();
const commits = readCommits(range);
const problems = checkDco(commits);
if (problems.length > 0) {
  console.error(`DCO: ${problems.length} commit(s) without a matching sign-off in ${range}:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('Fix: git rebase --signoff <base>  (or commit with git commit -s)');
  process.exit(1);
}
console.log(`DCO: ${commits.length} commit(s) in ${range} signed off`);
