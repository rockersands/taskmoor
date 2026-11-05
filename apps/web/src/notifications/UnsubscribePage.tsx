import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { currentRoute, routeHref } from '../routing/router';
import { passwordTokenFromHash } from '../session/PasswordLinkPage';
import { PageHeader } from '../shell/PageHeader';
import { type UnsubscribeClient, type UnsubscribeLink, unsubscribeClient } from './client';

export interface UnsubscribePageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: UnsubscribeClient;
}

type State =
  | { status: 'no-token' }
  | { status: 'checking' }
  | { status: 'ready'; link: UnsubscribeLink }
  | { status: 'busy'; link: UnsubscribeLink }
  | { status: 'done'; link: UnsubscribeLink }
  | { status: 'invalid' }
  | { status: 'failed'; link: UnsubscribeLink };

/**
 * Where the unsubscribe link of a notification email lands (#/unsubscribe?token=..., M1-057,
 * NTF-002). Like the password link page it stands alone, without a session: the link's token is
 * the proof. Opening the page changes nothing (mail scanners open links); the button does.
 */
export function UnsubscribePage({ client = unsubscribeClient }: UnsubscribePageProps) {
  const t = useT();
  const token = passwordTokenFromHash(currentRoute());
  const [state, setState] = useState<State>(
    token ? { status: 'checking' } : { status: 'no-token' },
  );

  useEffect(() => {
    if (!token) return;
    let live = true;
    client.inspect(token).then(
      (link) => live && setState({ status: 'ready', link }),
      () => live && setState({ status: 'invalid' }),
    );
    return () => {
      live = false;
    };
  }, [client, token]);

  const what = (link: UnsubscribeLink) =>
    link.event === null
      ? t('unsubscribe.allEmail')
      : t('unsubscribe.oneEvent', {
          event: t(`notifications.event.${link.event}` as MessageId),
        });

  const confirm = async (link: UnsubscribeLink) => {
    if (!token) return;
    setState({ status: 'busy', link });
    try {
      await client.confirm(token);
      setState({ status: 'done', link });
    } catch {
      setState({ status: 'failed', link });
    }
  };

  let body: ReactNode;
  switch (state.status) {
    case 'no-token':
    case 'invalid':
      body = <p className="page-note">{t('unsubscribe.invalid')}</p>;
      break;
    case 'checking':
      body = (
        <p className="page-note" role="status">
          {t('unsubscribe.checking')}
        </p>
      );
      break;
    case 'done':
      body = (
        <>
          <p className="page-note" role="status">
            {t('unsubscribe.done', { what: what(state.link) })}
          </p>
          <a className="button-primary setup-link" href={routeHref('#/account/notifications')}>
            {t('unsubscribe.settings')}
          </a>
        </>
      );
      break;
    default: {
      const link = state.link;
      body = (
        <>
          <p className="page-note">
            {t('unsubscribe.question', { what: what(link), email: link.email })}
          </p>
          <button
            type="button"
            className="button-primary"
            disabled={state.status === 'busy'}
            onClick={() => confirm(link)}
          >
            {t('unsubscribe.confirm')}
          </button>
          {state.status === 'failed' && (
            <p className="form-error" role="alert">
              {t('unsubscribe.failed')}
            </p>
          )}
        </>
      );
    }
  }
  return (
    <main className="setup">
      <PageHeader title={t('unsubscribe.title')} purpose={t('purpose.unsubscribe')} />
      <div className="glass-card account-section">{body}</div>
    </main>
  );
}
