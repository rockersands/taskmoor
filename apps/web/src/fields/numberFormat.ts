import type { IntlShape } from 'react-intl';

/**
 * How a number field shows its values (CORE-010; T-320): as a number, an amount of a currency or
 * a percentage, with a set number of decimals. The stored value is the same whatever the format;
 * a percentage stores 40 for 40%. Formula fields with a number, currency or percentage output show
 * theirs the same way.
 */
export interface NumberShow {
  style: 'number' | 'currency' | 'percentage';
  /** 0 to 3; left out, a number keeps up to three decimals and an amount its currency's own. */
  decimals?: number;
  currency?: string;
}

/** The settings of `GET /fields` and the form model that say how a number shows. */
export interface NumberSettings {
  format?: string;
  output?: string;
  decimals?: number;
  currency?: string;
}

const STYLES = new Set(['number', 'currency', 'percentage']);

/**
 * How a field of `type` with these settings shows a number; null when it shows it plainly (a
 * number field with no settings), or when it holds no number.
 */
export function numberShowOf(type: string, config: NumberSettings | undefined): NumberShow | null {
  const style =
    type === 'number'
      ? (config?.format ?? 'number')
      : type === 'formula'
        ? config?.output
        : undefined;
  if (style === undefined || !STYLES.has(style)) return null;
  if (style === 'number' && config?.decimals === undefined) return null;
  if (style === 'currency' && !config?.currency) return null;
  return {
    style: style as NumberShow['style'],
    ...(config?.decimals !== undefined ? { decimals: config.decimals } : {}),
    ...(style === 'currency' ? { currency: config?.currency as string } : {}),
  };
}

/** A number as its field shows it, in the reader's locale: "€1,234.50", "40%", "3.0". */
export function numberText(intl: IntlShape, value: number, show: NumberShow | null): string {
  if (show === null) return intl.formatNumber(value);
  const digits =
    show.decimals === undefined
      ? {}
      : { minimumFractionDigits: show.decimals, maximumFractionDigits: show.decimals };
  try {
    if (show.style === 'currency' && show.currency) {
      return intl.formatNumber(value, { style: 'currency', currency: show.currency, ...digits });
    }
    if (show.style === 'percentage') {
      // Stored as 40 for 40%; up to three decimals unless set, as the value keeps.
      return intl.formatNumber(value / 100, {
        style: 'percent',
        ...(show.decimals === undefined ? { maximumFractionDigits: 3 } : digits),
      });
    }
  } catch {
    // A currency code the browser does not know: the number alone.
  }
  return intl.formatNumber(value, digits);
}
