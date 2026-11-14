import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** The Vite the story tests run on: Vitest's own, which can differ from the app's (`vite` here). */
async function vitestVite(): Promise<{ vite: typeof import('vite'); vitestDir: string }> {
  const fromWeb = createRequire(fileURLToPath(import.meta.url));
  const vitestPackage = fromWeb.resolve('vitest/package.json');
  const vite = await import(pathToFileURL(createRequire(vitestPackage).resolve('vite')).href);
  return { vite, vitestDir: dirname(vitestPackage) };
}

// What Vitest's browser server adds to a stories project before Vite optimizes anything
// (@vitest/browser's config hook): its runtime as scan entries, the packages it serves itself
// unbundled, and three it pins. Storybook's plugin adds its own entries and pins in the config.
const VITEST_ENTRIES = ['browser', 'index', 'runners'].map((f) => `dist/${f}.js`);
// `vitest/browser` among them: the setup file reaches the browser's touch emulation through it.
const SERVED_BY_VITEST =
  /^(vitest(\/browser|\/internal\/browser)?|@vitest\/.*|vite\/module-runner|std-env|tinybench|tinyspy|tinyrainbow|pathe|msw(\/browser)?)$/;
const PINNED_BY_VITEST = [
  'vitest > expect-type',
  'vitest > @vitest/snapshot > magic-string',
  'vitest > @vitest/expect > chai',
];

/**
 * The packages one cold start of the light stories' server bundles before the browser starts,
 * each with the file it was bundled from: with the scan alone (`scan`), or with no scan at all,
 * only what the config lists up front (`listed`).
 */
async function firstBundle(mode: 'scan' | 'listed'): Promise<Record<string, string>> {
  const { vite, vitestDir } = await vitestVite();
  const config = await vite.resolveConfig(
    {
      configFile: CONFIGS.light,
      logLevel: 'silent',
      optimizeDeps: {
        entries: [
          'src/**/*.stories.@(ts|tsx)',
          '.storybook/vitest.setup.ts',
          ...VITEST_ENTRIES.map((f) => join(vitestDir, f)),
        ],
      },
    },
    'serve',
  );
  for (const options of [config.optimizeDeps, config.environments.client?.optimizeDeps]) {
    if (!options) continue;
    if (mode === 'scan') options.include = [];
    else {
      options.entries = ['no-such-folder/*.ts'];
      options.include = [...(options.include ?? []), ...PINNED_BY_VITEST];
    }
  }
  // A folder of its own, not the stories' cache.
  const cacheDir = mkdtempSync(join(tmpdir(), 'story-deps-'));
  (config as { cacheDir: string }).cacheDir = cacheDir;
  try {
    const metadata = await vite.optimizeDeps(config, true);
    return Object.fromEntries(
      Object.entries(metadata.optimized)
        .filter(([id]) => !SERVED_BY_VITEST.test(id))
        .map(([id, dep]) => [id, dep.src ?? '']),
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

// On a cold cache a package Vite meets only after its first bundle makes it bundle again and
// reload every test page, failing the stories in flight (T-208: 48 failures on a fresh clone).
// The first bundle must not depend on the scan, which can miss a package, fail or be cut short.
describe('story tests on a cold dependency cache', () => {
  it('[NFR-005] optimize every listed package up front, in both skins', async () => {
    const [light, dark] = await Promise.all([resolved('light'), resolved('dark')]);
    for (const config of [light, dark]) {
      expect(config.optimizeDeps.include).toEqual(expect.arrayContaining([...STORY_DEPS]));
    }
  });

  it('[NFR-005] bundle, with no scan at all, every package the scan of the stories finds', async () => {
    const scanned = await firstBundle('scan');
    const listed = await firstBundle('listed');
    expect(Object.keys(scanned).length).toBeGreaterThan(20);
    // An entry Vite cannot resolve from apps/web is skipped with only a warning.
    expect(STORY_DEPS.filter((id) => !(id in listed))).toEqual([]);
    const bundled = new Set(Object.values(listed));
    const missing = Object.entries(scanned).filter(([, src]) => !bundled.has(src));
    expect(missing.map(([id]) => id)).toEqual([]);
  });
});
