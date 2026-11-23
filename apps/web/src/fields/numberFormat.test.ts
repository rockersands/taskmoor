import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { numberShowOf, numberText } from './numberFormat';

const en = createIntl({ locale: 'en', messages: {} });
const es = createIntl({ locale: 'es', messages: {} });

describe('how a number shows (T-320)', () => {
  it('[CORE-010] reads a number field’s format, decimals and currency', () => {
    expect(numberShowOf('number', {})).toBeNull();
    expect(numberShowOf('number', undefined)).toBeNull();
    expect(numberShowOf('number', { decimals: 1 })).toEqual({ style: 'number', decimals: 1 });
    expect(numberShowOf('number', { format: 'currency', currency: 'EUR', decimals: 2 })).toEqual({
      style: 'currency',
      decimals: 2,
      currency: 'EUR',
    });
    expect(numberShowOf('number', { format: 'percentage' })).toEqual({ style: 'percentage' });
    // A formula shows its number, currency and percentage outputs the same way.
    expect(numberShowOf('formula', { output: 'currency', currency: 'USD' })).toEqual({
      style: 'currency',
      currency: 'USD',
    });
    expect(numberShowOf('formula', { output: 'date' })).toBeNull();
    expect(numberShowOf('text', { format: 'currency', currency: 'EUR' })).toBeNull();
  });

  it('[CORE-010] writes the value in the reader’s locale, 40 as 40%', () => {
    expect(numberText(en, 1234.5, { style: 'currency', currency: 'EUR', decimals: 2 })).toBe(
      '€1,234.50',
    );
    expect(numberText(es, 1234.5, { style: 'currency', currency: 'EUR', decimals: 2 })).toBe(
      '1234,50 €',
    );
    expect(numberText(en, 40, { style: 'percentage' })).toBe('40%');
    expect(numberText(en, 12.345, { style: 'percentage' })).toBe('12.345%');
    expect(numberText(en, 12.5, { style: 'percentage', decimals: 0 })).toBe('13%');
    expect(numberText(en, 3, { style: 'number', decimals: 1 })).toBe('3.0');
    expect(numberText(en, 1234.5, null)).toBe('1,234.5');
  });
});
