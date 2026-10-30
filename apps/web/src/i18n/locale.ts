import { messagesEn } from './messages.en';
import { messagesEs } from './messages.es';
import { pseudoBidi, pseudoLocalize } from './pseudo';

/**
 * English, and Spanish as a machine draft awaiting review (M1-116). `en-XA` is the
 * pseudo-locale: every string accented, lengthened and bracketed. `ar-XB` is the bidi
 * pseudo-locale (M1-116): every string right to left and the layout mirrored, which is how the
 * app is checked for right-to-left scripts before one ships.
 */
export const SUPPORTED_LOCALES = ['en', 'es', 'en-XA', 'ar-XB'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const STORAGE_KEY = 'taskmoor.locale';

/**
 * Catalogues still in draft (machine translations awaiting a native speaker's review). They
 * are used only when chosen, with `?locale=` or a saved preference, never because of the
 * browser's language. Taking a locale off this list is the review's sign-off.
 */
export const DRAFT_LOCALES: readonly Locale[] = ['es'];

/** Locales written right to left: the page gets `dir="rtl"` and a mirrored layout. */
const RTL_LOCALES: readonly Locale[] = ['ar-XB'];
export const isRtl = (locale: Locale) => RTL_LOCALES.includes(locale);

/**
 * The locale numbers, dates and plurals are formatted in. The pseudo-locales format like
 * English, so only their text and direction differ.
 */
export const formatLocale = (locale: Locale): string =>
  locale === 'en-XA' || locale === 'ar-XB' ? 'en' : locale;

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
  // The browser's language picks a reviewed catalogue; anything else is English.
  const language = win.navigator.language?.toLowerCase() ?? '';
  const spoken = SUPPORTED_LOCALES.find(
    (l) => !l.includes('-') && (language === l || language.startsWith(`${l}-`)),
  );
  return spoken && !DRAFT_LOCALES.includes(spoken) ? spoken : 'en';
}

/** Whether the address asks for a locale with `?locale=` (which then wins over everything). */
export function localeInUrl(win: Pick<Window, 'location'> = window): boolean {
  const query = (search: string) => new URLSearchParams(search).get('locale');
  const hash = win.location.hash;
  const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  return isLocale(query(win.location.search)) || isLocale(query(hashQuery));
}

/**
 * The catalogue for the language a person saved on their account (a BCP 47 tag such as
 * `es-MX`): by its language, English for languages without one. Null when nothing is saved,
 * so the browser's language decides. Choosing a draft language there is opting in to it.
 */
export function catalogueFor(tag: string | null): Locale | null {
  if (!tag) return null;
  const language = tag.toLowerCase().split('-')[0] ?? '';
  return SUPPORTED_LOCALES.find((l) => !l.includes('-') && l === language) ?? 'en';
}

/** Remembers the locale in this browser, so the next visit starts in it. */
export function rememberLocale(locale: Locale, win: Pick<Window, 'localStorage'> = window): void {
  try {
    win.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage can be blocked; the account's choice still applies once signed in.
  }
}

export function messagesFor(locale: Locale): Record<string, string> {
  if (locale === 'en-XA') {
    return Object.fromEntries(
      Object.entries(messagesEn).map(([id, text]) => [id, pseudoLocalize(text)]),
    );
  }
  if (locale === 'ar-XB') {
    return Object.fromEntries(
      Object.entries(messagesEn).map(([id, text]) => [id, pseudoBidi(text)]),
    );
  }
  if (locale === 'es') return { ...messagesEs };
  return { ...messagesEn };
}
