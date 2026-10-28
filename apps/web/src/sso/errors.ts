import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { SsoProviderSummary } from './client';

/** The reasons the backend sends a failed single sign-on back with (`#/sign-in?sso_error=`). */
export const SSO_ERROR_CODES = [
  'invalid_state',
  'provider_error',
  'provider_unavailable',
  'email_unverified',
  'domain_not_allowed',
  'no_account',
  'account_deactivated',
] as const;

const MESSAGES: Record<(typeof SSO_ERROR_CODES)[number], MessageId> = {
  invalid_state: 'auth.sso.error.invalidState',
  provider_error: 'auth.sso.error.providerError',
  provider_unavailable: 'auth.sso.error.providerUnavailable',
  email_unverified: 'auth.sso.error.emailUnverified',
  domain_not_allowed: 'auth.sso.error.domainNotAllowed',
  no_account: 'auth.sso.error.noAccount',
  account_deactivated: 'auth.sso.error.accountDeactivated',
};

/** A plain sentence for a failed single sign-on; codes this frontend does not know get one too. */
export function ssoErrorMessage(t: Translate, code: string): string {
  // The code comes from the address: only the table's own keys, never `toString` and the like.
  const id = Object.hasOwn(MESSAGES, code)
    ? (MESSAGES as Record<string, MessageId>)[code]
    : undefined;
  return t(id ?? 'auth.sso.error.unknown');
}

/** The provider of a 403 `sso_required` answer to a password sign-in (IAM-004), or null. */
export function ssoRequiredProvider(error: unknown): SsoProviderSummary | null {
  if (!(error instanceof ApiError) || error.status !== 403 || error.code !== 'sso_required') {
    return null;
  }
  const provider = (error.body as { provider?: Partial<SsoProviderSummary> } | null)?.provider;
  return typeof provider?.id === 'number' && typeof provider.name === 'string'
    ? {
        id: provider.id,
        name: provider.name,
        ...(provider.protocol === 'saml' ? { protocol: 'saml' as const } : {}),
      }
    : null;
}
