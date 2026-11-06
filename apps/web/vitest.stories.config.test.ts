import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ResolvedConfig, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { type StorySkin, storyDepsCache } from './vitest.stories.config';

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
