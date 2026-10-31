import { type FrontendWindow, frontendSkew, type Skew } from '@taskmoor/webconfig';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';

/** A registered frontend as `GET /api/v1/admin/frontends` lists it (M1-108). */
export interface RegisteredFrontend {
  id: number;
  origin: string;
  label: string;
  redirectUris: string[];
  websocket: boolean;
  lastVersion: string | null;
  lastSeenAt: string | null;
  addedBy: { id: number; name: string } | null;
  createdAt: string;
  updatedAt: string;
  inEnvironment: boolean;
}

export interface FrontendsView {
  /** This server's own origin, and the frontend version it serves when it serves one. */
  self: { origin: string | null; servedVersion: string | null };
  backend: { version: string; frontend: FrontendWindow };
  /** TASKMOOR_ALLOWED_ORIGINS, read at start. */
  environment: { origin: string; redirectUris: string[] }[];
  frontends: RegisteredFrontend[];
}

export interface NewFrontend {
  origin: string;
  label?: string;
  redirectUris?: string[];
  websocket: boolean;
}

export interface FrontendsClient {
  load: () => Promise<FrontendsView>;
  add: (frontend: NewFrontend) => Promise<RegisteredFrontend>;
  remove: (id: number) => Promise<void>;
}

export const frontendsClient: FrontendsClient = {
  load: () => api('/admin/frontends'),
  add: async (frontend) =>
    (
      await api<{ frontend: RegisteredFrontend }>('/admin/frontends', {
        method: 'POST',
        body: frontend,
      })
    ).frontend,
  remove: async (id) => {
    await api(`/admin/frontends/${id}`, { method: 'DELETE' });
  },
};

const SKEW: Record<Skew, MessageId> = {
  current: 'admin.frontends.current',
  'update-available': 'admin.frontends.updateAvailable',
  'update-required': 'admin.frontends.updateRequired',
  unknown: 'admin.frontends.unknownVersion',
};

/** What went wrong with the add form, from the backend's answer. */
function addProblem(error: unknown): MessageId {
  if (!(error instanceof ApiError)) return 'admin.frontends.addFailed';
  if (error.code === 'origin_exists') return 'admin.frontends.exists';
  const fields = (error.body as { fields?: Record<string, string> } | null)?.fields ?? {};
  if (fields.origin === 'own_origin') return 'admin.frontends.ownOrigin';
  if (fields.origin) return 'admin.frontends.invalidOrigin';
  if (Object.keys(fields).some((k) => k.startsWith('redirectUris'))) {
    return 'admin.frontends.invalidRedirect';
  }
  return 'admin.frontends.addFailed';
}

/**
 * Frontends on other origins (M1-108; IAM-025, OPS-017): the ones site administrators register
 * here, with the version each last reported against what this backend wants, the ones the
 * server's environment lists, and this server's own origin with the frontend it serves.
 * Adding or removing one applies at once, without a restart.
 */
export function FrontendsPage({ client = frontendsClient }: { client?: FrontendsClient }) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const titleId = useId();
  const id = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [view, setView] = useState<FrontendsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [origin, setOrigin] = useState('');
  const [label, setLabel] = useState('');
  const [redirects, setRedirects] = useState('');
  const [websocket, setWebsocket] = useState(true);
  const [problem, setProblem] = useState<MessageId | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.load().then(
      (found) => live && setView(found),
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, notAdmin]);

  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  const reload = async () => setView(await client.load());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setStatus('');
    const uris = redirects
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const added = await client.add({
        origin: origin.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(uris.length > 0 ? { redirectUris: uris } : {}),
        websocket,
      });
      setOrigin('');
      setLabel('');
      setRedirects('');
      setWebsocket(true);
      setStatus(t('admin.frontends.added', { origin: added.origin }));
      await reload();
    } catch (error) {
      setProblem(addProblem(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (frontend: RegisteredFrontend) => {
    setBusy(true);
    setProblem(null);
    setStatus('');
    try {
      await client.remove(frontend.id);
      setConfirming(null);
      setStatus(t('admin.frontends.removed', { origin: frontend.origin }));
      await reload();
    } catch {
      setProblem('admin.frontends.removeFailed');
    } finally {
      setBusy(false);
    }
  };

  const versionLine = (frontend: RegisteredFrontend, window: FrontendWindow) => {
    if (!frontend.lastVersion || !frontend.lastSeenAt) {
      return <p className="page-note">{t('admin.frontends.notSeen')}</p>;
    }
    const skew = frontendSkew(frontend.lastVersion, window);
    return (
      <p className="page-note">
        {t('admin.frontends.seen', {
          version: frontend.lastVersion,
          when: when(frontend.lastSeenAt),
        })}{' '}
        <span
          className={
            skew === 'update-required'
              ? 'status-bad'
              : skew === 'update-available'
                ? 'status-warn'
                : skew === 'current'
                  ? 'status-ok'
                  : undefined
          }
        >
          {t(SKEW[skew])}
        </span>
      </p>
    );
  };

  return (
    <section aria-labelledby={titleId} className="frontends-page">
      <h1 id={titleId} className="page-title">
        {t('admin.frontends.title')}
      </h1>
      {notAdmin ? (
        <p className="page-note">{t('admin.frontends.forbidden')}</p>
      ) : loadFailed ? (
        <p role="alert" className="form-error">
          {t('admin.frontends.loadFailed')}
        </p>
      ) : !view ? (
        <p role="status" className="page-note">
          {t('admin.frontends.loading')}
        </p>
      ) : (
        <>
          <p className="page-note">{t('admin.frontends.intro')}</p>
          <section aria-labelledby={`${id}-self`} className="facts">
            <h2 id={`${id}-self`} className="facts-title">
              {t('admin.frontends.self')}
            </h2>
            <p className="frontend-origin">
              {t('common.value', { value: view.self.origin ?? '' })}
            </p>
            <p className="page-note">
              {view.self.servedVersion
                ? t('admin.frontends.serves', { version: view.self.servedVersion })
                : t('admin.frontends.servesNot')}
            </p>
            <p className="page-note">
              {t('admin.frontends.backendVersion', { version: view.backend.version })}
            </p>
          </section>

          <section aria-labelledby={`${id}-registered`}>
            <h2 id={`${id}-registered`} className="facts-title">
              {t('admin.frontends.registered')}
            </h2>
            {view.frontends.length === 0 ? (
              <p className="page-note">{t('admin.frontends.none')}</p>
            ) : (
              <ul className="frontend-list">
                {view.frontends.map((frontend) => (
                  <li key={frontend.id} className="frontend-item">
                    <h3 className="frontend-origin">
                      {t('common.value', { value: frontend.origin })}
                    </h3>
                    {frontend.label && <p>{t('common.value', { value: frontend.label })}</p>}
                    {versionLine(frontend, view.backend.frontend)}
                    <p className="page-note">
                      {frontend.redirectUris.length === 0
                        ? t('admin.frontends.cookieOnly')
                        : t('admin.frontends.returnsTo', {
                            uris: frontend.redirectUris.join(', '),
                          })}
                    </p>
                    <p className="page-note">
                      {t(
                        frontend.websocket
                          ? 'admin.frontends.sockets'
                          : 'admin.frontends.noSockets',
                      )}
                    </p>
                    <p className="page-note">
                      {frontend.addedBy
                        ? t('admin.frontends.addedBy', {
                            name: frontend.addedBy.name,
                            when: when(frontend.createdAt),
                          })
                        : t('admin.frontends.addedOn', { when: when(frontend.createdAt) })}
                    </p>
                    {frontend.inEnvironment && (
                      <p className="page-note">{t('admin.frontends.alsoInEnvironment')}</p>
                    )}
                    {confirming === frontend.id ? (
                      <fieldset className="frontend-confirm">
                        <legend>{t('admin.frontends.confirm', { origin: frontend.origin })}</legend>
                        <button
                          type="button"
                          className="button-danger"
                          disabled={busy}
                          onClick={() => void remove(frontend)}
                        >
                          {t('admin.frontends.confirmRemove')}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setConfirming(null)}
                        >
                          {t('admin.frontends.cancel')}
                        </button>
                      </fieldset>
                    ) : (
                      <div className="form-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          aria-label={t('admin.frontends.removeLabel', { origin: frontend.origin })}
                          onClick={() => setConfirming(frontend.id)}
                        >
                          {t('admin.frontends.remove')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {view.environment.length > 0 && (
            <section aria-labelledby={`${id}-environment`}>
              <h2 id={`${id}-environment`} className="facts-title">
                {t('admin.frontends.environment')}
              </h2>
              <p className="page-note">{t('admin.frontends.environmentHint')}</p>
              <ul className="frontend-list">
                {view.environment.map((entry) => (
                  <li key={entry.origin} className="frontend-item">
                    <h3 className="frontend-origin">
                      {t('common.value', { value: entry.origin })}
                    </h3>
                    <p className="page-note">
                      {entry.redirectUris.length === 0
                        ? t('admin.frontends.cookieOnly')
                        : t('admin.frontends.returnsTo', { uris: entry.redirectUris.join(', ') })}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <form
            className="frontend-form"
            aria-labelledby={`${id}-add`}
            onSubmit={(event) => void submit(event)}
          >
            <h2 id={`${id}-add`} className="facts-title">
              {t('admin.frontends.add')}
            </h2>
            <div className="form-field">
              <label htmlFor={`${id}-origin`}>{t('admin.frontends.origin')}</label>
              <input
                id={`${id}-origin`}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required
                value={origin}
                aria-describedby={`${id}-origin-hint`}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <p id={`${id}-origin-hint`} className="form-hint">
                {t('admin.frontends.originHint')}
              </p>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-label`}>{t('admin.frontends.label')}</label>
              <input
                id={`${id}-label`}
                type="text"
                maxLength={200}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-redirects`}>{t('admin.frontends.redirects')}</label>
              <textarea
                id={`${id}-redirects`}
                rows={3}
                spellCheck={false}
                value={redirects}
                aria-describedby={`${id}-redirects-hint`}
                onChange={(e) => setRedirects(e.target.value)}
              />
              <p id={`${id}-redirects-hint`} className="form-hint">
                {t('admin.frontends.redirectsHint')}
              </p>
            </div>
            <div className="form-field form-field-inline">
              <input
                id={`${id}-websocket`}
                type="checkbox"
                checked={websocket}
                onChange={(e) => setWebsocket(e.target.checked)}
              />
              <label htmlFor={`${id}-websocket`}>{t('admin.frontends.websocket')}</label>
            </div>
            {problem && (
              <p role="alert" className="form-error">
                {t(problem)}
              </p>
            )}
            <p role="status" className="form-status">
              {status}
            </p>
            <div className="form-actions">
              <button type="submit" className="button-primary" disabled={busy}>
                {t('admin.frontends.addButton')}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
