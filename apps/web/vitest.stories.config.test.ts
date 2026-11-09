import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ResolvedConfig, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { STORY_DEPS, type StorySkin, storyDepsCache } from './vitest.stories.config';

const CONFIGS: Record<StorySkin, string> = {
  light: fileURLToPath(new URL('./vitest.stories.config.ts', import.meta.url)),
  dark: fileURLToPath(new URL('./vitest.stories-dark.config.ts', import.meta.url)),
};

type StoryConfig = ResolvedConfig & {
  test?: { name?: string; include?: string[]; setupFiles?: string[]; env?: Record<string, string> };
};

/** A skin's Vite config as its browser server resolves it, every plugin's config hook applied. */
async function resolved(skin: StorySkin): Promise<StoryConfig> {
  return (await resolveConfig(
    { configFile: CONFIGS[skin], logLevel: 'silent' },
    'serve',
  )) as StoryConfig;
}

// In a gate the light and dark story runs start together; on a cold cache (a fresh clone or
// worktree, a new lockfile) both optimized their dependencies into the folder the Storybook
// plugin gives every project made from .storybook, and one swapped it under the other (T-208).
describe('story tests in two skins', () => {
  it('[NFR-005] give each skin its own optimized dependencies', async () => {
    const [light, dark] = await Promise.all([resolved('light'), resolved('dark')]);
    expect(resolve(light.cacheDir)).not.toBe(resolve(dark.cacheDir));
    expect(resolve(light.cacheDir)).toBe(resolve(storyDepsCache('light')));
    expect(resolve(dark.cacheDir)).toBe(resolve(storyDepsCache('dark')));
  });

  it('[NFR-005] run the same stories with the same dependencies, only the skin differs', async () => {
    const [light, dark] = await Promise.all([resolved('light'), resolved('dark')]);
    const same = (c: StoryConfig) => ({
      plugins: c.plugins.map((p) => p.name),
      optimizeDeps: c.optimizeDeps,
      include: c.test?.include,
      setupFiles: c.test?.setupFiles,
    });
    expect(same(dark)).toEqual(same(light));
    expect([light.test?.name, light.test?.env?.STORY_SKIN]).toEqual(['stories', 'light']);
    expect([dark.test?.name, dark.test?.env?.STORY_SKIN]).toEqual(['stories-dark', 'dark']);
  });
});

/**
 * The Vite the story tests run on: Vitest's own, which can differ from the app's (`vite` here).
 */
async function vitestVite(): Promise<typeof import('vite')> {
  const fromWeb = createRequire(fileURLToPath(import.meta.url));
  const fromVitest = createRequire(fromWeb.resolve('vitest/package.json'));
  return import(pathToFileURL(fromVitest.resolve('vite')).href);
}

// Vitest's browser server scans the story files and its setup files for packages before the
// browser starts, and leaves out the packages it serves itself.
const SCAN_ENTRIES = ['src/**/*.stories.@(ts|tsx)', '.storybook/vitest.setup.ts'];
const SERVED_BY_VITEST = /^(vitest|@vitest\/)/;

/** What Vite's scan of the stories finds, as a cold cache's first bundle would hold it. */
async function scannedPackages(): Promise<string[]> {
  const vite = await vitestVite();
  const config = await vite.resolveConfig(
    { configFile: CONFIGS.light, logLevel: 'silent', optimizeDeps: { entries: SCAN_ENTRIES } },
    'serve',
  );
  // Only what the scan finds, in a folder of its own: not the list under test, not the run's cache.
  for (const options of [config.optimizeDeps, config.environments.client?.optimizeDeps]) {
    if (options) options.include = [];
  }
  const cacheDir = mkdtempSync(join(tmpdir(), 'story-scan-'));
  (config as { cacheDir: string }).cacheDir = cacheDir;
  try {
    const metadata = await vite.optimizeDeps(config, true);
    return Object.keys(metadata.optimized)
      .filter((id) => !SERVED_BY_VITEST.test(id))
      .sort();
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

// On a cold cache a package Vite meets only after its first bundle makes it bundle again and
// reload every test page, failing the stories in flight (T-208: 48 failures on a fresh clone).
describe('story tests on a cold dependency cache', () => {
  it('[NFR-005] optimize every package up front, in both skins', async () => {
    const [light, dark] = await Promise.all([resolved('light'), resolved('dark')]);
    for (const config of [light, dark]) {
      expect(config.optimizeDeps.include).toEqual(expect.arrayContaining([...STORY_DEPS]));
    }
  });

  it('[NFR-005] list every package the scan of the stories finds', async () => {
    const [scanned, light] = await Promise.all([scannedPackages(), resolved('light')]);
    expect(scanned.length).toBeGreaterThan(10);
    const listed = new Set(light.optimizeDeps.include);
    expect(scanned.filter((id) => !listed.has(id))).toEqual([]);
  });
});
