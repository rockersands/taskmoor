// pnpm trace: how many spec requirements are cited by tests, per milestone.
import { fileURLToPath } from 'node:url';
import { formatTrace, traceRepository } from '../trace';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const report = traceRepository(root);
console.log(formatTrace(report));
if (report.unknown.length > 0) process.exit(1);
