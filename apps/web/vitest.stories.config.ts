import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

const configDir = fileURLToPath(new URL('./.storybook', import.meta.url));

/**
 * Every story runs as a test in a real browser, with the a11y addon's axe checks. This is the
 * design system's gate (M0-031): a story with a serious or critical violation fails `pnpm verify`.
 */
export default defineProject({
  plugins: [storybookTest({ configDir })],
  test: {
    name: 'stories',
    browser: {
      enabled: true,
      headless: true,
      // Axe measures colour as the page is at that moment, so a surface still fading in would fail
      // it. Stories test the place things come to rest, with the one switch in tokens.css on.
      provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
      instances: [{ browser: 'chromium' }],
      // In a full gate the browser starts while everything else does too.
      connectTimeout: 180_000,
    },
    setupFiles: ['./.storybook/vitest.setup.ts'],
    // The skin the stories render in; vitest.stories-dark.config.ts runs them again in dark.
    // Speed limits are enforced only in the benchmark run (pnpm bench:check).
    env: {
      STORY_SKIN: 'light',
      TASKMOOR_ENFORCE_BUDGETS: process.env.TASKMOOR_ENFORCE_BUDGETS ?? '',
    },
  },
});
