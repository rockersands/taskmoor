/** IANA time zones this browser knows, plus UTC and the saved zone even when the list lacks them. */
export function timeZoneOptions(saved: string | null): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Browsers without Intl.supportedValuesOf still offer UTC and the saved zone.
  }
  return [...new Set([...zones, 'UTC', ...(saved ? [saved] : [])])].sort();
}

/**
 * Locales offered for dates and numbers: widely used language and region pairs. Any other
 * saved locale stays selectable. The backend accepts every valid BCP 47 tag.
 */
export const LOCALE_CHOICES = [
  'cs-CZ',
  'da-DK',
  'de-AT',
  'de-CH',
  'de-DE',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-IE',
  'en-IN',
  'en-NZ',
  'en-US',
  'es-AR',
  'es-ES',
  'es-MX',
  'fi-FI',
  'fr-BE',
  'fr-CA',
  'fr-CH',
  'fr-FR',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'nb-NO',
  'nl-BE',
  'nl-NL',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'sv-SE',
  'tr-TR',
  'uk-UA',
  'zh-CN',
  'zh-TW',
] as const;

export interface LocaleOption {
  value: string;
  /** The locale's name in the display language, such as "English (United Kingdom)". */
  label: string;
}

export function localeOptions(displayLocale: string, saved: string | null): LocaleOption[] {
  const tags: string[] = [...LOCALE_CHOICES];
  if (saved && !tags.includes(saved)) tags.push(saved);
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([displayLocale, 'en'], {
      type: 'language',
      languageDisplay: 'standard',
    });
  } catch {
    // Without Intl.DisplayNames the tags themselves are the labels.
  }
  const label = (tag: string) => {
    try {
      return names?.of(tag) ?? tag;
    } catch {
      return tag;
    }
  };
  const collator = new Intl.Collator([displayLocale, 'en']);
  return tags
    .map((tag) => ({ value: tag, label: label(tag) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
