import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@taskmoor/testkit/golden';
import { describe, expect, it } from 'vitest';

/**
 * Google's files in the app (T-262, IAM-031), as they came: the G of Google's sign-in branding
 * bundle and Google Sans Medium with its licence (THIRD_PARTY_NOTICES). Node rather than jsdom:
 * the golden files are written here.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

interface Element {
  tag: string;
  attributes: Record<string, string>;
  children: Element[];
}

/** An SVG file as a tree of tags and attributes; comments dropped, text refused. */
function parseSvg(xml: string): Element {
  const top: Element = { tag: '', attributes: {}, children: [] };
  const open = [top];
  const TAG = /<!--[\s\S]*?-->|<(\/?)([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  for (const [whole, close, tag = '', attrs = '', selfClosing] of xml.matchAll(TAG)) {
    if (whole.startsWith('<!--')) continue;
    if (close) {
      expect(open.pop()?.tag).toBe(tag);
      continue;
    }
    const element: Element = {
      tag,
      attributes: Object.fromEntries(
        Array.from(attrs.matchAll(/([\w:-]+)="([^"]*)"/g), ([, name = '', value = '']) => [
          name,
          value,
        ]),
      ),
      children: [],
    };
    open.at(-1)?.children.push(element);
    if (!selfClosing) open.push(element);
  }
  expect(open).toEqual([top]);
  expect(xml.replace(TAG, '').trim()).toBe('');
  expect(top.children).toHaveLength(1);
  return top.children[0] as Element;
}

describe("Google's G and Google Sans as shipped (T-262)", () => {
  it("[IAM-031] the G is the one of Google's branding bundle, element for element", async () => {
    const svg = parseSvg(readFileSync(`${SRC}assets/google/google-g.svg`, 'utf8'));
    // The bundle's 40 px round button, light; only the view is cropped to the G at (10, 10).
    expect(svg.attributes).toEqual({
      width: '20',
      height: '20',
      viewBox: '10 10 20 20',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
    });
    expect(svg.children.map((c) => c.tag)).toEqual(['mask', 'g', 'defs']);
    await expect(stableJson(svg)).toMatchFileSnapshot('./__golden__/google-mark.json');
  });

  it("[IAM-031] the label's font is Google's own files for Google Sans Medium, with their licence", async () => {
    const dir = `${SRC}fonts/`;
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'OFL.txt',
      'googlesans-500-latin-ext.woff2',
      'googlesans-500-latin.woff2',
    ]);
    // Byte for byte as Google Fonts serves them (v76): the golden file holds their hashes.
    const shipped = files.map((name) => {
      const bytes = readFileSync(`${dir}${name}`);
      return {
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    await expect(stableJson(shipped)).toMatchFileSnapshot('./__golden__/google-sans.json');
    for (const font of files.filter((f) => f.endsWith('.woff2'))) {
      expect(readFileSync(`${dir}${font}`).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    // Under SIL OFL 1.1, with no Reserved Font Name declared above the licence's own text, so the
    // unmodified files keep their family name.
    const licence = readFileSync(`${dir}OFL.txt`, 'utf8');
    const head = licence.slice(0, licence.indexOf('This Font Software is licensed'));
    expect(head).toContain('Copyright 2025 The Google Sans Project Authors');
    expect(head).not.toMatch(/Reserved Font Name/i);
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    // The stylesheet names both files in faces of the family under its own name, weight 500.
    const css = readFileSync(`${SRC}styles/sso.css`, 'utf8');
    for (const font of files.filter((f) => f.endsWith('.woff2'))) {
      expect(css).toContain(`url("../fonts/${font}") format("woff2")`);
    }
    expect(
      css.match(
        /font-family: "Google Sans";\s+font-style: normal;\s+font-weight: 500;\s+font-display: swap;/g,
      ),
    ).toHaveLength(2);
  });
});
