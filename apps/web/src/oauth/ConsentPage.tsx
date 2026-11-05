import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { hashParam } from '../sso/client';
import {
  type ConsentClient,
  type ConsentFailure,
  type ConsentRequest,
  consentClient,
  consentFailure,
  redirectPlace,
} from './client';

export interface ConsentPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: ConsentClient;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; request: ConsentRequest }
  | { status: 'busy'; request: ConsentRequest }
  | { status: 'leaving' }
  | { status: 'error'; failure: ConsentFailure; request?: ConsentRequest };

/**
 * Where an MCP client's authorization lands (#/oauth/consent?request=..., M1-072; API-002 (3);
 * ADR-084): who asks, what it may do and where it sends the person back. Nothing happens until
 * the person answers; the client may get less than it asked for (reading only), never more.
 */
export function ConsentPage({ client = consentClient }: ConsentPageProps) {
  const t = useT();
  const id = useId();
  const requestId = hashParam(currentRoute(), 'request');
  const [state, setState] = useState<State>(
    requestId ? { status: 'loading' } : { status: 'error', failure: 'gone' },
  );
  const [changes, setChanges] = useState(true);

  useEffect(() => {
    if (!requestId) return;
    let live = true;
    client.load(requestId).then(
      (request) => live && setState({ status: 'ready', request }),
      (error) => live && setState({ status: 'error', failure: consentFailure(error) }),
    );
    return () => {
      live = false;
    };
  }, [client, requestId]);

  const answer = async (request: ConsentRequest, approve: boolean) => {
    if (!requestId) return;
    setState({ status: 'busy', request });
    const scope = request.scope === 'read write' && changes ? 'read write' : 'read';
    try {
      const redirect = await client.answer(requestId, approve, scope);
      setState({ status: 'leaving' });
      client.go(redirect);
    } catch (error) {
      setState({ status: 'error', failure: consentFailure(error), request });
    }
  };

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <p className="page-note" role="status">
        {t('consent.loading')}
      </p>
    );
  } else if (state.status === 'leaving') {
    body = (
      <p className="page-note" role="status">
        {t('consent.leaving')}
      </p>
    );
  } else if (state.status === 'error' && !state.request) {
    body =
      state.failure === 'signed-out' ? (
        <>
          <p className="page-note">{t('consent.signedOut')}</p>
          <a
            className="button-primary setup-link"
            href={routeHref(
              `#/sign-in?continue=${encodeURIComponent(
                `/api/v1/oauth/authorize?request=${encodeURIComponent(requestId ?? '')}`,
              )}`,
            )}
          >
            {t('consent.signIn')}
          </a>
        </>
      ) : (
        <p className="page-note">
          {state.failure === 'gone' ? t('consent.gone') : t('consent.failed')}
        </p>
      );
  } else {
    const request = (state as { request: ConsentRequest }).request;
    const place = redirectPlace(request.redirectUri);
    const name = request.client.name;
    const writes = request.scope === 'read write';
    body = (
      <>
        <ul className="consent-list">
          <li>{t('consent.reads')}</li>
          {writes && changes && <li>{t('consent.writes')}</li>}
          <li>
            {place.kind === 'site'
              ? t('consent.backToSite', { host: place.host })
              : place.kind === 'this-computer'
                ? t('consent.backToComputer')
                : t('consent.backToApp', { scheme: place.scheme })}
          </li>
        </ul>
        {writes && (
          <div className="form-field form-field-inline">
            <input
              id={`${id}-changes`}
              type="checkbox"
              checked={changes}
              onChange={(event) => setChanges(event.target.checked)}
            />
            <label htmlFor={`${id}-changes`}>{t('consent.allowChanges')}</label>
          </div>
        )}
        <p className="page-note">{t('consent.caution')}</p>
        <div className="form-actions">
          <button
            type="button"
            className="button-primary"
            disabled={state.status === 'busy'}
            onClick={() => answer(request, true)}
          >
            {t('consent.allow')}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={state.status === 'busy'}
            onClick={() => answer(request, false)}
          >
            {t('consent.deny')}
          </button>
        </div>
        {state.status === 'error' && (
          <p className="form-error" role="alert">
            {state.failure === 'gone' ? t('consent.gone') : t('consent.failed')}
          </p>
        )}
      </>
    );
  }

  const title =
    state.status === 'ready' || state.status === 'busy'
      ? t('consent.title', { name: state.request.client.name })
      : t('consent.titlePlain');
  return (
    <main className="setup">
      <PageHeader
        title={title}
        purpose={
          'request' in state && state.request
            ? t('consent.intro', { name: state.request.client.name })
            : t('purpose.consent')
        }
      />
      <div className="glass-card account-section">{body}</div>
    </main>
  );
}
