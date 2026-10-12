import { messagesEn } from './messages.en';
import { pseudoLocalize } from './pseudo';

/** `en-XA` is the pseudo-locale: every string accented, lengthened and bracketed. */
export const SUPPORTED_LOCALES = ['en', 'en-XA'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const STORAGE_KEY = 'taskmoor.locale';

function isLocale(value: string | null | undefined): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '');
}

/**
 * Picks the locale from, in order: `?locale=` in the query string (also after the hash route),
 * the saved preference, the browser language, then English.
 */
export function resolveLocale(
  win: Pick<Window, 'location' | 'localStorage' | 'navigator'> = window,
): Locale {
  const fromUrl = (search: string) => new URLSearchParams(search).get('locale');
  const hashQuery = win.location.hash.includes('?')
    ? win.location.hash.slice(win.location.hash.indexOf('?'))
    : '';
  for (const candidate of [fromUrl(win.location.search), fromUrl(hashQuery)]) {
    if (isLocale(candidate)) return candidate;
  }
  let saved: string | null = null;
  try {
    saved = win.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; fall through to the browser language.
  }
  if (isLocale(saved)) return saved;
  const language = win.navigator.language?.toLowerCase() ?? '';
  return language.startsWith('en') || language === '' ? 'en' : 'en';
}

export function messagesFor(locale: Locale): Record<string, string> {
  if (locale === 'en-XA') {
    return Object.fromEntries(
      Object.entries(messagesEn).map(([id, text]) => [id, pseudoLocalize(text)]),
    );
  }
  return { ...messagesEn };
}
