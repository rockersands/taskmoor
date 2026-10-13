import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import boot from '../../public/skin-boot.js?raw';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  resolveSkin,
  SKINS,
  storedAppearance,
  toAppearance,
} from './skins';

describe('skins (M1-122, ADR-036)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.skin;
  });

  it('resolves a choice to a skin, System following the device', () => {
    expect(resolveSkin('system', false)).toBe('light');
    expect(resolveSkin('system', true)).toBe('dark');
    expect(resolveSkin('dark', false)).toBe('dark');
    expect(resolveSkin('light', true)).toBe('light');
  });

  it('reads unknown names as System, so a skin from a newer release does no harm', () => {
    expect(toAppearance('dark')).toBe('dark');
    expect(toAppearance('high-contrast')).toBe('system');
    expect(toAppearance(undefined)).toBe('system');
  });

  it('applies a choice to the page and remembers it in this browser', () => {
    applyAppearance('dark');
    expect(document.documentElement.dataset.skin).toBe('dark');
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark');
    expect(storedAppearance()).toBe('dark');
    applyAppearance('system');
    expect(document.documentElement.dataset.skin).toBe('light');
    expect(storedAppearance()).toBe('system');
  });

  it('has a token block for every skin, and the boot script knows the same skins', () => {
    // Vitest blanks CSS imports, so the sheet is read from disk (from the repo or the app).
    const sheet = ['apps/web/src/styles/tokens.css', 'src/styles/tokens.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    const css = readFileSync(sheet ?? 'tokens.css', 'utf8');
    const listed = /const skins = \[([^\]]*)\]/.exec(boot)?.[1] ?? '';
    const bootSkins = [...listed.matchAll(/[a-z][a-z0-9-]*/g)].map((m) => m[0]);
    expect(bootSkins).toEqual(SKINS.map((s) => s.id));
    for (const skin of SKINS) expect(css).toContain(`[data-skin="${skin.id}"]`);
    expect(boot).toContain(APPEARANCE_STORAGE_KEY);
  });
});
