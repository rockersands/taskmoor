// pnpm gen:dc-backup --issues <n> --out <zip> [--seed <n>] [--attachment-rate <0..1>]
//                    [--forbidden-rate <0..1>] [--compression <0..9>] [--no-validate]
// pnpm gen:dc-backup --validate <zip> [--manifest <path>]
//
// Writes a synthetic Data Center backup ZIP (M1-087; docs/specs/02d-dc-backup-format.md) and its
// manifest (`<zip without .zip>.manifest.json`), then validates the ZIP against the format and
// the manifest. With --validate, only checks an existing ZIP. Prints sizes, times and peak
// memory; exits 1 when validation finds problems, 2 on bad arguments.
//
// Fixture tooling: the server never imports it.
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { defaultOptions, generateDcBackup, manifestPathFor } from './generate';
import { readManifest, validateDcBackup } from './validate';

const { values } = parseArgs({
  options: {
    issues: { type: 'string' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
    'attachment-rate': { type: 'string' },
    'forbidden-rate': { type: 'string' },
    compression: { type: 'string' },
    'no-validate': { type: 'boolean', default: false },
    validate: { type: 'string' },
    manifest: { type: 'string' },
  },
});

const usage = () => {
  console.error(
    'Usage: pnpm gen:dc-backup --issues <n> --out <zip> [--seed <n>] [--attachment-rate <r>] [--forbidden-rate <r>] [--compression <0-9>] [--no-validate]\n       pnpm gen:dc-backup --validate <zip> [--manifest <path>]',
  );
  process.exit(2);
};

const say = (line: string) => process.stdout.write(`${line}\n`);
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const peak = () => mb(process.resourceUsage().maxRSS * 1024);

async function check(zip: string, manifestPath: string): Promise<boolean> {
  const started = Date.now();
  const report = await validateDcBackup(zip, await readManifest(manifestPath));
  say(
    `validated in ${seconds(Date.now() - started)}: ${report.ok ? 'ok' : `${report.problemCount} problems`} (peak RSS ${peak()})`,
  );
  for (const p of report.problems.slice(0, 50)) say(`  - ${p}`);
  return report.ok;
}

if (values.validate) {
  const ok = await check(values.validate, values.manifest ?? manifestPathFor(values.validate));
  process.exit(ok ? 0 : 1);
}

const issues = Number(values.issues?.replaceAll('_', ''));
if (!Number.isInteger(issues) || issues < 1 || !values.out) usage();
const number = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const overrides = Object.fromEntries(
  Object.entries({
    attachmentRate: number(values['attachment-rate']),
    forbiddenRate: number(values['forbidden-rate']),
    compressionLevel: number(values.compression),
  }).filter(([, v]) => v !== undefined),
);
const options = defaultOptions(issues, Number(values.seed), overrides);
const started = Date.now();
const generated = await generateDcBackup(options, values.out as string);
const { manifest } = generated;
const size = (await stat(generated.zip)).size;
say(
  `wrote ${generated.zip} in ${seconds(Date.now() - started)}: ${mb(size)} zipped, entities.xml ${mb(manifest.files.entities.bytes)}, activeobjects.xml ${mb(manifest.files.activeObjects.bytes)}, ${manifest.attachments.files} attachments (${mb(manifest.attachments.bytes)}); peak RSS ${peak()}`,
);
say(
  `rows: ${Object.entries(manifest.entities)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
say(`manifest: ${generated.manifestPath}`);
if (!values['no-validate'])
  process.exit((await check(generated.zip, generated.manifestPath)) ? 0 : 1);
