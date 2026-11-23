import { useId } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import {
  type FieldConfig,
  type FieldType,
  NUMBER_FORMATS,
  type NumberFormat,
  PARAGRAPH_DEFAULT_MAX,
  PARAGRAPH_LIMIT,
} from './client';
import { numberShowOf, numberText } from './numberFormat';

/** Types whose settings this control edits; a choice list's display stays API-only in 1.0. */
export const SETTINGS_TYPES: ReadonlySet<string> = new Set(['paragraph', 'number']);

export interface FieldSettingsProps {
  type: FieldType;
  config: FieldConfig;
  onChange: (config: FieldConfig) => void;
}

/** A sample amount, to show what a number format does to a value. */
const SAMPLE = 1234.5;

/**
 * A field's type settings (CORE-010; T-320), for New field and Manage: a paragraph's most
 * characters; a number's format, decimals and currency, with a sample of how values will read on
 * the ticket page and in lists. Settings other types keep (a formula's, a choice list's display)
 * are not touched: the caller sends the whole object, as `PATCH /fields/:id` replaces it.
 */
export function FieldSettings({ type, config, onChange }: FieldSettingsProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  if (type === 'paragraph') {
    return (
      <div className="form-field">
        <label htmlFor={`${id}-max`} className="form-label">
          {t('admin.fields.settings.maxChars')}
        </label>
        <input
          id={`${id}-max`}
          type="number"
          inputMode="numeric"
          min={1}
          max={PARAGRAPH_LIMIT}
          step={1}
          aria-describedby={`${id}-max-hint`}
          value={config.maxChars ?? ''}
          onChange={(event) => {
            const { maxChars: _, ...rest } = config;
            const typed = event.target.value.trim();
            onChange(typed === '' ? rest : { ...rest, maxChars: Number(typed) });
          }}
        />
        <p id={`${id}-max-hint`} className="form-hint">
          {t('admin.fields.settings.maxCharsHint', {
            usual: intl.formatNumber(PARAGRAPH_DEFAULT_MAX),
            most: intl.formatNumber(PARAGRAPH_LIMIT),
          })}
        </p>
      </div>
    );
  }
  if (type !== 'number') return null;
  const format: NumberFormat = config.format ?? 'number';
  const show = numberShowOf('number', config);
  const change = (next: { format?: NumberFormat; decimals?: number; currency?: string }) => {
    const merged = { ...config, ...next };
    const out: FieldConfig = {};
    if (merged.format && merged.format !== 'number') out.format = merged.format;
    if (merged.decimals !== undefined) out.decimals = merged.decimals;
    // A currency code goes with the currency format only, as the server checks.
    if (out.format === 'currency') out.currency = merged.currency ?? '';
    onChange(out);
  };
  return (
    <fieldset className="sets-choices">
      <legend>{t('admin.fields.settings.numberLegend')}</legend>
      <div className="form-field">
        <label htmlFor={`${id}-format`} className="form-label">
          {t('admin.fields.settings.format')}
        </label>
        <select
          id={`${id}-format`}
          value={format}
          onChange={(event) => change({ format: event.target.value as NumberFormat })}
        >
          {NUMBER_FORMATS.map((f) => (
            <option key={f} value={f}>
              {t(`admin.fields.settings.format.${f}` as MessageId)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-decimals`} className="form-label">
          {t('admin.fields.settings.decimals')}
        </label>
        <DecimalsSelect
          id={`${id}-decimals`}
          value={config.decimals}
          onChange={(decimals) => {
            const { decimals: _, ...rest } = config;
            onChange(decimals === undefined ? rest : { ...rest, decimals });
          }}
        />
      </div>
      {format === 'currency' && (
        <CurrencyInput
          id={`${id}-currency`}
          value={config.currency ?? ''}
          onChange={(currency) => change({ currency })}
        />
      )}
      <p className="form-hint">
        {t('admin.fields.settings.sample', {
          plain: intl.formatNumber(SAMPLE),
          shown:
            show && (show.style !== 'currency' || /^[A-Z]{3}$/.test(show.currency ?? ''))
              ? numberText(intl, SAMPLE, show)
              : intl.formatNumber(SAMPLE),
        })}
      </p>
    </fieldset>
  );
}

/** Decimals 0 to 3, or none set. */
export function DecimalsSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | undefined;
  onChange: (decimals: number | undefined) => void;
}) {
  const t = useT();
  return (
    <select
      id={id}
      value={value === undefined ? '' : String(value)}
      onChange={(event) =>
        onChange(event.target.value === '' ? undefined : Number(event.target.value))
      }
    >
      <option value="">{t('admin.fields.settings.decimalsAny')}</option>
      {[0, 1, 2, 3].map((n) => (
        <option key={n} value={String(n)}>
          {n}
        </option>
      ))}
    </select>
  );
}

/** A currency's three-letter code, such as EUR, upper-cased as typed. */
export function CurrencyInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (currency: string) => void;
}) {
  const t = useT();
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {t('admin.fields.settings.currency')}
      </label>
      <input
        id={id}
        type="text"
        required
        maxLength={3}
        pattern="[A-Za-z]{3}"
        autoCapitalize="characters"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.fields.settings.currencyHint')}
      </p>
    </div>
  );
}
