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
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    setupFiles: ['./.storybook/vitest.setup.ts'],
    // The skin the stories render in; vitest.stories-dark.config.ts runs them again in dark.
    env: { STORY_SKIN: 'light' },
  },
});
