import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { ApiToken, TokenPolicy, TokenScope } from './client';

const DAY_MS = 86_400_000;

export const SCOPE_LABELS: Record<TokenScope, MessageId> = {
  read: 'tokens.scope.read',
  write: 'tokens.scope.write',
  admin: 'tokens.scope.admin',
  scim: 'tokens.scope.scim',
};

export const SCOPE_HINTS: Record<TokenScope, MessageId> = {
  read: 'tokens.scopeHint.read',
  write: 'tokens.scopeHint.write',
  admin: 'tokens.scopeHint.admin',
  scim: 'tokens.scopeHint.scim',
};

/** The lifetimes a new token can be given, within the policy's maximum. */
export function expiryChoices(policy: TokenPolicy): number[] {
  const max = policy.maxLifetimeDays;
  const choices = [7, 30, 60, 90, 180, 365].filter((d) => d <= max);
  if (!choices.includes(max)) choices.push(max);
  return choices;
}

/** Thirty days when the policy allows it, otherwise the longest it allows. */
export function defaultExpiry(policy: TokenPolicy): number {
  return Math.min(30, policy.maxLifetimeDays);
}

/** Whole days until `iso`, counted from `now` (0 on the last day). */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((Date.parse(iso) - now) / DAY_MS));
}

/** True for a live token that expires within the reminder window and was not replaced yet. */
export function dueForRotation(token: ApiToken, reminderDays: number, now = Date.now()): boolean {
  return (
    token.status === 'active' &&
    token.replacedBy === null &&
    Date.parse(token.expiresAt) - now <= reminderDays * DAY_MS
  );
}

/** Dates, scopes and data values of tokens in the reader's language and time zone. */
export function useTokenText(timeZone: string | null | undefined) {
  const t = useT();
  const intl = useIntl();
  const zone = timeZone ? { timeZone } : {};
  return {
    /** User data (names, addresses) through the catalogue, so the pseudo-locale marks it. */
    value: (value: string) => t('common.value', { value }),
    when: (iso: string) =>
      intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short', ...zone }),
    day: (date: Date | string) => intl.formatDate(date, { dateStyle: 'medium', ...zone }),
    scopes: (scopes: readonly TokenScope[]) =>
      t('tokenInfo.scopes', {
        scopes: intl.formatList(
          scopes.map((s) => t(SCOPE_LABELS[s])),
          { type: 'conjunction' },
        ),
      }),
  };
}
