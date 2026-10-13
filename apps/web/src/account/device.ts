import type { Translate } from '../i18n/I18nProvider';

/** Browser and operating system read from a User-Agent header; null when not recognised. */
export interface Device {
  browser: string | null;
  os: string | null;
}

// Order matters: Edge, Opera and Samsung Internet also say "Chrome"; Chrome also says "Safari".
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium|HeadlessChrome)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

// iPhones and Android phones also mention "Mac OS X" and "Linux".
const SYSTEMS: readonly [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** A deliberately small User-Agent reader: enough to tell your own devices apart. */
export function parseUserAgent(userAgent: string | null): Device {
  if (!userAgent) return { browser: null, os: null };
  const find = (rules: readonly [RegExp, string][]) =>
    rules.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return { browser: find(BROWSERS), os: find(SYSTEMS) };
}

/** "Firefox on Linux", one of the two when only one is known, or "Unknown device". */
export function deviceName(t: Translate, userAgent: string | null): string {
  const { browser, os } = parseUserAgent(userAgent);
  if (browser && os) return t('account.device', { browser, os });
  const known = browser ?? os;
  return known ? t('common.value', { value: known }) : t('account.unknownDevice');
}
