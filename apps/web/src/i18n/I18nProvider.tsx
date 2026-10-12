import { type ReactNode, useMemo } from 'react';
import { IntlProvider, type IntlShape, useIntl } from 'react-intl';
import { type Locale, messagesFor } from './locale';
import type { MessageId } from './messages.en';

export interface I18nProviderProps {
  locale: Locale;
  children: ReactNode;
  /** Receives every missing or malformed message; tests fail the run on any. */
  onError?: (error: Error) => void;
}

export function I18nProvider({ locale, children, onError }: I18nProviderProps) {
  const messages = useMemo(() => messagesFor(locale), [locale]);
  return (
    <IntlProvider
      locale={locale}
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

/** Typed access to the catalogue: `t('nav.home')` only accepts known IDs. */
export function useT(): (id: MessageId, values?: Record<string, string | number>) => string {
  const intl: IntlShape = useIntl();
  return (id, values) => intl.formatMessage({ id }, values);
}
