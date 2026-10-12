import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAllSpecs, checkSpecProvenance, readFrontMatter } from './provenance';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const VALID = [
  '---',
  'spec: 09',
  'title: "Example: a spec"',
  'sources: sources.md',
  'accessed: 2026-10-01',
  'attestation: own-words',
  '---',
  '# 09 Example',
  '',
].join('\n');

describe('spec provenance', () => {
  it('every spec in docs/specs carries valid provenance', () => {
    expect(checkAllSpecs(REPO)).toEqual([]);
  });

  describe('fixtures', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ts-prov-'));
      mkdirSync(join(dir, 'specs'));
      writeFileSync(join(dir, 'sources.md'), '# Sources\n');
      writeFileSync(join(dir, 'specs', 'valid.md'), VALID);
      writeFileSync(join(dir, 'specs', 'bare.md'), '# 10 No front matter\n');
      writeFileSync(
        join(dir, 'specs', 'copied.md'),
        VALID.replace('own-words', 'copied')
          .replace('2026-10-01', '2099-01-01')
          .replace('sources.md', 'gone.md'),
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('passes a spec with complete front matter', () => {
      expect(checkSpecProvenance(dir, 'specs/valid.md', '2026-10-12')).toEqual([]);
    });

    it('fails a spec without front matter', () => {
      expect(checkSpecProvenance(dir, 'specs/bare.md')).toEqual([
        'specs/bare.md: no provenance front matter',
      ]);
    });

    it('fails a wrong attestation, a future access date and a missing sources file', () => {
      expect(checkSpecProvenance(dir, 'specs/copied.md', '2026-10-12')).toEqual([
        'specs/copied.md: "accessed" is in the future',
        'specs/copied.md: "attestation" must be own-words',
        'specs/copied.md: sources file gone.md does not exist',
      ]);
    });
  });
});

describe('readFrontMatter', () => {
  it('reads quoted and plain values and ignores the body', () => {
    expect(readFrontMatter(VALID)).toEqual({
      spec: '09',
      title: 'Example: a spec',
      sources: 'sources.md',
      accessed: '2026-10-01',
      attestation: 'own-words',
    });
    expect(readFrontMatter('# No front matter\n---\nkey: value\n---\n')).toBeUndefined();
  });
});
