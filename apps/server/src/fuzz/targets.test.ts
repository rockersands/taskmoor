import { Readable } from 'node:stream';
import { runFuzz } from '@taskmoor/testkit/fuzz';
import { describe, expect, it } from 'vitest';
import { parseXml } from '../import/dc-backup/parse';
import { redirectMatches } from '../oauth/clients';
import { readRichText, writeRichText } from '../tickets/rich-text';
import { checkAddress, checkRichInput, checkStage, FUZZ_TARGETS } from './targets';

/**
 * The server's fuzz targets (M1-118, ADR-104), each for a few seconds, and the inputs they
 * found, as regression tests. The long runs are `pnpm fuzz <target> --minutes N`.
 */
describe('fuzz targets: server parsers (M1-118)', () => {
  for (const target of FUZZ_TARGETS) {
    const inputs = target.name === 'dc-stage' ? 12 : 300;
    it(`[NFR-008] ${target.name}: no failure in a short run`, async () => {
      const report = await runFuzz(target, { seed: 118, seconds: 40, inputs });
      expect(report.failures).toEqual([]);
      expect(report.inputs).toBeGreaterThan(Math.min(10, inputs - 1));
    }, 120_000);
  }

  it('[API-002] an OAuth loopback redirect may change only its port (M1-118)', () => {
    const registered = ['http://localhost:3000/cb', 'https://app.example.test/cb'];
    expect(redirectMatches(registered, 'http://localhost:4111/cb')).toBe(true);
    expect(redirectMatches(registered, 'http://user:pw@localhost:4111/cb')).toBe(false);
    expect(redirectMatches(registered, 'http://localhost:4111/cb#x')).toBe(false);
    expect(redirectMatches(registered, 'http://localhost:4111/cb#')).toBe(false);
    expect(redirectMatches(registered, 'https://app.example.test/cb')).toBe(true);
    expect(checkAddress('http://user:pass@localhost:3000/cb')).not.toHaveProperty('problem');
  });

  it('[API-011] refuses rich text the readers and writers cannot rely on, never a 500 (M1-118)', () => {
    let deep: unknown = { type: 'text', text: 'deep' };
    for (let i = 0; i < 60_000; i++) deep = { type: 'blockquote', content: [deep] };
    expect(readRichText({ version: 1, type: 'doc', content: [deep] }, 'adf')).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(readRichText({ type: 'doc', content: [deep] }, 'doc')).toEqual({
      ok: false,
      problem: 'invalid',
    });
    const p = (node: unknown) => ({ version: 1, type: 'doc', content: [node] });
    expect(readRichText(p({ type: 'paragraph', attrs: 'x' }), 'adf')).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(
      readRichText(
        { type: 'doc', content: [{ type: 'paragraph', attrs: { adfAttrs: 'x' } }] },
        'doc',
      ),
    ).toEqual({ ok: false, problem: 'invalid' });
    // A mention id with a lone surrogate is stored and reads back in every format.
    const wiki = readRichText(`hi [~accountid:a${String.fromCharCode(0xd83d)}]`, 'wiki');
    expect(wiki.ok).toBe(true);
    if (wiki.ok) expect(() => writeRichText(wiki.text.doc, 'markdown')).not.toThrow();
    expect(
      checkRichInput({
        format: 'adf',
        value: p({ type: 'inlineCard', attrs: { url: 1 }, content: 'x' }),
      }),
    ).toBe('refused:invalid');
  });

  it('[IMP-003] stages a backup whose saved filter has no id, never a TypeError (fuzz, 2026-11-02)', async () => {
    const stage = FUZZ_TARGETS.find((t) => t.name === 'dc-stage');
    const [seed] = ((await stage?.seeds()) ?? []) as {
      entities: string;
      activeObjects: string | null;
    }[];
    // The two edits the fuzzer made: one filter's id attribute garbled, another's id repeated.
    const entities =
      seed?.entities
        .replace(
          /<SearchRequest id="(\d+)" name="Projects I lead"/,
          '<SearchRequest idid="$1" name="Projects I lead"',
        )
        .replace(
          /<SearchRequest id="\d+" name="An app's epic function"/,
          '<SearchRequest id="10000" name="An app\'s epic function"',
        ) ?? '';
    expect(entities).not.toBe(seed?.entities);
    expect(
      typeof (await checkStage({ activeObjects: seed?.activeObjects ?? null, entities })),
    ).toBe('string');
  }, 120_000);

  it('[IMP-003] the backup reader never expands entities a file declares', async () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>',
      '<r><Issue summary="&b;">&b;</Issue></r>',
    ].join('\n');
    const seen: string[] = [];
    await expect(
      parseXml(Readable.from([Buffer.from(xml)]), {
        open: (tag) => seen.push(JSON.stringify(tag.attributes)),
        text: (t) => seen.push(t),
        close: () => undefined,
      }),
    ).rejects.toThrow();
    expect(seen.join('')).not.toContain('aaaaaaaaaa');
  });
});
