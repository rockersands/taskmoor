import { frontendSkew, type PinnedInstance, type Skew, verifyInstance } from '@taskmoor/webconfig';
import { createContext, type ReactNode, useContext, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { runtimeConfig } from '../runtime/config';
import { WEB_VERSION } from '../runtime/version';
import { PageHeader } from '../shell/PageHeader';
import { StandaloneFrame, StandaloneNote } from '../shell/StandaloneFrame';
import { httpMetaClient, type MetaClient } from './client';

/**
 * This frontend against the backend's versions (M1-106; API-018, OPS-017; ADR-070). The app
 * asks the meta endpoint when it starts and again every half hour, since the backend may be
 * upgraded under an open tab. One release behind, it keeps working and the shell shows a
 * notice (`UpdateBanner`); older than the backend serves, it shows an "update required" page
 * instead of failing request by request. When the backend cannot be asked, nothing is said.
 *
 * A frontend kit is pinned to its instance (M1-111; API-017 (2)): the app asks the backend to
 * sign a fresh nonce and checks the answer against the pinned id and key. Another backend gets
 * a page saying so instead of the app, so nobody signs in to the wrong server.
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

const configuredPin: PinnedInstance | null = runtimeConfig.instanceId
  ? { id: runtimeConfig.instanceId, publicKey: runtimeConfig.instanceKey }
  : null;

/** A nonce of 24 base64url characters. */
function freshNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function VersionGate({
  client = httpMetaClient,
  version = WEB_VERSION,
  pin = configuredPin,
  children,
}: {
  client?: MetaClient;
  version?: string;
  /** The instance this frontend was built for; null when the backend serves it itself. */
  pin?: PinnedInstance | null;
  children: ReactNode;
}) {
  const [found, setFound] = useState<{ skew: Skew; server: string }>({
    skew: 'unknown',
    server: '',
  });
  const [wrongInstance, setWrongInstance] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    const check = async () => {
      const nonce = pin ? freshNonce() : undefined;
      try {
        const meta = await client.meta(nonce);
        if (pin && nonce && !(await verifyInstance(pin, meta, nonce))) {
          if (live) setWrongInstance(true);
          return;
        }
        if (live) setFound({ skew: frontendSkew(version, meta.frontend), server: meta.version });
      } catch {
        // Unreachable or not a meta answer: the page's own requests show any real failure.
      }
    };
    void check();
    const timer = window.setInterval(check, RECHECK_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [client, version, pin]);

  if (wrongInstance) return <WrongInstance />;
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

function WrongInstance() {
  const t = useT();
  return (
    <StandaloneFrame wayOut={false}>
      <main id="main" className="setup" tabIndex={-1}>
        <PageHeader title={t('instance.wrongTitle')} purpose={t('instance.wrong')} />
        {/* On a card, as on every stand-alone page (ADR-114; S3-SP-5). */}
        <StandaloneNote kind="note">{t('instance.wrongAdmin')}</StandaloneNote>
      </main>
    </StandaloneFrame>
  );
}

function UpdateRequired({ version, server }: { version: string; server: string }) {
  const t = useT();
  return (
    // The stand-alone frame (D24), whose canvas covers the window without seams (AD-41). Equal
    // versions never land here: a backend's window never asks more than its own version (AD-42).
    <StandaloneFrame wayOut={false}>
      <main id="main" className="setup" tabIndex={-1}>
        <PageHeader
          title={t('update.requiredTitle')}
          purpose={t('update.required', { version, server })}
        />
        {/* What to do, on a card as every stand-alone page has it (ADR-114; S3-SP-5). */}
        <div className="glass-card account-section">
          <p className="page-note">{t('update.askAdmin')}</p>
          <button type="button" className="button-primary" onClick={reload}>
            {t('update.reload')}
          </button>
        </div>
      </main>
    </StandaloneFrame>
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
