import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

const configDir = fileURLToPath(new URL('./.storybook', import.meta.url));

/** The skins the story tests render in (ADR-036). */
export type StorySkin = 'light' | 'dark';

/**
 * The folder where one skin's browser server keeps its optimized dependencies (T-208).
 *
 * The Storybook plugin points every project made from one `.storybook` folder at the same cache
 * folder, overriding the per-project folder Vitest would give each. In a gate both skins start
 * together, so on a cold cache (a fresh clone or worktree, a new lockfile) two Vite servers
 * optimized into that one folder at once: the later one moved the earlier one's finished folder
 * aside and replaced it while the earlier one's browser was loading from it. Each skin has its
 * own folder now, so neither can change the other's.
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
