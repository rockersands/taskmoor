import type { IntlShape } from 'react-intl';
import type { Translate } from '../i18n/I18nProvider';

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** A byte count as people read it: "512 B", "1.5 MB", "1 GB" (powers of 1024). */
export function formatSize(t: Translate, intl: IntlShape, bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = intl.formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 1 });
  return t(`attachments.${UNITS[unit] ?? 'byte'}`, { value: number });
}
