// pnpm next-task [--all]: what to work on next, from docs/plan/backlog.csv and progress.csv.
import { formatPlan, loadPlan } from '../next-task';

try {
  console.log(formatPlan(loadPlan(), { all: process.argv.includes('--all') }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
