import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';
import type { VitestPluginContext } from 'vitest/node';

const webDir = fileURLToPath(new URL('.', import.meta.url));
const configDir = join(webDir, '.storybook');

/** The skins the story tests render in (ADR-036). */
export type StorySkin = 'light' | 'dark';

/**
 * The pointer a story test's browser has (T-328): a mouse, or a touch screen from the moment the
 * page opens. A story that measures on a touch screen carries `tags: ['touch']` and runs only on
 * one; every other story runs only with a mouse.
 */
export type StoryPointer = 'mouse' | 'touch';

/** The tag that sends a story to the touch screen's projects. */
export const TOUCH_TAG = 'touch';

/** The name of one skin's story tests on one pointer. */
export function storiesProjectName(skin: StorySkin, pointer: StoryPointer = 'mouse'): string {
  return [
    'stories',
    ...(skin === 'dark' ? ['dark'] : []),
    ...(pointer === 'touch' ? ['touch'] : []),
  ].join('-');
}

// Storybook reads a story's tags from its source, not by running it: a literal array in the
// story or its file's meta. So a file holds a touch story when the tag is written in one.
const TOUCH_TAG_WRITTEN = new RegExp(`\\btags:\\s*\\[[^\\]]*['"\`]${TOUCH_TAG}['"\`]`);

/**
 * The story files, relative to apps/web, that hold a story tagged `touch`. The touch projects
 * load only these: a file with no story for them would still load all its imports, to run
 * nothing. `vitest.stories.config.test.ts` reads every story file with Storybook's own parser
 * and fails if a file it finds a touch story in is missing here.
 */
export function touchStoryFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  return walk(join(webDir, 'src')).filter(holdsTouchStory).map(includePath).sort();
}

/** A file's path as a story project's `include` lists it: relative to apps/web, with slashes. */
const includePath = (file: string) => relative(webDir, file).replaceAll('\\', '/');

/** Whether a file is one of the web app's story files and has a story tagged `touch` written in it. */
function holdsTouchStory(file: string): boolean {
  if (!/\.stories\.tsx?$/.test(file) || !includePath(file).startsWith('src/')) return false;
  try {
    return TOUCH_TAG_WRITTEN.test(readFileSync(file, 'utf8'));
  } catch {
    return false; // Moved or deleted since the watcher saw it.
  }
}

/**
 * Keeps a touch project's story files current while Vitest watches (T-328).
 *
 * A touch project's list comes from `touchStoryFiles()` once, when it starts. A one-shot run
 * (`pnpm verify`) needs no more. In watch mode (`pnpm test:watch`) a story that gains
 * `tags: ['touch']` in a file that had none would leave the mouse projects, by its tag, and not
 * reach the touch ones, whose list lacks its file: it would run nowhere until Vitest restarted.
 * So the project follows Vitest's file watcher. A story file that now holds a touch story joins
 * the project's `include` and test files, and its cached test specifications are dropped, so the
 * rerun the change starts finds it here. The listener goes before Vitest's own, which decides
 * what reruns. A file that loses its last touch story may stay: Storybook skips a file with no
 * story for the project.
 */
export function followTouchStoryFiles({
  project,
  vitest,
}: Pick<VitestPluginContext, 'project' | 'vitest'>): void {
  if (!vitest.config.watch) return;
  const follow = (path: string) => {
    if (!holdsTouchStory(path) || project.config.include.includes(includePath(path))) return;
    project.config.include.push(includePath(path));
    const file = path.replaceAll('\\', '/');
    project.matchesTestGlob(file);
    vitest.clearSpecificationsCache(file);
  };
  vitest.vite.watcher.prependListener('add', follow);
  vitest.vite.watcher.prependListener('change', follow);
}

/**
 * Every package the stories load in the browser, optimized before the first story runs (T-208).
 *
 * Vite's optimizer reloads the page when it meets a package mid-run that it has not optimized:
 * it bundles the packages again and, if the bundle changed, logs "optimized dependencies changed.
 * reloading" and reloads every test page, which fails the story tests in flight. On a warm cache
 * the packages are already there. On a cold one (a fresh clone or worktree, a new lockfile) the
 * first bundle holds only what Vite's scan found before the browser started, from the story
 * files, the setup file and the entries Vitest and Storybook add: on the Mac the scan finds every
 * package, but a scan that misses one, fails (Vite then bundles nothing up front) or is cut short
 * under a full gate's load leaves the rest to be met mid-run, one reload each. Listed here, they
 * are all in the first bundle whatever the scan does.
 *
 * The list is the set a full stories run optimized (its `deps/_metadata.json`) less what Vitest
 * and the Storybook plugin pin themselves (`vitest > chai` and the like, the addon's
 * `internal/*` setup files). `vitest.stories.config.test.ts` runs Vite's scan over the stories
 * and fails on a package it finds that is missing here: add it. Should a story still meet one
 * mid-run, Vitest warns "Vite unexpectedly reloaded a test" and Vite names the package: add it.
 */
export const STORY_DEPS: readonly string[] = [
  // The web app's own dependencies.
  '@formatjs/icu-messageformat-parser',
  '@hocuspocus/provider',
  '@simplewebauthn/browser',
  '@storybook/addon-a11y/preview',
  '@storybook/react-vite',
  '@tiptap/core',
  '@tiptap/extension-collaboration',
  '@tiptap/extension-collaboration-caret',
  '@tiptap/pm/model',
  '@tiptap/pm/state',
  '@tiptap/pm/tables',
  '@tiptap/react',
  '@tiptap/y-tiptap',
  'axe-core',
  'qrcode',
  'react',
  'react-dom',
  'react-dom/client',
  'react-dom/test-utils',
  'react-intl',
  'react/jsx-dev-runtime',
  'storybook/internal/channels',
  'storybook/internal/docs-tools',
  'storybook/internal/preview-api',
  'storybook/internal/preview-errors',
  'storybook/internal/preview/runtime',
  'storybook/preview-api',
  'storybook/test',
  'yjs',
  // Packages the web app reaches only through another one: Vite resolves an entry from this
  // folder and skips, with a warning, one it cannot, so these name the package that brings them.
  '@storybook/react-vite > @storybook/react > @storybook/global',
  '@storybook/react-vite > @storybook/react > @storybook/react-dom-shim',
  '@taskmoor/builder-core > zod',
  '@taskmoor/richtext > @tiptap/extension-mention',
  '@taskmoor/richtext > @tiptap/extension-table',
  '@taskmoor/richtext > @tiptap/extension-task-item',
  '@taskmoor/richtext > @tiptap/extension-task-list',
  '@taskmoor/richtext > @tiptap/starter-kit',
  '@taskmoor/richtext > mdast-util-from-markdown',
  '@taskmoor/richtext > mdast-util-gfm-autolink-literal',
  '@taskmoor/richtext > mdast-util-gfm-strikethrough',
  '@taskmoor/richtext > mdast-util-gfm-table',
  '@taskmoor/richtext > mdast-util-gfm-task-list-item',
  '@taskmoor/richtext > mdast-util-to-markdown',
  '@taskmoor/richtext > micromark-extension-gfm-autolink-literal',
  '@taskmoor/richtext > micromark-extension-gfm-strikethrough',
  '@taskmoor/richtext > micromark-extension-gfm-table',
  '@taskmoor/richtext > micromark-extension-gfm-task-list-item',
  'vitest > @opentelemetry/api',
];

/**
 * The folder where one story project's browser server keeps its optimized dependencies.
 *
 * The Storybook plugin points every project made from one `.storybook` folder at the same cache
 * folder, overriding the per-project folder Vitest would give each. In a gate the story projects
 * start together, so on a cold cache two Vite servers optimized into that one folder at once, and
 * the later one moved the earlier one's finished folder aside while the earlier one's browser
 * could be loading from it. Each project has its own folder, so none can change another's.
 */
export function storyDepsCache(skin: StorySkin, pointer: StoryPointer = 'mouse'): string {
  const name = `stories-${skin}${pointer === 'touch' ? '-touch' : ''}`;
  return fileURLToPath(new URL(`./node_modules/.vite/${name}`, import.meta.url));
}

/**
 * Every story runs as a test in a real browser, with the a11y addon's axe checks. This is the
 * design system's gate (M0-031): a story with any axe violation, whatever its impact, fails
 * `pnpm verify` (ADR-024; `.storybook/preview.tsx` sets `a11y.test: 'error'` with no impact levels).
 * Every project comes from this one function, so the skins and pointers cannot drift apart.
 *
 * Touch is the browser's, not the story's (T-328). A touch project's pages are touch screens from
 * the moment Playwright makes them (`hasTouch`, Chromium's own touch emulation): `(pointer:
 * coarse)` holds from the first frame and every touch rule stays where its sheet has it, as on a
 * phone. Switching the emulation inside a story instead was a round trip to Node and the DevTools
 * protocol inside the story's 15 s, with no time limit of its own, and under a full gate's load it
 * sometimes outlasted them.
 */
export function storiesProject(skin: StorySkin, pointer: StoryPointer = 'mouse') {
  const touch = pointer === 'touch';
  return defineProject({
    optimizeDeps: { include: [...STORY_DEPS] },
    plugins: [
      storybookTest({
        configDir,
        tags: touch ? { include: [TOUCH_TAG] } : { include: ['test'], exclude: [TOUCH_TAG] },
      }),
      {
        name: 'taskmoor:story-deps-cache',
        // After the Storybook plugin's own config hook, which sets the shared folder.
        config: { order: 'post', handler: () => ({ cacheDir: storyDepsCache(skin, pointer) }) },
      },
      ...(touch
        ? [
            {
              name: 'taskmoor:touch-story-files',
              // After the Storybook plugin's, which sets every story file. Vite would add a
              // returned list to that one, so the list is replaced in place.
              config: {
                order: 'post' as const,
                handler: (config: { test?: { include?: string[] } }) => {
                  if (config.test) config.test.include = touchStoryFiles();
                },
              },
              // In watch mode, a file that gains a touch story joins that list.
              configureVitest: followTouchStoryFiles,
            },
          ]
        : []),
    ],
    test: {
      name: storiesProjectName(skin, pointer),
      browser: {
        enabled: true,
        headless: true,
        // Axe measures colour as the page is at that moment, so a surface still fading in would
        // fail it. Stories test the place things come to rest, with the one switch in tokens.css on.
        provider: playwright({
          contextOptions: { reducedMotion: 'reduce', ...(touch ? { hasTouch: true } : {}) },
        }),
        instances: [{ browser: 'chromium' }],
        // The touch stories are few: one page runs them, beside the mouse projects' pages.
        // (A page count of its own would need a group of its own, run after the others.)
        ...(touch ? { fileParallelism: false } : {}),
        // In a full gate the browser starts while everything else does too.
        connectTimeout: 180_000,
      },
      setupFiles: ['./.storybook/vitest.setup.ts'],
      // The skin the stories render in (the setup file reads it). Speed limits are enforced
      // only in the benchmark run (pnpm bench:check).
      env: {
        STORY_SKIN: skin,
        TASKMOOR_ENFORCE_BUDGETS: process.env.TASKMOOR_ENFORCE_BUDGETS ?? '',
      },
    },
  });
}

export default storiesProject('light');
