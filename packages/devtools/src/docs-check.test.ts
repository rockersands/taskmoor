import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorFor, checkAdrIndex, checkGovernance, findBrokenLinks, headings } from './docs-check';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('the repository docs', () => {
  it('keep the governance sections every session relies on', () => {
    expect(checkGovernance(REPO)).toEqual([]);
  });

  it('have no broken relative links', () => {
    expect(findBrokenLinks(REPO)).toEqual([]);
  });

  it('list every ADR in the index with its current status', () => {
    expect(checkAdrIndex(REPO)).toEqual([]);
  });
});

describe('checks catch problems', () => {
  let dir: string;
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-docs-'));
    return dir;
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports missing governance files and sections', () => {
    fresh();
    write('CLAUDE.md', '# Title\n## Commands\n');
    const problems = checkGovernance(dir);
    expect(problems).toContain('CLAUDE.md has no "Layout" section');
    expect(problems).toContain('HANDOFF.md is missing');
  });

  it('reports links to missing files and headings, and ignores code blocks and URLs', () => {
    fresh();
    write('docs/a.md', '# A\n## Real heading\n');
    write(
      'README.md',
      [
        '[ok](docs/a.md#real-heading)',
        '[bad file](docs/missing.md)',
        '[bad anchor](docs/a.md#nope)',
        '[web](https://example.com/x)',
        '```\n[in code](nowhere.md)\n```',
      ].join('\n'),
    );
    expect(findBrokenLinks(dir)).toEqual([
      'README.md: link to missing file docs/missing.md',
      'README.md: link to missing heading docs/a.md#nope',
    ]);
  });

  it('reports ADRs missing from the index or with a stale status', () => {
    fresh();
    write('docs/adr/0001-a.md', '# ADR-001\n- Status: Accepted\n');
    write('docs/adr/0002-b.md', '# ADR-002\n- Status: Proposed\n');
    write('docs/adr/README.md', '| [001](0001-a.md) | A | Proposed |\n');
    expect(checkAdrIndex(dir)).toEqual([
      'docs/adr/README.md shows a different status for 0001-a.md (file says Accepted)',
      '0002-b.md is not listed in docs/adr/README.md',
    ]);
  });
});

describe('anchors and headings', () => {
  it('build GitHub-style anchors', () => {
    expect(anchorFor('5. Architecture and stack')).toBe('5-architecture-and-stack');
    expect(anchorFor('Identity (non-negotiable)')).toBe('identity-non-negotiable');
    expect(anchorFor('Use `pnpm verify`')).toBe('use-pnpm-verify');
  });

  it('read ATX headings', () => {
    expect(headings('# One\ntext\n### Two ###\n')).toEqual(['One', 'Two']);
  });
});
