import { frontendSkew, type Skew } from '@taskmoor/webconfig';
import { createContext, type ReactNode, useContext, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { WEB_VERSION } from '../runtime/version';
import { httpMetaClient, type MetaClient } from './client';

/**
 * This frontend against the backend's versions (M1-106; API-018, OPS-017; ADR-070). The app
 * asks the meta endpoint when it starts and again every half hour, since the backend may be
 * upgraded under an open tab. One release behind, it keeps working and the shell shows a
 * notice (`UpdateBanner`); older than the backend serves, it shows an "update required" page
 * instead of failing request by request. When the backend cannot be asked, nothing is said.
 */
const RECHECK_MS = 30 * 60 * 1000;

interface VersionState {
  skew: Skew;
  /** The backend's version, once known. */
  server: string;
  version: string;
  dismissed: boolean;
  dismiss: () => void;
}

const VersionContext = createContext<VersionState>({
  skew: 'unknown',
  server: '',
  version: WEB_VERSION,
  dismissed: false,
  dismiss: () => {},
});

export const useVersionSkew = () => useContext(VersionContext);

export function VersionGate({
  client = httpMetaClient,
  version = WEB_VERSION,
  children,
}: {
  client?: MetaClient;
  version?: string;
  children: ReactNode;
}) {
  const [found, setFound] = useState<{ skew: Skew; server: string }>({
    skew: 'unknown',
    server: '',
  });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    const check = () =>
      client.meta().then(
        (meta) => {
          if (live) setFound({ skew: frontendSkew(version, meta.frontend), server: meta.version });
        },
        () => {},
      );
    void check();
    const timer = window.setInterval(check, RECHECK_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [client, version]);

  if (found.skew === 'update-required') {
    return <UpdateRequired version={version} server={found.server} />;
  }
  return (
    <VersionContext.Provider
      value={{ ...found, version, dismissed, dismiss: () => setDismissed(true) }}
    >
      {children}
    </VersionContext.Provider>
  );
}

const reload = () => window.location.reload();

function UpdateRequired({ version, server }: { version: string; server: string }) {
  const t = useT();
  return (
    <main id="main" className="update-required" tabIndex={-1}>
      <h1>{t('update.requiredTitle')}</h1>
      <p>{t('update.required', { version, server })}</p>
      <p className="page-note">{t('update.askAdmin')}</p>
      <button type="button" className="button-primary" onClick={reload}>
        {t('update.reload')}
      </button>
    </main>
  );
}

/** The notice at the top of every page while a newer frontend is available. */
export function UpdateBanner() {
  const t = useT();
  const id = useId();
  const { skew, server, version, dismissed, dismiss } = useVersionSkew();
  if (skew !== 'update-available' || dismissed) return null;
  return (
    <section className="update-banner" aria-labelledby={`${id}-title`}>
      <p>
        <strong id={`${id}-title`}>{t('update.availableTitle')}</strong>{' '}
        {t('update.available', { version, server })}
      </p>
      <div className="update-banner-actions">
        <button type="button" className="button-primary" onClick={reload}>
          {t('update.reload')}
        </button>
        <button type="button" className="button-secondary" onClick={dismiss}>
          {t('update.later')}
        </button>
      </div>
    </section>
  );
}
