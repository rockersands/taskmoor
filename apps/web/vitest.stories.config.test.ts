import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCsf } from 'storybook/internal/csf-tools';
import { type ResolvedConfig, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  STORY_DEPS,
  type StoryPointer,
  type StorySkin,
  storiesProjectName,
  storyDepsCache,
  TOUCH_TAG,
  touchStoryFiles,
} from './vitest.stories.config';

const WEB = fileURLToPath(new URL('.', import.meta.url));

/** Every story project: each skin, with a mouse and on a touch screen (ADR-036, T-328). */
const PROJECTS: readonly { skin: StorySkin; pointer: StoryPointer; config: string }[] = [
  { skin: 'light', pointer: 'mouse', config: 'vitest.stories.config.ts' },
  { skin: 'dark', pointer: 'mouse', config: 'vitest.stories-dark.config.ts' },
  { skin: 'light', pointer: 'touch', config: 'vitest.stories-touch.config.ts' },
  { skin: 'dark', pointer: 'touch', config: 'vitest.stories-dark-touch.config.ts' },
];
const CONFIGS: Record<StorySkin, string> = {
  light: join(WEB, 'vitest.stories.config.ts'),
  dark: join(WEB, 'vitest.stories-dark.config.ts'),
};

type StoryConfig = ResolvedConfig & {
  test?: {
    name?: string;
    include?: string[];
    setupFiles?: string[];
    env?: Record<string, string>;
    browser?: {
      fileParallelism?: boolean;
      commands?: Record<string, unknown>;
      provider?: { options?: { contextOptions?: Record<string, unknown> } };
    };
  };
};

/** A project's Vite config as its browser server resolves it, every plugin's config hook applied. */
async function resolvedFile(configFile: string): Promise<StoryConfig> {
  return (await resolveConfig({ configFile, logLevel: 'silent' }, 'serve')) as StoryConfig;
}
const resolvedAll = () => Promise.all(PROJECTS.map((p) => resolvedFile(join(WEB, p.config))));

// In a gate the story projects start together; on a cold cache (a fresh clone or worktree, a new
// lockfile) the light and dark runs both optimized their dependencies into the folder the
// Storybook plugin gives every project made from .storybook, and one swapped it under the other
// (T-208).
describe('story tests in two skins, with a mouse and on a touch screen', () => {
  it('[NFR-005] give each project its own optimized dependencies', async () => {
    const configs = await resolvedAll();
    const folders = configs.map((c) => resolve(c.cacheDir));
    expect(new Set(folders).size).toBe(PROJECTS.length);
    expect(folders).toEqual(PROJECTS.map((p) => resolve(storyDepsCache(p.skin, p.pointer))));
  });

  it('[NFR-005] run the same stories with the same dependencies, only the skin differs', async () => {
    const configs = await resolvedAll();
    const same = (c: StoryConfig) => ({
      plugins: c.plugins.map((p) => p.name),
      optimizeDeps: c.optimizeDeps,
      include: c.test?.include,
      setupFiles: c.test?.setupFiles,
      env: { ...c.test?.env, STORY_SKIN: undefined },
      // The provider's options, not the provider; the commands' names, not each one's closure.
      browser: {
        ...c.test?.browser,
        provider: c.test?.browser?.provider?.options,
        commands: Object.keys(c.test?.browser?.commands ?? {}),
      },
    });
    const [light, dark, lightTouch, darkTouch] = configs as [
      StoryConfig,
      StoryConfig,
      StoryConfig,
      StoryConfig,
    ];
    expect(same(dark)).toEqual(same(light));
    expect(same(darkTouch)).toEqual(same(lightTouch));
    expect(configs.map((c) => [c.test?.name, c.test?.env?.STORY_SKIN])).toEqual(
      PROJECTS.map((p) => [storiesProjectName(p.skin, p.pointer), p.skin]),
    );
    expect(configs.map((c) => c.test?.name)).toEqual([
      'stories',
      'stories-dark',
      'stories-touch',
      'stories-dark-touch',
    ]);
  });

  // T-328: switching Chromium's touch emulation inside a story was a round trip to Node with no
  // time limit, inside the story's 15 s, and under a full gate's load it sometimes outlasted them.
  it('[NFR-007] send the stories tagged touch, and only those, to a browser that is a touch screen', async () => {
    const [light, , lightTouch] = (await resolvedAll()) as [StoryConfig, StoryConfig, StoryConfig];
    const tags = (c: StoryConfig) => [
      c.test?.env?.__VITEST_INCLUDE_TAGS__,
      c.test?.env?.__VITEST_EXCLUDE_TAGS__,
    ];
    expect(tags(light)).toEqual(['test', TOUCH_TAG]);
    expect(tags(lightTouch)).toEqual([TOUCH_TAG, '']);
    const context = (c: StoryConfig) => c.test?.browser?.provider?.options?.contextOptions;
    expect(context(light)).toEqual({ reducedMotion: 'reduce' });
    expect(context(lightTouch)).toEqual({ reducedMotion: 'reduce', hasTouch: true });
    // The mouse projects load every story file; a touch project only those with a touch story,
    // on one page beside theirs.
    expect(light.test?.include).toContain('src/**/*.stories.@(ts|tsx)');
    expect(lightTouch.test?.include).toEqual(touchStoryFiles());
    expect(lightTouch.test?.browser?.fileParallelism).toBe(false);
  });
});

/** Every story file of the web app, relative to apps/web, with its source. */
function storyFiles(): { file: string; source: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  return walk(join(WEB, 'src'))
    .filter((file) => /\.stories\.tsx?$/.test(file))
    .map((file) => ({
      file: relative(WEB, file).replaceAll('\\', '/'),
      source: readFileSync(file, 'utf8'),
    }));
}

// A touch story in a file the touch projects do not load would run nowhere: the mouse projects
// leave it out by its tag. And one that asks for a touch screen without the tag would fail in a
// mouse project (`onARealTouchScreen`); this says so before a browser starts.
describe('the stories that run on a touch screen', () => {
  const stories = storyFiles().flatMap(({ file, source }) => {
    const csf = loadCsf(source, { fileName: file, makeTitle: (title) => title ?? file }).parse();
    // Each story's own text, from its export to the next one.
    const text = new Map(
      source
        .split(/\n(?=export const )/)
        .slice(1)
        .map((part) => [/^export const (\w+)/.exec(part)?.[1], part] as const),
    );
    return Object.entries(csf._stories).map(([name, story]) => ({
      file,
      story: `${file}#${name}`,
      // As Storybook's story-test plugin reads them: the file's meta's, then the story's own.
      touch: [...(csf.meta?.tags ?? []), ...(story.tags ?? [])].includes(TOUCH_TAG),
      asksForTouch: /\bonARealTouchScreen\b/.test(text.get(name) ?? ''),
    }));
  });

  it('[NFR-007] are all in the files the touch projects load, and those files hold one', () => {
    const tagged = stories.filter((s) => s.touch);
    expect(tagged.length).toBeGreaterThan(0);
    expect([...new Set(tagged.map((s) => s.file))].sort()).toEqual(touchStoryFiles());
  });

  it("[NFR-007] carry tags: ['touch'] wherever they ask for a real touch screen", () => {
    expect(stories.filter((s) => s.asksForTouch && !s.touch).map((s) => s.story)).toEqual([]);
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
  it('[NFR-005] optimize every listed package up front, in every story project', async () => {
    for (const config of await resolvedAll()) {
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
