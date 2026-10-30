import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { runtimeConfig } from '../runtime/config';
import { type OAuthClient, oauthClient } from './oauth';

export interface OAuthSignInProps {
  /** Go to the backend at once (a page that needs a session), or wait for the button. */
  auto?: boolean;
  /** Stories and tests pass their own client. */
  client?: Pick<OAuthClient, 'begin' | 'failure'>;
  /** Where people sign in: the backend's host. */
  host?: string;
}

const backendHost = () => (runtimeConfig.apiUrl ? new URL(runtimeConfig.apiUrl).host : '');

/**
 * Signing in when the app's backend is on another site (M1-107, ADR-080): people sign in on
 * the backend's own page, which sends them back here. A page that needs a session goes there
 * at once; the sign-in page, and a sign-in that came back without a session, wait for the
 * button instead, so a failing backend cannot send the page back and forth.
 */
export function OAuthSignIn({
  auto = false,
  client = oauthClient ?? undefined,
  host = backendHost(),
}: OAuthSignInProps) {
  const t = useT();
  const failure = client?.failure() ?? null;
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!auto || !client || failure) return;
    let live = true;
    void client.begin({ auto: true }).then((went) => {
      if (live) setLeaving(went);
    });
    return () => {
      live = false;
    };
  }, [auto, client, failure]);

  const note = failure
    ? t('auth.oauth.failed')
    : leaving
      ? t('auth.oauth.leaving', { host })
      : t('auth.oauth.explanation', { host });
  return (
    <div className="oauth-sign-in">
      <p className="page-note" role={failure ? 'alert' : undefined} aria-live="polite">
        {note}
      </p>
      {!leaving && (
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            setLeaving(true);
            void client?.begin();
          }}
        >
          {t('auth.oauth.continue', { host })}
        </button>
      )}
    </div>
  );
}
