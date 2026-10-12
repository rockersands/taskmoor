import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanBuffer, XmlCleaner } from './clean';
import { generateEntitiesXml } from './generate';
import { parseEntities } from './parse';

const DIRTY = Buffer.concat([
  Buffer.from('<a x="1\u0000\u0001\u0008\t">é'),
  Buffer.from([0xef, 0xbf, 0xbe]), // U+FFFE
  Buffer.from('&#0;&#x1F;&#xFFFE;&#65535;&amp;&#233;&#x1F600;'),
  Buffer.from([0xef, 0xbf, 0xbf]), // U+FFFF
  Buffer.from('日本</a>\r\n'),
]);
const CLEAN = '<a x="1\t">é&amp;&#233;&#x1F600;日本</a>\r\n';

describe('XmlCleaner', () => {
  it('[IMP-001] removes NUL, controls, U+FFFE, U+FFFF and references to them', () => {
    const { out, stats } = cleanBuffer(DIRTY);
    expect(out.toString('utf8')).toBe(CLEAN);
    expect(stats).toMatchObject({ nul: 1, control: 2, noncharacter: 2, charRef: 4 });
    expect(stats.firstOffsets.length).toBe(9);
  });

  it('gives the same result however the input is split into chunks', async () => {
    for (let cut = 1; cut < DIRTY.length; cut++) {
      for (let cut2 = cut + 1; cut2 <= DIRTY.length; cut2 += 7) {
        const cleaner = new XmlCleaner();
        const parts: Buffer[] = [];
        cleaner.on('data', (d: Buffer) => parts.push(d));
        cleaner.write(DIRTY.subarray(0, cut));
        cleaner.write(DIRTY.subarray(cut, cut2));
        cleaner.write(DIRTY.subarray(cut2));
        await new Promise<void>((resolve) => cleaner.end(resolve));
        expect(Buffer.concat(parts).toString('utf8'), `cut at ${cut} and ${cut2}`).toBe(CLEAN);
      }
    }
  });

  it('leaves a reference alone when it is valid or malformed', () => {
    const { out, stats } = cleanBuffer(Buffer.from('&#x41;&#;&#xZZ;&#123456789012;&'));
    expect(out.toString()).toBe('&#x41;&#;&#xZZ;&#123456789012;&');
    expect(stats.charRef).toBe(0);
  });
});

describe('parseEntities', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracksmith-xml-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds one row per entity with attributes and child text', async () => {
    const xml = `<?xml version="1.0"?>\n<root>\n<Item id="1" key="A-1"><description>hi &amp; bye</description></Item>\n<Item id="2"/>\n</root>\n`;
    const rows: unknown[] = [];
    const stats = await parseEntities(Readable.from([Buffer.from(xml)]), (r) => rows.push(r));
    expect(rows).toEqual([
      { entity: 'Item', attrs: { id: '1', key: 'A-1' }, children: { description: 'hi & bye' } },
      { entity: 'Item', attrs: { id: '2' }, children: {} },
    ]);
    expect(stats.elements).toEqual({ Item: 2 });
  });

  it('[IMP-001] streams a generated backup losslessly after cleaning', async () => {
    const path = join(dir, 'entities.xml');
    const generated = await generateEntitiesXml(path, {
      seed: 3,
      bytes: 3_000_000,
      badCharRate: 2e-3,
    });
    expect(generated.bad.nul + generated.bad.control + generated.bad.charRef).toBeGreaterThan(0);

    const cleaner = new XmlCleaner();
    const counts: Record<string, number> = {};
    const stats = await parseEntities(createReadStream(path).pipe(cleaner), (row) => {
      counts[row.entity] = (counts[row.entity] ?? 0) + 1;
    });
    expect(counts).toEqual(generated.elements);
    expect(stats.elements).toEqual(generated.elements);
    expect(cleaner.stats.nul).toBe(generated.bad.nul);
    expect(cleaner.stats.control).toBe(generated.bad.control);
    expect(cleaner.stats.noncharacter).toBe(generated.bad.noncharacter);
    expect(cleaner.stats.charRef).toBe(generated.bad.charRef);
    // Text loses only the removed characters (references were never counted as text).
    expect(generated.textChars - stats.textChars).toBeLessThanOrEqual(
      cleaner.stats.nul + cleaner.stats.control + cleaner.stats.noncharacter,
    );
  });

  it('rejects a file that is still malformed after cleaning', async () => {
    const xml = Buffer.from('<root><Item id="1"></root>');
    await expect(parseEntities(Readable.from([xml]), () => {})).rejects.toThrow();
  });
});
