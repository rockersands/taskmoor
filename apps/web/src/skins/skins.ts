import type { MessageId } from '../i18n/messages.en';

/**
 * Skins (M1-122, ADR-036): named sets of design tokens in `styles/tokens.css`, selected by
 * `data-skin` on the document root. Adding a skin is a token block there, an entry here and
 * the same name in `public/skin-boot.js` (a test keeps the two lists equal).
 */
export const SKINS = [
  { id: 'light', labelId: 'skins.light', hintId: 'skins.lightHint', scheme: 'light' },
  { id: 'dark', labelId: 'skins.dark', hintId: 'skins.darkHint', scheme: 'dark' },
] as const satisfies readonly {
  id: string;
  labelId: MessageId;
  hintId: MessageId;
  scheme: 'light' | 'dark';
}[];

export type SkinId = (typeof SKINS)[number]['id'];
/** What a person chooses: follow the device, or one skin. Saved with the account. */
export type Appearance = 'system' | SkinId;

/** The browser keeps the choice too, so the boot script can paint the right skin at once. */
export const APPEARANCE_STORAGE_KEY = 'taskmoor.appearance';

export function isSkin(value: unknown): value is SkinId {
  return SKINS.some((s) => s.id === value);
}

/** Unknown names (a skin a newer release added, a typo) read as `system`. */
export function toAppearance(value: unknown): Appearance {
  return isSkin(value) ? value : 'system';
}

export function resolveSkin(appearance: Appearance, prefersDark: boolean): SkinId {
  if (appearance !== 'system') return appearance;
  return prefersDark ? 'dark' : 'light';
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

export function storedAppearance(): Appearance {
  try {
    return toAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    // Storage can be off (private windows, policies): the device setting decides.
    return 'system';
  }
}

let unwatch: (() => void) | null = null;

/**
 * Applies a choice to the page now and remembers it in this browser. With `system` the skin
 * also follows later changes of the device's light or dark setting.
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
) {
  unwatch?.();
  unwatch = null;
  root.dataset.skin = resolveSkin(appearance, prefersDark());
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // Not remembered in this browser; the account still has it.
  }
  if (appearance === 'system' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => {
      root.dataset.skin = resolveSkin('system', query.matches);
    };
    query.addEventListener('change', follow);
    unwatch = () => query.removeEventListener('change', follow);
  }
}
