import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMessage, frontendBuildNeeded } from './frontend';

const BUILT = new Date('2026-11-01T10:00:00Z');
const BEFORE = new Date('2026-10-30T10:00:00Z');
const AFTER = new Date('2026-11-05T10:00:00Z');

/**
 * `pnpm demo` serves the build in apps/web/dist; it builds it again when the checkout moved on
 * (T-211). A checkout of our own in a temporary folder: the app, the workspace packages it
 * bundles and one it does not, and a build, each file with the time a test gives it.
 */
describe('the demo builds the frontend again when the checkout moved on', () => {
  let root = '';
  const write = (path: string, text: string, time = BEFORE) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    utimesSync(file, time, time);
  };
  const touch = (path: string, time = AFTER) => utimesSync(join(root, path), time, time);
  const manifest = (version: string) =>
    JSON.stringify({ name: 'taskmoor-web', version, files: [] });
  const pkg = (name: string, dependencies: Record<string, string> = {}, dev = {}) =>
    JSON.stringify({ name, dependencies, devDependencies: dev });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'taskmoor-demo-frontend-'));
    write(
      'apps/web/package.json',
      pkg(
        '@taskmoor/web',
        { '@taskmoor/query': 'workspace:*', '@taskmoor/richtext': 'workspace:*', react: '^19' },
        { '@taskmoor/server': 'workspace:*' },
      ),
    );
    write('apps/web/index.html', '<!doctype html>');
    write('apps/web/vite.config.ts', 'export default {};');
    write('apps/web/src/App.tsx', 'export const App = 1;');
    write('apps/web/src/App.test.tsx', 'test');
    write('apps/web/src/App.stories.tsx', 'story');
    write('apps/web/src/.DS_Store', '');
    write('apps/web/e2e/board.spec.ts', 'spec');
    write('apps/web/vitest.config.ts', 'export default {};');
    write('apps/web/playwright.config.ts', 'export default {};');
    write('apps/web/node_modules/react/index.js', 'module.exports = {};');
    write('apps/server/package.json', pkg('@taskmoor/server', { '@taskmoor/db': 'workspace:*' }));
    write('apps/server/src/main.ts', 'export {};');
    write('packages/query/package.json', pkg('@taskmoor/query'));
    write('packages/query/src/parser.ts', 'export {};');
    write('packages/query/README.md', 'Notes');
    write(
      'packages/richtext/package.json',
      pkg('@taskmoor/richtext', { '@taskmoor/inner': 'workspace:*' }),
    );
    write('packages/richtext/src/doc.ts', 'export {};');
    write('packages/inner/package.json', pkg('@taskmoor/inner'));
    write('packages/inner/src/inner.ts', 'export {};');
    write('packages/db/package.json', pkg('@taskmoor/db'));
    write('packages/db/src/schema.ts', 'export {};');
    write('pnpm-lock.yaml', 'lockfileVersion: 9');
    write('apps/web/dist/index.html', '<!doctype html>', BUILT);
    write('apps/web/dist/version.json', manifest('0.0.0-dev'), BUILT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('[OPS-017] serves the build as it is while nothing it is made from changed', () => {
    expect(frontendBuildNeeded(root, {})).toBeNull();
  });

  it('[OPS-017] builds it when there is none', () => {
    rmSync(join(root, 'apps/web/dist'), { recursive: true });
    const build = frontendBuildNeeded(root, {});
    expect(build).toEqual({ reason: 'missing' });
    expect(buildMessage(build ?? { reason: 'missing' })).toMatch(/^Building the frontend/);
  });

  it('[OPS-017] builds it again after a source of the app changed', () => {
    for (const file of ['apps/web/src/App.tsx', 'apps/web/index.html', 'apps/web/vite.config.ts']) {
      touch(file);
      expect(frontendBuildNeeded(root, {}), file).toEqual({ reason: 'sources', file });
      touch(file, BEFORE);
    }
    expect(buildMessage({ reason: 'sources', file: 'apps/web/src/App.tsx' })).toBe(
      'Building the frontend again: apps/web/src/App.tsx changed after it was built (about a minute)...',
    );
  });

  it('[OPS-017] builds it again after a workspace package it bundles changed, or the lockfile', () => {
    for (const file of [
      'packages/query/src/parser.ts',
      'packages/richtext/package.json',
      // A package the app reaches through another one.
      'packages/inner/src/inner.ts',
      'pnpm-lock.yaml',
    ]) {
      touch(file);
      expect(frontendBuildNeeded(root, {}), file).toEqual({ reason: 'sources', file });
      touch(file, BEFORE);
    }
  });

  it('[OPS-017] ignores what never reaches the build: tests, stories, other tools, server code', () => {
    for (const file of [
      'apps/web/src/App.test.tsx',
      'apps/web/src/App.stories.tsx',
      'apps/web/src/.DS_Store',
      'apps/web/e2e/board.spec.ts',
      'apps/web/vitest.config.ts',
      'apps/web/playwright.config.ts',
      'apps/web/node_modules/react/index.js',
      // A development dependency of the app, and what only it uses.
      'apps/server/src/main.ts',
      'packages/db/src/schema.ts',
      'packages/query/README.md',
    ]) {
      touch(file);
      expect(frontendBuildNeeded(root, {}), file).toBeNull();
    }
  });

  it('[OPS-017] builds it again when its version is not the one the server runs with', () => {
    expect(frontendBuildNeeded(root, { TASKMOOR_VERSION: '1.4.0' })).toEqual({
      reason: 'version',
      built: '0.0.0-dev',
      wanted: '1.4.0',
    });
    write('apps/web/dist/version.json', manifest('1.4.0'), BUILT);
    expect(frontendBuildNeeded(root, { TASKMOOR_VERSION: ' 1.4.0 ' })).toBeNull();
    expect(frontendBuildNeeded(root, {})).toEqual({
      reason: 'version',
      built: '1.4.0',
      wanted: '0.0.0-dev',
    });
    // A build from before version stamps, or a damaged one, has none.
    rmSync(join(root, 'apps/web/dist/version.json'));
    expect(frontendBuildNeeded(root, {})).toEqual({
      reason: 'version',
      built: null,
      wanted: '0.0.0-dev',
    });
    write('apps/web/dist/version.json', '{', BUILT);
    expect(frontendBuildNeeded(root, {})).toMatchObject({ reason: 'version', built: null });
  });
});
