// pnpm run docs [--out <dir>]
//
// Checks the manual in docs/manual (provenance, terms, links: what pnpm verify checks) and
// builds the offline bundle, by default into dist/docs (M1-114): HTML pages with their own
// navigation and search that load nothing from the network, so they open from disk or from any
// web server. TASKMOOR_VERSION stamps the footer, as `pnpm build` stamps the app. External
// links are listed here, never fetched. Exit code 1 on any problem. The script is named docs as
// the backlog asks, but bare `pnpm docs` is pnpm's own command (a package's home page): use run.

import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManual, MANUAL_OUT, readManual } from '../manual';
import { bundleSize, checkBundle, checkManual, manualExternalLinks } from '../manual-check';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const outArg = args[args.indexOf('--out') + 1];
const out =
  args.includes('--out') && outArg
    ? isAbsolute(outArg)
      ? outArg
      : join(process.cwd(), outArg)
    : join(ROOT, MANUAL_OUT);

const problems = checkManual(ROOT);
if (problems.length > 0) {
  for (const p of problems) console.log(p);
  console.log(`\n${problems.length} problem(s) in docs/manual; nothing was built.`);
  process.exit(1);
}

const files = buildManual(ROOT, out);
const bundleProblems = checkBundle(out);
for (const p of bundleProblems) console.log(p);

const external = manualExternalLinks(readManual(ROOT));
console.log(`External links (listed, not fetched): ${external.length}`);
for (const link of external) console.log(`  ${link.url}  (${link.pages.join(', ')})`);

const where = relative(process.cwd(), out) || '.';
const kb = Math.round(bundleSize(out) / 1024);
console.log(
  `${bundleProblems.length === 0 ? 'Built' : 'Built with problems:'} ${files.filter((f) => f.endsWith('.html')).length} pages into ${where} (${kb} KB). Open ${join(where, 'index.html')}.`,
);
if (bundleProblems.length > 0) process.exitCode = 1;
