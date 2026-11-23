import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type NotificationsClient, notificationsClient } from '../notifications/client';
import { NotificationsSection } from '../notifications/NotificationsSection';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import { type PersonalTokensClient, personalTokensClient } from '../tokens/client';
import { TokensSection } from '../tokens/TokensSection';
import { AppearanceSection } from './AppearanceSection';
import { type AccountClient, accountClient } from './client';
import { PasswordSection } from './PasswordSection';
import { PersonalDataSection } from './PersonalDataSection';
import { ProfileSection } from './ProfileSection';
import { ownDataClient, type PersonalDataClient } from './personalData';
import { SessionsSection } from './SessionsSection';
import { TwoFactorSection } from './TwoFactorSection';

/**
 * Account's sections, each at its own address (D17): emails link to the notifications, and each
 * section's intro names what it holds.
 */
export const ACCOUNT_SECTIONS = [
  { id: 'profile', path: '', labelId: 'account.section.profile', introId: 'account.intro.profile' },
  {
    id: 'notifications',
    path: '/notifications',
    labelId: 'account.section.notifications',
    introId: 'account.intro.notifications',
  },
  {
    id: 'security',
    path: '/security',
    labelId: 'account.section.security',
    introId: 'account.intro.security',
  },
  {
    id: 'tokens',
    path: '/tokens',
    labelId: 'account.section.tokens',
    introId: 'account.intro.tokens',
  },
  { id: 'data', path: '/data', labelId: 'account.section.data', introId: 'account.intro.data' },
] as const satisfies readonly {
  id: string;
  path: string;
  labelId: MessageId;
  introId: MessageId;
}[];

export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]['id'];

/** The section a route under #/account names; null for one that names no section. */
export function accountSectionOf(route: string): AccountSection | null {
  const path = /^#\/account(\/[^?#]*)?(?:\?.*)?$/.exec(route)?.[1]?.replace(/\/$/, '') ?? '';
  return ACCOUNT_SECTIONS.find((section) => section.path === path)?.id ?? null;
}

export interface AccountPageProps {
  /** Which section shows; Profile at #/account itself. */
  section?: AccountSection;
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: AccountClient;
  /** The person's API tokens; stories and tests pass their own. */
  tokens?: PersonalTokensClient;
  /** Notification settings (M1-057); stories and tests pass their own. */
  notifications?: NotificationsClient;
  /** Downloads of one's own data (ASVS 8.3.2); stories and tests pass their own. */
  personalData?: PersonalDataClient;
}

/**
 * The signed-in person's own settings (#/account), in sections at their own addresses (D17):
 * Profile with appearance (IAM-008), Notifications (NTF-004), Security with the password,
 * two-factor authentication (IAM-001, M1-084) and sessions (IAM-004), API tokens (IAM-007), and
 * a download of one's own data (ASVS 8.3.2, ADR-111). The route sits behind the session.
 */
export function AccountPage({
  section = 'profile',
  client = accountClient,
  tokens = personalTokensClient,
  notifications = notificationsClient,
  personalData = ownDataClient,
}: AccountPageProps) {
  const t = useT();
  const { session } = useSession();
  // A password change signs other sessions out; a new key re-reads the list.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const shown = ACCOUNT_SECTIONS.find((s) => s.id === section) ?? ACCOUNT_SECTIONS[0];
  if (session.status !== 'signed-in') return null;
  const { user } = session;

  return (
    <div className="page account-page">
      <PageHeader
        title={t('account.title')}
        purpose={t(shown.introId)}
        about={t('about.account')}
      />
      {/* The row stays across sections, so the link chosen keeps focus; the content changes. On a
          phone it wraps, so every section shows. */}
      <nav className="account-tabs" aria-label={t('account.sections')}>
        <ul>
          {ACCOUNT_SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={routeHref(`#/account${s.path}`)}
                aria-current={s.id === shown.id ? 'page' : undefined}
              >
                {t(s.labelId)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div key={shown.id} className="account-sections">
        {shown.id === 'profile' && (
          <>
            <ProfileSection user={user} client={client} />
            <AppearanceSection user={user} client={client} />
          </>
        )}
        {shown.id === 'notifications' && <NotificationsSection client={notifications} />}
        {shown.id === 'security' && (
          <>
            <PasswordSection
              email={user.email}
              client={client}
              onChanged={() => setSessionsVersion((version) => version + 1)}
            />
            <TwoFactorSection client={client} email={user.email} timeZone={user.timeZone} />
            <SessionsSection key={sessionsVersion} client={client} timeZone={user.timeZone} />
          </>
        )}
        {shown.id === 'tokens' && (
          <TokensSection client={tokens} allowAdmin={user.isSiteAdmin} timeZone={user.timeZone} />
        )}
        {shown.id === 'data' && (
          <PersonalDataSection client={personalData} timeZone={user.timeZone} />
        )}
      </div>
    </div>
  );
}
