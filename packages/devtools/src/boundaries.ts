import type { ICruiseResult, IForbiddenRuleType } from 'dependency-cruiser';
import { cruise } from 'dependency-cruiser';

/**
 * Architecture rules (ADR-004). They keep modules independent, keep test helpers out of
 * production code and keep backend code out of the browser bundle.
 */
export const BOUNDARY_RULES: IForbiddenRuleType[] = [
  {
    name: 'no-circular',
    comment: 'Circular imports make modules impossible to reason about or split.',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-relative-import-into-another-package',
    comment: 'Import another package by its name (@tracksmith/x), never by a relative path.',
    severity: 'error',
    from: { path: '^(apps|packages)/([^/]+)/' },
    // Package-name imports resolve to the same files; only relative paths ("local") break the rule.
    to: { path: '^(apps|packages)/', pathNot: '^$1/$2/', dependencyTypes: ['local'] },
  },
  {
    name: 'no-package-internals',
    comment:
      "Only a package's public entry points (index.ts, testing.ts) may be imported from outside it.",
    severity: 'error',
    from: { path: '^(apps|packages)/([^/]+)/' },
    to: {
      path: '^packages/([^/]+)/src/',
      pathNot: ['^$1/$2/', '^packages/[^/]+/src/(index|testing)\\.ts$', '^packages/testkit/src/'],
    },
  },
  {
    name: 'packages-do-not-import-apps',
    comment: 'Shared packages sit below the apps; apps compose them, never the other way round.',
    severity: 'error',
    from: { path: '^packages/' },
    to: { path: '^apps/' },
  },
  {
    name: 'web-stays-frontend-only',
    comment: 'The static frontend must never bundle server, database or test code.',
    severity: 'error',
    from: { path: '^apps/web/src/', pathNot: '\\.test\\.tsx?$|^apps/web/src/test/' },
    to: { path: '^(apps/server|packages/(db|testkit|devtools))/' },
  },
  {
    name: 'test-helpers-only-in-tests',
    comment: 'Test helpers (testkit, */testing.ts, src/test/) are for tests, not production code.',
    severity: 'error',
    from: {
      path: '^(apps|packages)/[^/]+/src/',
      pathNot: [
        '\\.test\\.tsx?$',
        '^packages/testkit/',
        '^packages/devtools/',
        '^packages/spikes/',
        '/testing\\.ts$',
        '^apps/web/src/test/',
      ],
    },
    to: { path: '^packages/testkit/|^packages/[^/]+/src/testing\\.ts$|^apps/web/src/test/' },
  },
];

export interface BoundaryViolation {
  rule: string;
  from: string;
  to: string;
}

/** Runs the rules over the given folders (relative to `baseDir`) and returns the violations. */
export async function checkBoundaries(
  baseDir: string,
  folders: string[] = ['apps', 'packages'],
): Promise<BoundaryViolation[]> {
  const result = await cruise(folders, {
    baseDir,
    validate: true,
    ruleSet: { forbidden: BOUNDARY_RULES },
    exclude: { path: 'node_modules|/\\.tsbuild/|/dist/|/e2e/|\\.config\\.ts$' },
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs'],
    },
  });
  const output = result.output as ICruiseResult;
  return output.summary.violations.map((v) => ({
    rule: v.rule.name,
    from: v.from.replaceAll('\\', '/'),
    to: v.to.replaceAll('\\', '/'),
  }));
}
