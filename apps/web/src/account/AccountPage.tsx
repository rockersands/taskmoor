import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { type PersonalTokensClient, personalTokensClient } from '../tokens/client';
import { TokensSection } from '../tokens/TokensSection';
import { type AccountClient, accountClient } from './client';
import { PasswordSection } from './PasswordSection';
import { ProfileSection } from './ProfileSection';
import { SessionsSection } from './SessionsSection';
import { TwoFactorSection } from './TwoFactorSection';

export interface AccountPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: AccountClient;
  /** The person's API tokens; stories and tests pass their own. */
  tokens?: PersonalTokensClient;
}

/**
 * The signed-in person's own settings (#/account): profile (IAM-008), password and two-factor
 * authentication (IAM-001, M1-084), sessions (IAM-004) and API tokens (IAM-007). The route
 * sits behind RequireSession.
 */
export function AccountPage({
  client = accountClient,
  tokens = personalTokensClient,
}: AccountPageProps) {
  const t = useT();
  const { session } = useSession();
  // A password change signs other sessions out; a new key re-reads the list.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  if (session.status !== 'signed-in') return null;
  const { user } = session;

  return (
    <div className="account-page">
      <h1 className="page-title">{t('account.title')}</h1>
      <p className="page-note">{t('account.intro')}</p>
      <div className="account-sections">
        <ProfileSection user={user} client={client} />
        <PasswordSection
          email={user.email}
          client={client}
          onChanged={() => setSessionsVersion((version) => version + 1)}
        />
        <TwoFactorSection client={client} email={user.email} timeZone={user.timeZone} />
        <SessionsSection key={sessionsVersion} client={client} timeZone={user.timeZone} />
        <TokensSection client={tokens} allowAdmin={user.isSiteAdmin} timeZone={user.timeZone} />
      </div>
    </div>
  );
}
