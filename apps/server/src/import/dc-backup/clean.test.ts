import { describe, expect, it } from 'vitest';
import { cleanBuffer, XmlCleaner } from './clean';

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
    // Each kind keeps its own first offsets, for the import report's examples (M1-088).
    expect(stats.offsets.nul).toEqual([7]);
    expect(stats.offsets.control).toEqual([8, 9]);
    expect(stats.offsets.charRef.length).toBe(4);
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
