import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { type NotificationsClient, notificationsClient } from '../notifications/client';
import { NotificationsSection } from '../notifications/NotificationsSection';
import { currentRoute } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { type PersonalTokensClient, personalTokensClient } from '../tokens/client';
import { TokensSection } from '../tokens/TokensSection';
import { AppearanceSection } from './AppearanceSection';
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
  /** Notification settings (M1-057); stories and tests pass their own. */
  notifications?: NotificationsClient;
}

/**
 * The signed-in person's own settings (#/account): profile (IAM-008), appearance, notifications
 * (NTF-004), password and two-factor authentication (IAM-001, M1-084), sessions (IAM-004) and
 * API tokens (IAM-007). The route sits behind RequireSession; #/account/notifications, where
 * notification emails link, opens it at the notification settings.
 */
export function AccountPage({
  client = accountClient,
  tokens = personalTokensClient,
  notifications = notificationsClient,
}: AccountPageProps) {
  const t = useT();
  const { session } = useSession();
  const signedIn = session.status === 'signed-in';
  useEffect(() => {
    if (!signedIn || !currentRoute().startsWith('#/account/notifications')) return;
    const section = document.getElementById('notifications');
    section?.scrollIntoView?.();
    section?.querySelector<HTMLElement>('h2')?.focus();
  }, [signedIn]);
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
        <AppearanceSection user={user} client={client} />
        <NotificationsSection client={notifications} />
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
