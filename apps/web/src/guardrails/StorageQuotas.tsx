import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { formatSize } from '../attachments/format';
import { useT } from '../i18n/I18nProvider';
import { type StorageClient, type StorageSettings, storageClient } from './storage-client';

export interface StorageQuotasProps {
  /** Stories and tests pass their own backend; the section calls the API otherwise. */
  client?: StorageClient;
}

const GIB = 1024 ** 3;

/** A quota as the field shows it: GiB, empty for none. */
const asGib = (bytes: number | null) =>
  bytes === null ? '' : String(Math.round((bytes / GIB) * 1000) / 1000);

/** The field's text as bytes: null for none, undefined when it is not a size. */
function fromGib(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.round(value * GIB));
}

/**
 * Attachment storage on the usage page (M1-118; CORE-021; ASVS 12.1.3): what the workspace and
 * its heaviest uploader hold against the storage quotas, and a form to set them. Both quotas
 * are off unless set; an upload past one is refused, what is stored stays.
 */
export function StorageQuotas({ client = storageClient }: StorageQuotasProps) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const id = useId();
  const [settings, setSettings] = useState<StorageSettings | null | 'failed'>(null);
  const [workspace, setWorkspace] = useState('');
  const [person, setPerson] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const size = (bytes: number) => formatSize(t, intl, bytes);

  const show = useCallback((next: StorageSettings) => {
    setSettings(next);
    setWorkspace(asGib(next.workspaceQuota));
    setPerson(asGib(next.personQuota));
  }, []);
  useEffect(() => {
    client.read().then(show, () => setSettings('failed'));
  }, [client, show]);

  const save = async () => {
    const workspaceQuota = fromGib(workspace);
    const personQuota = fromGib(person);
    if (workspaceQuota === undefined || personQuota === undefined) {
      setProblem(t('storage.invalid'));
      return;
    }
    try {
      show(await client.setQuotas({ workspaceQuota, personQuota }));
      setProblem(null);
      setMessage(t('storage.saved'));
    } catch {
      setProblem(t('storage.failed'));
    }
  };

  const meter = (used: number, limit: number | null, label: string) =>
    limit === null ? null : (
      <meter
        className="guardrails-meter"
        min={0}
        max={limit}
        low={limit * 0.7}
        high={limit * 0.9}
        optimum={0}
        value={Math.min(used, limit)}
        aria-label={label}
      />
    );

  return (
    <section aria-labelledby={titleId} className="api-usage-section storage-quotas">
      <h2 id={titleId} className="facts-title">
        {t('storage.title')}
      </h2>
      <p className="page-note">{t('storage.intro')}</p>
      {settings === null && <p className="page-note">{t('storage.loading')}</p>}
      {settings === 'failed' && (
        <p role="alert" className="form-error">
          {t('storage.loadFailed')}
        </p>
      )}
      {settings !== null && settings !== 'failed' && (
        <>
          <ul className="people-list">
            <li className="people-item people-group">
              <div className="people-main">
                <p className="people-name">
                  {t('storage.workspace')}
                  {settings.workspaceQuota !== null &&
                    settings.usage.bytes > settings.workspaceQuota && (
                      <span className="people-badge">{t('guardrails.over')}</span>
                    )}
                </p>
                <p className="people-meta">
                  {settings.workspaceQuota === null
                    ? t('storage.usedNoQuota', {
                        used: size(settings.usage.bytes),
                        files: settings.usage.files,
                      })
                    : t('storage.usedOf', {
                        used: size(settings.usage.bytes),
                        limit: size(settings.workspaceQuota),
                        files: settings.usage.files,
                      })}
                </p>
                {meter(
                  settings.usage.bytes,
                  settings.workspaceQuota,
                  t('storage.workspaceShare', {
                    share: settings.workspaceQuota
                      ? Math.min(
                          100,
                          Math.round((settings.usage.bytes / settings.workspaceQuota) * 100),
                        )
                      : 0,
                  }),
                )}
              </div>
            </li>
            <li className="people-item people-group">
              <div className="people-main">
                <p className="people-name">{t('storage.person')}</p>
                <p className="people-meta">
                  {settings.usage.topPerson === null
                    ? t('storage.nobody')
                    : settings.personQuota === null
                      ? t('storage.topNoQuota', {
                          name: settings.usage.topPerson.name,
                          used: size(settings.usage.topPerson.bytes),
                        })
                      : t('storage.topOf', {
                          name: settings.usage.topPerson.name,
                          used: size(settings.usage.topPerson.bytes),
                          limit: size(settings.personQuota),
                        })}
                </p>
                {settings.usage.topPerson &&
                  meter(
                    settings.usage.topPerson.bytes,
                    settings.personQuota,
                    t('storage.personShare', {
                      name: settings.usage.topPerson.name,
                      share: settings.personQuota
                        ? Math.min(
                            100,
                            Math.round(
                              (settings.usage.topPerson.bytes / settings.personQuota) * 100,
                            ),
                          )
                        : 0,
                    }),
                  )}
              </div>
            </li>
          </ul>
          <form
            className="people-inline guardrails-form"
            aria-label={t('storage.form')}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="form-field">
              <label htmlFor={`${id}-workspace`} className="form-label">
                {t('storage.workspaceQuota')}
              </label>
              <input
                id={`${id}-workspace`}
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={workspace}
                aria-describedby={`${id}-hint`}
                onChange={(event) => setWorkspace(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-person`} className="form-label">
                {t('storage.personQuota')}
              </label>
              <input
                id={`${id}-person`}
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={person}
                aria-describedby={`${id}-hint`}
                onChange={(event) => setPerson(event.target.value)}
              />
            </div>
            <button type="submit" className="button-secondary">
              {t('storage.save')}
            </button>
            <p id={`${id}-hint`} className="form-hint">
              {t('storage.hint')}
            </p>
          </form>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  );
}
