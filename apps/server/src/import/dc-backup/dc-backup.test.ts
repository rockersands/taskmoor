import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@taskmoor/testkit/golden';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { ATTRIBUTE_TEXT_MAX, attachmentPath, ENTITIES, timestamp } from './format';
import { defaultOptions, generateDcBackup } from './generate';
import type { Manifest } from './manifest';
import { validateDcBackup } from './validate';
import { projectKey } from './world';

/**
 * The synthetic Data Center backup (M1-087): the generator writes the documented shape at
 * 10,000 issues inside the gate (1,000,000 in `dc-backup.large.test.ts`), the same seed always
 * gives the same backup, and the validator finds what is wrong with a damaged one.
 */
let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-backup-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const NOTES = 'docs/specs/02d-dc-backup-format.md';

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

describe('the backup generator', () => {
  it('[IMP-001] [IMP-004] writes a 10,000-issue backup that validates against the format and its manifest', async () => {
    const { zip, manifest } = await generateDcBackup(
      defaultOptions(10_000, 1),
      join(dir, 'b10k.zip'),
    );
    const report = await validateDcBackup(zip, manifest);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    // Every element and table the format lists has rows, and every case happens.
    for (const name of Object.keys(ENTITIES))
      expect(manifest.entities[name], name).toBeGreaterThan(0);
    for (const [table, rows] of Object.entries(manifest.activeObjects))
      expect(rows, table).toBeGreaterThan(0);
    for (const [name, count] of Object.entries(manifest.cases))
      expect(count, name).toBeGreaterThan(0);
    for (const [kind, count] of Object.entries(manifest.forbidden))
      expect(count, kind).toBeGreaterThan(0);
    expect(manifest.entities.Issue).toBe(10_000);
    // The counts M1-088 onwards compare against: any change to the generator shows here.
    await expect(stableJson(manifest)).toMatchFileSnapshot(
      './__golden__/dc-backup-10k-seed1.manifest.json',
    );
  }, 180_000);

  it('gives the same backup for the same seed and another for another seed', async () => {
    const a = await generateDcBackup(defaultOptions(1_500, 5), join(dir, 'a.zip'));
    const b = await generateDcBackup(defaultOptions(1_500, 5), join(dir, 'b.zip'));
    const c = await generateDcBackup(defaultOptions(1_500, 6), join(dir, 'c.zip'));
    expect(b.manifest).toEqual(a.manifest);
    expect(c.manifest.files.entities.sha256).not.toBe(a.manifest.files.entities.sha256);
    const [ea, eb] = [await unzip(a.zip), await unzip(b.zip)];
    expect([...eb.keys()]).toEqual([...ea.keys()]);
    for (const [name, data] of ea) expect(eb.get(name)?.equals(data), name).toBe(true);
  }, 60_000);

  it('[IMP-001] writes text with line breaks or over the attribute length as CDATA, splitting at "]]>"', async () => {
    const { zip } = await generateDcBackup(
      defaultOptions(400, 3, { forbiddenRate: 0 }),
      join(dir, 'text.zip'),
    );
    const xml = (await unzip(zip)).get('entities.xml')?.toString('utf8') ?? '';
    for (const m of xml.matchAll(/ (?:body|description|summary)="([^"]*)"/g)) {
      expect((m[1] as string).length).toBeLessThanOrEqual(ATTRIBUTE_TEXT_MAX * 2);
      expect(m[1]).not.toContain('\n');
    }
    expect(xml).toContain('<description><![CDATA[');
    expect(xml).toContain(']]]]><![CDATA[>');
    // Attributes with markup characters are escaped, CDATA keeps them as they are.
    expect(xml).toMatch(/body="[^"]*&lt;old&gt; &amp; &lt;new&gt;/);
  }, 30_000);

  it('[IMP-001] puts in every kind of character XML forbids, and the validator counts each', async () => {
    const { zip, manifest } = await generateDcBackup(
      defaultOptions(300, 4, { forbiddenRate: 0.3 }),
      join(dir, 'dirty.zip'),
    );
    expect(Object.values(manifest.forbidden).every((n) => n > 5)).toBe(true);
    const report = await validateDcBackup(zip, manifest);
    expect(report.problems).toEqual([]);
    expect(report.forbidden).toEqual(manifest.forbidden);
  }, 30_000);

  it('files attachments by project, bucket of 10,000 issue numbers, issue key and id', () => {
    expect(attachmentPath('ABC', 1, 'ABC-1', 10_000)).toBe(
      'data/attachments/ABC/10000/ABC-1/10000',
    );
    expect(attachmentPath('ABC', 10_000, 'ABC-10000', 7)).toBe(
      'data/attachments/ABC/10000/ABC-10000/7',
    );
    expect(attachmentPath('ABC', 10_001, 'ABC-10001', 7)).toBe(
      'data/attachments/ABC/20000/ABC-10001/7',
    );
    expect(timestamp(Date.UTC(2024, 0, 2, 3, 4, 5, 6))).toBe('2024-01-02 03:04:05.006');
  });

  it('[IMP-001] gives every project its own key, however many there are', () => {
    // The manifest allows 10,000. At 200 projects (500,000 issues) keys used to repeat, and the
    // import rightly refused the second track of each.
    const keys = Array.from({ length: 10_000 }, (_, index) => projectKey(index));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(projectKey(0)).toBe('AX');
    expect(projectKey(49)).toBe('AX0');
  });
});

describe('the backup validator finds', () => {
  let base: Map<string, Buffer>;
  let manifest: Manifest;
  beforeAll(async () => {
    const generated = await generateDcBackup(defaultOptions(300, 9), join(dir, 'base.zip'));
    base = await unzip(generated.zip);
    manifest = generated.manifest;
  }, 30_000);

  /** Validates a copy of the base backup with one file edited (or removed, for null). */
  async function damaged(name: string, edit: (data: string) => string | null, against = manifest) {
    const entries = new Map(base);
    const data = entries.get(name);
    const changed = edit(data?.toString('utf8') ?? '');
    if (changed === null) entries.delete(name);
    else entries.set(name, Buffer.from(changed, 'utf8'));
    const path = await rezip(
      entries,
      join(dir, `damaged-${Math.random().toString(36).slice(2)}.zip`),
    );
    return validateDcBackup(path, against);
  }
  const problems = async (...args: Parameters<typeof damaged>) =>
    (await damaged(...args)).problems.join('\n');

  it('nothing in the undamaged copy', async () => {
    const report = await damaged('entities.xml', (x) => x);
    expect(report.problems).toEqual([]);
  });

  it('counts that differ from the manifest', async () => {
    const other = structuredClone(manifest);
    other.entities.Issue = (other.entities.Issue ?? 0) + 1;
    other.cases.subtasks = (other.cases.subtasks ?? 0) - 1;
    const found = await problems('entities.xml', (x) => x, other);
    expect(found).toMatch(/rows per element/);
    expect(found).toMatch(/case subtasks/);
  });

  it('a missing file, and the files inside a folder', async () => {
    expect(await problems('activeobjects.xml', () => null)).toMatch(
      /no activeobjects\.xml at the root/,
    );
    const entries = new Map([...base].map(([k, v]) => [`backup/${k}`, v]));
    const report = await validateDcBackup(await rezip(entries, join(dir, 'nested.zip')), manifest);
    expect(report.problems.join('\n')).toMatch(/no entities\.xml at the root/);
    expect(report.problems.join('\n')).toMatch(/unexpected entry backup\/entities\.xml/);
  });

  it('a reference to a row that does not exist, and a duplicate id', async () => {
    const found = await problems('entities.xml', (x) =>
      x
        .replace(/<Action id="10000" issue="\d+"/, '<Action id="10000" issue="99999999"')
        .replace('<Label id="10001"', '<Label id="10000"'),
    );
    expect(found).toMatch(/references to missing Issue rows/);
    expect(found).toMatch(/Label 10000: duplicate id/);
  });

  it('unknown elements and attributes, missing and malformed values', async () => {
    const found = await problems('entities.xml', (x) =>
      x
        .replace('<Issue id="10000"', '<Issue colour="red" id="10000"')
        .replace('<Label id="10000"', '<Badge id="1"/><Label id="10000"')
        .replace(/(<ChangeGroup id="10000" issue="\d+")/, '$1 nonsense="1"')
        .replace(/<Worklog id="10000" issue="\d+"/, '<Worklog id="10000"')
        .replace(/(<Issue id="10001"[^>]*?) created="[^"]*"/, '$1 created="yesterday"'),
    );
    expect(found).toMatch(/unknown attribute colour/);
    expect(found).toMatch(/unknown element Badge/);
    expect(found).toMatch(/Worklog 10000: no issue/);
    expect(found).toMatch(/Issue 10001: created is not a timestamp/);
  });

  it('an attachment of another size, a missing file and a file without a row', async () => {
    const entries = new Map(base);
    const files = [...entries.keys()].filter((k) => k.startsWith('data/'));
    expect(files.length).toBeGreaterThan(2);
    entries.set(files[0] as string, Buffer.from('changed'));
    entries.delete(files[1] as string);
    entries.set('data/attachments/ZZ/10000/ZZ-1/1', Buffer.from('stray'));
    const report = await validateDcBackup(await rezip(entries, join(dir, 'files.zip')), manifest);
    const found = report.problems.join('\n');
    expect(found).toMatch(/file has 7 bytes, the row says/);
    expect(found).toMatch(/no file at data\/attachments/);
    expect(found).toMatch(/ZZ-1\/1 belongs to no FileAttachment row/);
    expect(found).toMatch(/attachments:/);
  });

  it('characters XML forbids that the manifest does not list', async () => {
    const found = await problems('entities.xml', (x) =>
      x.replace('summary="', 'summary="\u0000&#xFFFF;'),
    );
    expect(found).toMatch(/characters XML forbids/);
  });

  it('active-objects rows that do not fit their table', async () => {
    const found = await problems('activeobjects.xml', (x) =>
      x
        .replace('<string>', '<number>1</number><string>')
        .replace(
          /(<data tableName="AO_60DB71_SPRINT">[\s\S]*?)<boolean>\w+<\/boolean>/,
          '$1<boolean>yes</boolean>',
        ),
    );
    expect(found).toMatch(/unknown value element number/);
    expect(found).toMatch(/values for 5 columns/);
    expect(found).toMatch(/is not true or false/);
  });

  it('a file that is not well-formed XML', async () => {
    const found = await problems('entities.xml', (x) => x.slice(0, Math.floor(x.length / 2)));
    expect(found).toMatch(/could not read the backup/);
  });
});

describe('the format notes', () => {
  it('cite a public source for every statement, or mark it to verify', () => {
    const notes = readFileSync(join(ROOT, NOTES), 'utf8');
    const body = notes.slice(notes.indexOf('\n## 1.'), notes.indexOf('\n## Sources'));
    // A statement is a bullet with its wrapped lines.
    const statements: string[] = [];
    let open = false;
    for (const line of body.split('\n')) {
      if (line.startsWith('- ')) {
        statements.push(line);
        open = true;
      } else if (open && line.startsWith('  ')) {
        statements[statements.length - 1] += ` ${line.trim()}`;
      } else {
        open = false;
      }
    }
    expect(statements.length).toBeGreaterThan(30);
    const unsourced = statements.filter(
      (l) => !/\[S\d+\]/.test(l) && !/\*\*(Verify|Our choice):\*\*/.test(l),
    );
    expect(unsourced).toEqual([]);
    // Every cited source is listed with a public URL.
    const cited = new Set([...body.matchAll(/\[S(\d+)\]/g)].map((m) => m[1]));
    const listed = new Map(
      [...notes.matchAll(/^- \[S(\d+)\] <(https:\/\/[^>]+)>/gm)].map((m) => [m[1], m[2]]),
    );
    for (const s of cited) expect(listed.has(s as string), `S${s}`).toBe(true);
  });

  it('name every element and table the generator writes', async () => {
    const notes = await readFile(join(ROOT, NOTES), 'utf8');
    for (const name of Object.keys(ENTITIES)) expect(notes, name).toContain(`\`${name}\``);
    expect(notes).toContain('`AO_60DB71_SPRINT`');
    expect(notes).toContain('`AO_60DB71_RAPIDVIEW`');
  });
});
