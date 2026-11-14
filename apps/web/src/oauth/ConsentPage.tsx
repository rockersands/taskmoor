import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { currentRoute } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { StandaloneFrame, StandaloneNote } from '../shell/StandaloneFrame';
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
  /** The address names no request at all. */
  | { status: 'no-request' }
  | { status: 'ready'; request: ConsentRequest }
  | { status: 'busy'; request: ConsentRequest }
  | { status: 'leaving' }
  | { status: 'error'; failure: ConsentFailure; request?: ConsentRequest };

/**
 * Where an MCP client's authorization lands (#/oauth/consent?request=..., M1-072; API-002 (3);
 * ADR-084): who asks, what it may do and where it sends the person back. Nothing happens until
 * the person answers; the client may get less than it asked for (reading only), never more.
 * Someone signed out learns at once when the request is unknown or has expired (D35); for one
 * that is waiting, the frame's way out signs in and comes back to it (D24).
 */
export function ConsentPage({ client = consentClient }: ConsentPageProps) {
  const t = useT();
  const id = useId();
  const requestId = hashParam(currentRoute(), 'request');
  const [state, setState] = useState<State>(
    requestId ? { status: 'loading' } : { status: 'no-request' },
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
  } else if (state.status === 'no-request') {
    body = t('consent.noRequest');
  } else if (state.status === 'error' && !state.request) {
    // Signing in is the way on, not a fault: a note; an unknown or failed request is an alert.
    body =
      state.failure === 'signed-out' ? (
        <p className="page-note">{t('consent.signedOut')}</p>
      ) : state.failure === 'gone' ? (
        t('consent.gone')
      ) : (
        t('consent.failed')
      );
  } else {
    const request = (state as { request: ConsentRequest }).request;
    const place = redirectPlace(request.redirectUri);
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
  // Signing in comes back to the request, by the address the server sent the person here with.
  const signInRoute =
    state.status === 'error' && state.failure === 'signed-out' && requestId
      ? `#/sign-in?continue=${encodeURIComponent(
          `/api/v1/oauth/authorize?request=${encodeURIComponent(requestId)}`,
        )}`
      : '#/sign-in';
  const problem =
    state.status === 'no-request' ||
    (state.status === 'error' && !state.request && state.failure !== 'signed-out');
  // The intro is for a request that can be answered; with a problem it would contradict it.
  const purpose =
    'request' in state && state.request
      ? t('consent.intro', { name: state.request.client.name })
      : state.status === 'loading'
        ? t('purpose.consent')
        : null;
  return (
    <StandaloneFrame signInRoute={signInRoute}>
      <main className="setup">
        <PageHeader title={title} {...(purpose ? { purpose } : {})} />
        {/* A request that cannot be answered is an alert, as on every link page (D24). */}
        {problem ? (
          <StandaloneNote kind="problem">{body}</StandaloneNote>
        ) : (
          <div className="glass-card account-section">{body}</div>
        )}
      </main>
    </StandaloneFrame>
  );
}
