import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { type AccountClient, accountClient } from './client';
import { PasswordSection } from './PasswordSection';
import { ProfileSection } from './ProfileSection';
import { SessionsSection } from './SessionsSection';

export interface AccountPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: AccountClient;
}

/**
 * The signed-in person's own settings (#/account): profile (IAM-008), password (IAM-001) and
 * sessions (IAM-004). The route sits behind RequireSession.
 */
export function AccountPage({ client = accountClient }: AccountPageProps) {
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
        <SessionsSection key={sessionsVersion} client={client} timeZone={user.timeZone} />
      </div>
    </div>
  );
}
