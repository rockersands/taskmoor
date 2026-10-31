import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { defaultOptions, generateDcBackup } from './generate';
import type { Manifest } from './manifest';
import { validateDcBackup } from './validate';
import { DescriptorError, parseDescriptor, writeDescriptor } from './workflow-format';
import { workflowWorldOf } from './workflows';
import { buildWorld } from './world';

/**
 * The workflow part of the synthetic backup (M1-090): descriptors read back into the model
 * they were written from, and the validator finds what is wrong with a damaged workflow, scheme
 * or issue status.
 */
let dir = '';
let base: Map<string, Buffer>;
let manifest: Manifest;
const OPTIONS = defaultOptions(300, 90);

async function unzip(path: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true }, (e, z) => (e || !z ? fail(e) : ok(z))),
  );
  const out = new Map<string, Buffer>();
  await new Promise<void>((done, fail) => {
    zip.on('end', () => done());
    zip.on('error', fail);
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, async (e, stream) => {
        if (e || !stream) return fail(e);
        const parts: Buffer[] = [];
        for await (const chunk of stream) parts.push(chunk as Buffer);
        out.set(entry.fileName, Buffer.concat(parts));
        zip.readEntry();
      });
    });
    zip.readEntry();
  });
  return out;
}

async function rezip(entries: Map<string, Buffer>, path: string): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const chunk of zip.outputStream) parts.push(chunk as Buffer);
  await writeFile(path, Buffer.concat(parts));
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-workflows-'));
  const generated = await generateDcBackup(OPTIONS, join(dir, 'base.zip'));
  base = await unzip(generated.zip);
  manifest = generated.manifest;
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The problems of a copy of the base backup with its entities file edited. */
async function problems(edit: (xml: string) => string): Promise<string> {
  const entries = new Map(base);
  entries.set(
    'entities.xml',
    Buffer.from(edit(base.get('entities.xml')?.toString('utf8') ?? ''), 'utf8'),
  );
  const path = await rezip(
    entries,
    join(dir, `damaged-${Math.random().toString(36).slice(2)}.zip`),
  );
  return (await validateDcBackup(path, manifest)).problems.join('\n');
}

describe('the backup workflows (M1-090)', () => {
  it('[WF-011] each descriptor reads back into the model it was written from', () => {
    const ww = workflowWorldOf(buildWorld(OPTIONS));
    expect(ww.workflows.length).toBe(6);
    for (const w of ww.workflows) {
      expect(parseDescriptor(writeDescriptor(w.descriptor)), w.name).toEqual(
        JSON.parse(JSON.stringify(w.descriptor)),
      );
    }
    expect(() => parseDescriptor('<steps/>')).toThrow(DescriptorError);
    expect(() => parseDescriptor('<workflow>')).toThrow(DescriptorError);
  });

  it('[IMP-001] validate cleanly, with the workflow cases the manifest counts', async () => {
    expect(await problems((x) => x)).toBe('');
    expect(manifest.entities).toMatchObject({ Workflow: 6, WorkflowScheme: 3, EventType: 1 });
    expect(manifest.cases).toMatchObject({ workflowNegatedConditions: 1, workflowScripts: 1 });
  });

  it('[IMP-001] the validator finds a missing status, workflow and type, and issues outside their workflow', async () => {
    const declined = String(buildWorld(OPTIONS).statuses.find((s) => s.name === 'Declined')?.id);
    const found = await problems((x) => {
      // The first workflow (Delivery flow) loses its Declined step's status.
      const at = x.indexOf('<Workflow id="10000"');
      const step = `<meta name="jira.status.id">${declined}</meta>`;
      const k = x.indexOf(step, at);
      return `${x.slice(0, k)}<meta name="jira.status.id">99999</meta>${x.slice(k + step.length)}`
        .replace('workflow="Defect flow"', 'workflow="Nothing like it"')
        .replace(
          /(<WorkflowSchemeEntity id="\d+" scheme="\d+" workflow="Step flow" issuetype=")\d+/,
          '$199',
        )
        .replace(/(<Workflow id="10003"[^>]*>\s*<descriptor><!\[CDATA\[)/, '$1<workflow><steps>');
    });
    expect(found).toMatch(
      /Workflow 10000 \(Delivery flow\): step 6 names status 99999, which has no row/,
    );
    expect(found).toMatch(/workflow Nothing like it has no row/);
    expect(found).toMatch(/issue type 99 has no row/);
    expect(found).toMatch(/Workflow 10003 \(Business flow\): the descriptor does not read/);
    expect(found).toMatch(/issues are in a status their workflow lacks/);
    // The cases counted from the descriptors no longer match the manifest.
    expect(found).toMatch(/case workflowSteps/);
  });
});
