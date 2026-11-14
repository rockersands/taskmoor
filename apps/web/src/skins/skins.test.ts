import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import boot from '../../public/skin-boot.js?raw';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  printInLightSkin,
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

  it('[CORE-022] prints a ticket in the light skin and gives the skin back after (PL-27, D37)', () => {
    document.documentElement.dataset.skin = 'dark';
    // The page and its pop-up may both show a ticket: one switch, undone once.
    const stopPage = printInLightSkin();
    const stopPopup = printInLightSkin();
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.documentElement.dataset.skin).toBe('light');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.dataset.skin).toBe('dark');
    // A ticket closed while printing gives the skin back too.
    window.dispatchEvent(new Event('beforeprint'));
    stopPopup();
    expect(document.documentElement.dataset.skin).toBe('light');
    stopPage();
    expect(document.documentElement.dataset.skin).toBe('dark');
    // With no ticket on screen, printing leaves the skin alone.
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.documentElement.dataset.skin).toBe('dark');
  });
});

describe('a page repainted by the Dark Reader extension (ADR-114)', () => {
  const root = document.documentElement;
  const lock = () => document.querySelector('meta[name="darkreader-lock"]');
  const runBoot = () => new Function(boot)();

  beforeEach(() => {
    window.localStorage.clear();
    root.removeAttribute('data-skin');
    root.removeAttribute('data-dark-extension');
    root.removeAttribute('data-darkreader-mode');
    root.removeAttribute('data-darkreader-scheme');
    for (const node of document.head.querySelectorAll('meta, style')) node.remove();
  });

  it('[NFR-005] takes over with the dark skin and tells the extension to stop', () => {
    root.setAttribute('data-darkreader-mode', 'dynamic');
    runBoot();
    expect(root.dataset.skin).toBe('dark');
    expect(root.dataset.darkExtension).toBe('true');
    expect(lock()).not.toBeNull();
  });

  it('[NFR-005] keeps a skin the person chose, and still tells the extension to stop', () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light');
    root.setAttribute('data-darkreader-mode', 'dynamic');
    runBoot();
    expect(root.dataset.skin).toBe('light');
    expect(root.dataset.darkExtension).toBeUndefined();
    expect(lock()).not.toBeNull();
  });

  it('[NFR-005] notices an extension that starts after the boot script', async () => {
    runBoot();
    expect(lock()).toBeNull();
    const style = document.createElement('style');
    style.className = 'darkreader';
    document.head.append(style);
    await new Promise((done) => setTimeout(done, 0));
    expect(root.dataset.skin).toBe('dark');
    expect(lock()).not.toBeNull();
  });

  it('[NFR-005] does nothing without the extension', () => {
    runBoot();
    expect(root.dataset.darkExtension).toBeUndefined();
    expect(lock()).toBeNull();
  });

  it('[NFR-005] keeps System on the dark skin for this page once it took over', () => {
    root.setAttribute('data-darkreader-mode', 'dynamic');
    runBoot();
    applyAppearance('system');
    expect(root.dataset.skin).toBe('dark');
    applyAppearance('light');
    expect(root.dataset.skin).toBe('light');
  });
});
