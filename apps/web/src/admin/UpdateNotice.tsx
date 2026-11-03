import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { Fact, Facts } from './Facts';

/**
 * The new-version notice for site administrators (OPS-026, ADR-117). The worker looks at the
 * project's public releases once a day; this shows what it found, with the exact command to run
 * on the server. There is no "Update" button: updating from here would need the app to control
 * Docker on its server. Nobody else asks or sees anything, and a backend that cannot answer
 * leaves the page as it was.
 */
export interface UpdateCheck {
  version: string;
  enabled: boolean;
  environmentOff: boolean;
  developmentBuild: boolean;
  checkedAt: string | null;
  latest: string | null;
  updateAvailable: boolean;
  command: string | null;
  releaseUrl: string | null;
}

export interface UpdateCheckClient {
  load(): Promise<UpdateCheck>;
  setEnabled(enabled: boolean): Promise<UpdateCheck>;
}

export const httpUpdateCheckClient: UpdateCheckClient = {
  load: () =>
    api<{ updateCheck: UpdateCheck }>('/admin/update-check').then((answer) => answer.updateCheck),
  setEnabled: (enabled) =>
    api<{ updateCheck: UpdateCheck }>('/admin/update-check', {
      method: 'PUT',
      body: { enabled },
    }).then((answer) => answer.updateCheck),
};

/** The version an administrator put off, on this browser; a newer one shows again. */
const PUT_OFF_KEY = 'taskmoor.updateNotice.putOff';
function readPutOff(): string | null {
  try {
    return window.localStorage.getItem(PUT_OFF_KEY);
  } catch {
    return null;
  }
}
function writePutOff(version: string): void {
  try {
    window.localStorage.setItem(PUT_OFF_KEY, version);
  } catch {
    // Without storage it comes back on the next load, which does no harm.
  }
}

/** The command, ready to select or copy. */
function UpdateCommand({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the command to select by hand.
    }
  };
  return (
    <div className="update-command">
      <code>{command}</code>
      <button type="button" className="button-secondary" onClick={() => void copy()}>
        {t(copied ? 'admin.updates.copied' : 'admin.updates.copy')}
      </button>
    </div>
  );
}

/** The notice at the top of every page for a site administrator, until put off. */
export function UpdateNotice({ client = httpUpdateCheckClient }: { client?: UpdateCheckClient }) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  const [found, setFound] = useState<UpdateCheck | null>(null);
  const [putOff, setPutOff] = useState(readPutOff);

  useEffect(() => {
    if (!admin) return;
    let live = true;
    client.load().then(
      (answer) => {
        if (live) setFound(answer);
      },
      () => {
        // Nothing to say when the backend cannot answer.
      },
    );
    return () => {
      live = false;
    };
  }, [admin, client]);

  if (!admin || !found?.updateAvailable) return null;
  const { latest, command, releaseUrl, version } = found;
  if (!latest || !command || latest === putOff) return null;
  return (
    <section className="update-banner update-notice" aria-labelledby={`${id}-title`}>
      <div className="update-notice-text">
        <p>
          <strong id={`${id}-title`}>{t('admin.updates.noticeTitle', { latest })}</strong>{' '}
          {t('admin.updates.noticeBody', { version })}
        </p>
        <UpdateCommand command={command} />
      </div>
      <div className="update-banner-actions">
        {releaseUrl && (
          <a className="button-secondary" href={releaseUrl} rel="noreferrer">
            {t('admin.updates.releaseNotes')}
          </a>
        )}
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            writePutOff(latest);
            setPutOff(latest);
          }}
        >
          {t('update.later')}
        </button>
      </div>
    </section>
  );
}

/** The card on the system status page: what the last look found, and the switch. */
export function UpdateCheckSection({
  client = httpUpdateCheckClient,
}: {
  client?: UpdateCheckClient;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [state, setState] = useState<UpdateCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.load().then(
      (answer) => {
        if (live) setState(answer);
      },
      () => {
        // The rest of the page still works; this card just stays away.
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  if (!state) return null;

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    setFailed(false);
    try {
      setState(await client.setEnabled(enabled));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const looking = state.enabled && !state.environmentOff && !state.developmentBuild;
  return (
    <Facts
      title={t('admin.updates.title')}
      after={
        <>
          {state.command && (
            <div className="update-card-command">
              <p>{t('admin.updates.runThis')}</p>
              <UpdateCommand command={state.command} />
            </div>
          )}
          <div className="form-field form-field-inline update-card-switch">
            <input
              id={`${id}-enabled`}
              type="checkbox"
              checked={state.enabled && !state.environmentOff}
              disabled={saving || state.environmentOff}
              aria-describedby={`${id}-hint`}
              onChange={(e) => void toggle(e.target.checked)}
            />
            <label htmlFor={`${id}-enabled`}>{t('admin.updates.toggle')}</label>
          </div>
          <p id={`${id}-hint`} className="form-hint">
            {t(
              state.environmentOff
                ? 'admin.updates.environmentOff'
                : state.developmentBuild
                  ? 'admin.updates.development'
                  : 'admin.updates.toggleHelp',
            )}
          </p>
          {failed && (
            <p role="alert" className="form-error">
              {t('admin.updates.saveFailed')}
            </p>
          )}
        </>
      }
    >
      <Fact label={t('admin.updates.running')}>
        {t('admin.system.plain', { value: state.version })}
      </Fact>
      {looking && (
        <>
          <Fact label={t('admin.updates.newest')}>
            {state.latest
              ? t('admin.system.plain', { value: state.latest })
              : t('admin.updates.notKnown')}
          </Fact>
          <Fact label={t('admin.updates.lastChecked')}>
            {state.checkedAt
              ? intl.formatDate(state.checkedAt, { dateStyle: 'medium', timeStyle: 'short' })
              : t('admin.updates.notKnown')}
          </Fact>
        </>
      )}
    </Facts>
  );
}
