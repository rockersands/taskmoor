import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BoundaryViolation, checkBoundaries } from './boundaries';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('module boundaries', () => {
  it('hold across the repository', async () => {
    expect(await checkBoundaries(REPO)).toEqual([]);
  }, 60_000);

  describe('a fixture that breaks every rule', () => {
    let dir: string;
    let violations: BoundaryViolation[];

    const files: Record<string, string> = {
      'packages/a/src/index.ts': "import { x } from '../../b/src/internal';\nexport const a = x;\n",
      'packages/b/src/internal.ts': 'export const x = 1;\n',
      'packages/b/src/index.ts':
        "import { helper } from '../../testkit/src/index';\nexport const b = helper;\n",
      'packages/testkit/src/index.ts': 'export const helper = 1;\n',
      'packages/c/src/index.ts':
        "import { y } from '../../../apps/web/src/main';\nexport const c = y;\n",
      'packages/d/src/index.ts': "import { e } from './e';\nexport const d = 1 + e;\n",
      'packages/d/src/e.ts': "import { d } from './index';\nexport const e = () => d;\n",
      'packages/db/src/index.ts': 'export const db = 1;\n',
      'apps/web/src/main.ts': 'export const y = 1;\n',
      'apps/web/src/leak.ts':
        "import { db } from '../../../packages/db/src/index';\nexport const z = db;\n",
    };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'ts-bounds-'));
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      violations = await checkBoundaries(dir);
    }, 60_000);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const expectViolation = (rule: string, from: string, to: string) =>
      expect(violations).toContainEqual({ rule, from, to });

    it('flags relative imports into another package and use of its internals', () => {
      expectViolation(
        'no-relative-import-into-another-package',
        'packages/a/src/index.ts',
        'packages/b/src/internal.ts',
      );
      expectViolation(
        'no-package-internals',
        'packages/a/src/index.ts',
        'packages/b/src/internal.ts',
      );
    });

    it('flags packages that import apps', () => {
      expectViolation(
        'packages-do-not-import-apps',
        'packages/c/src/index.ts',
        'apps/web/src/main.ts',
      );
    });

    it('flags circular imports', () => {
      expectViolation('no-circular', 'packages/d/src/e.ts', 'packages/d/src/index.ts');
    });

    it('flags backend code in the frontend', () => {
      expectViolation(
        'web-stays-frontend-only',
        'apps/web/src/leak.ts',
        'packages/db/src/index.ts',
      );
    });

    it('flags test helpers in production code', () => {
      expectViolation(
        'test-helpers-only-in-tests',
        'packages/b/src/index.ts',
        'packages/testkit/src/index.ts',
      );
    });
  });
});
