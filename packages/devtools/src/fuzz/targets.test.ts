import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runFuzz } from '@taskmoor/testkit/fuzz';
import { describe, expect, it } from 'vitest';
import { FUZZ_TARGET_FILES } from './registry';
import { checkAdf, checkHref, checkTextSearch, checkWiki, FUZZ_TARGETS } from './targets';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The shared packages' fuzz targets (M1-118, ADR-104), each for a few seconds; the long runs are
 * `pnpm fuzz <target> --minutes N` (ten minutes each for M1-118, 24 hours at the M1 gate).
 */
describe('fuzz targets: shared packages (M1-118)', () => {
  it('[NFR-008] lists every target in the registry, in a file that defines it', () => {
    for (const [name, { module }] of Object.entries(FUZZ_TARGET_FILES)) {
      if (!module) continue;
      const path = `${ROOT}${module}`;
      expect(existsSync(path), module).toBe(true);
      expect(readFileSync(path, 'utf8'), name).toContain(`name: '${name}'`);
    }
    for (const t of FUZZ_TARGETS) expect(FUZZ_TARGET_FILES[t.name]?.module).toContain('devtools');
  });

  for (const target of FUZZ_TARGETS) {
    it(`[NFR-008] ${target.name}: no failure in a short run`, async () => {
      const report = await runFuzz(target, { seed: 118, seconds: 15, inputs: 400 });
      expect(report.failures).toEqual([]);
      expect(report.inputs).toBeGreaterThan(50);
    }, 60_000);
  }

  it('[NFR-008] href: refuses what a browser would open as script, as the URL parser reads it', () => {
    const js = ['java', 'script:x'];
    for (const href of [
      js.join('\t'),
      js.join('\n'),
      `\u0001${js.join('')}`,
      `\u0000 ${js.join('')}`,
    ]) {
      expect(checkHref(href), JSON.stringify(href)).toBe('unsafe');
    }
    expect(checkHref('https://example.test/')).toBe('safe');
  });

  it('[NFR-008] wiki, text, adf: the inputs the fuzzers found hold now', () => {
    expect(checkWiki('{quote}\nwarm İafter\n\n* cold\n{quote}')).toBe('valid');
    expect(checkWiki('{code:[~someone]sql}\nSELECT 1\n{code}')).toBe('valid');
    expect(checkWiki(`[~accountid:${String.fromCharCode(0xdfff)}]`)).toBe('valid');
    expect(checkTextSearch('a\\"b -"c d" e*')).toBe('valid');
    const doc = (content: unknown) => ({ version: 1, type: 'doc', content }) as never;
    expect(checkAdf(doc([{ type: 'paragraph', attrs: 'x', content: [] }]))).toBe('refused');
    expect(
      checkAdf(doc([{ type: 'inlineExtension', attrs: { id: 'a'.repeat(9) }, content: { a: 1 } }])),
    ).toBe('refused');
    expect(
      checkAdf(
        doc([
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: 'x' }] }],
          },
        ]),
      ),
    ).toBe('refused');
  });
});
