import { type ReactNode, useEffect, useMemo } from 'react';
import { IntlProvider, type IntlShape, useIntl } from 'react-intl';
import { formatLocale, isRtl, type Locale, messagesFor } from './locale';
import type { MessageId } from './messages.en';

export interface I18nProviderProps {
  locale: Locale;
  /**
   * The zone times are written in unless a call names another: the person's account zone
   * (T-280). Without one, the device's.
   */
  timeZone?: string | null;
  children: ReactNode;
  /** Receives every missing or malformed message; tests fail the run on any. */
  onError?: (error: Error) => void;
}

export function I18nProvider({ locale, timeZone, children, onError }: I18nProviderProps) {
  const messages = useMemo(() => messagesFor(locale), [locale]);
  // The page says its language and direction, for assistive technology and the mirrored layout.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = isRtl(locale) ? 'rtl' : 'ltr';
  }, [locale]);
  return (
    <IntlProvider
      locale={formatLocale(locale)}
      {...(timeZone ? { timeZone } : {})}
      defaultLocale="en"
      messages={messages}
      onError={onError ?? defaultOnError}
    >
      {children}
    </IntlProvider>
  );
}

function defaultOnError(error: Error): void {
  // A missing string is a bug, not a warning; surface it loudly outside production.
  if (import.meta.env.DEV) throw error;
  console.error(error.message);
}

/** A message formatter: `t('nav.home')` only accepts known IDs. */
export type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

/** Typed access to the catalogue. */
export function useT(): Translate {
  const intl: IntlShape = useIntl();
  return (id, values) => intl.formatMessage({ id }, values);
}
