import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

const configDir = fileURLToPath(new URL('./.storybook', import.meta.url));

/** The skins the story tests render in (ADR-036). */
export type StorySkin = 'light' | 'dark';

/**
 * Every package the stories load in the browser, optimized before the first story runs (T-208).
 *
 * Vite's optimizer reloads the page when it meets a package mid-run that it has not optimized:
 * it bundles the packages again and, if the bundle changed, logs "optimized dependencies changed.
 * reloading" and reloads every test page, which fails the story tests in flight. On a warm cache
 * the packages are already there; on a cold one (a fresh clone or worktree, a new lockfile) Vite
 * knows only what its scan of the story files found before the browser started. The scan reads
 * the files as written, so it never sees what Storybook's transforms add to them: its preview
 * runtime, the React renderer's shim, the a11y addon's axe-core and the like are met only while
 * the stories run, after the first bundle, and on a cold cache each one meant a reload. Listed
 * here, they are all in the first bundle whatever the scan finds.
 *
 * The list is the set a full stories run optimized (its `deps/_metadata.json`) less what Vitest
 * and the Storybook plugin pin themselves (`vitest > chai` and the like, the addon's
 * `internal/*` setup files). `vitest.stories.config.test.ts` runs Vite's scan over the stories
 * and fails on a package it finds that is missing here: add it. A package only a running story
 * finds shows up as Vitest's "Vite unexpectedly reloaded a test" warning, naming it: add it too.
 */
export const STORY_DEPS: readonly string[] = [
  '@formatjs/icu-messageformat-parser',
  '@hocuspocus/provider',
  '@opentelemetry/api',
  '@simplewebauthn/browser',
  '@storybook/global',
  '@storybook/react-dom-shim',
  '@storybook/react-vite',
  '@tiptap/core',
  '@tiptap/extension-collaboration',
  '@tiptap/extension-collaboration-caret',
  '@tiptap/extension-mention',
  '@tiptap/extension-table',
  '@tiptap/extension-task-item',
  '@tiptap/extension-task-list',
  '@tiptap/pm/model',
  '@tiptap/pm/state',
  '@tiptap/react',
  '@tiptap/starter-kit',
  '@tiptap/y-tiptap',
  'axe-core',
  'expect-type',
  'mdast-util-from-markdown',
  'mdast-util-gfm-autolink-literal',
  'mdast-util-gfm-strikethrough',
  'mdast-util-gfm-table',
  'mdast-util-gfm-task-list-item',
  'mdast-util-to-markdown',
  'micromark-extension-gfm-autolink-literal',
  'micromark-extension-gfm-strikethrough',
  'micromark-extension-gfm-table',
  'micromark-extension-gfm-task-list-item',
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
  'zod',
];

/**
 * The folder where one skin's browser server keeps its optimized dependencies.
 *
 * The Storybook plugin points every project made from one `.storybook` folder at the same cache
 * folder, overriding the per-project folder Vitest would give each. In a gate both skins start
 * together, so on a cold cache two Vite servers optimized into that one folder at once, and the
 * later one moved the earlier one's finished folder aside while the earlier one's browser could
 * be loading from it. Each skin has its own folder, so neither can change the other's.
 */
export function storyDepsCache(skin: StorySkin): string {
  return fileURLToPath(new URL(`./node_modules/.vite/stories-${skin}`, import.meta.url));
}

/**
 * Every story runs as a test in a real browser, with the a11y addon's axe checks. This is the
 * design system's gate (M0-031): a story with a serious or critical violation fails `pnpm verify`.
 * Both skins come from this one function, so the light and dark runs cannot drift apart.
 */
export function storiesProject(skin: StorySkin) {
  return defineProject({
    optimizeDeps: { include: [...STORY_DEPS] },
    plugins: [
      storybookTest({ configDir }),
      {
        name: 'taskmoor:story-deps-cache',
        // After the Storybook plugin's own config hook, which sets the shared folder.
        config: { order: 'post', handler: () => ({ cacheDir: storyDepsCache(skin) }) },
      },
    ],
    test: {
      name: skin === 'light' ? 'stories' : 'stories-dark',
      browser: {
        enabled: true,
        headless: true,
        // Axe measures colour as the page is at that moment, so a surface still fading in would
        // fail it. Stories test the place things come to rest, with the one switch in tokens.css on.
        provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
        instances: [{ browser: 'chromium' }],
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
