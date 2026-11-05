import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { VersionEntry } from './client';

export interface VersionHistoryProps {
  versions: VersionEntry[] | null;
  loading: boolean;
  failed: boolean;
  /** Whether restoring would replace a draft or unsaved changes, which asks first. */
  replacesWork: boolean;
  busy: boolean;
  onRestore: (version: number) => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

const STATE_LABELS: Record<VersionEntry['state'], MessageId> = {
  published: 'admin.workflow.versions.published',
  draft: 'admin.workflow.versions.draft',
  earlier: 'admin.workflow.versions.earlier',
};

/**
 * Every version of a workflow, newest first (WF-002 (3)): who saved and published each, and a
 * way to bring an earlier one back as the draft, to publish like any other.
 */
export function VersionHistory({
  versions,
  loading,
  failed,
  replacesWork,
  busy,
  onRestore,
  headingRef,
}: VersionHistoryProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    if (confirming !== null) confirmButton.current?.focus();
  }, [confirming]);

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card workflow-panel">
      <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="facts-title">
        {t('admin.workflow.versions.title')}
      </h2>
      {loading && (
        <p role="status" className="page-note">
          {t('admin.workflow.versions.loading')}
        </p>
      )}
      {failed && (
        <p role="alert" className="form-error">
          {t('admin.workflow.versions.failed')}
        </p>
      )}
      {versions && (
        <ol className="workflow-versions" aria-labelledby={`${id}-title`}>
          {versions.map((v) => (
            <li key={v.version} className="workflow-version">
              <div className="trash-main">
                <p className="trash-name">
                  {t('admin.workflow.versions.version', { version: v.version })}{' '}
                  <span className={`token-badge workflow-version-${v.state}`}>
                    {t(STATE_LABELS[v.state])}
                  </span>
                </p>
                <p className="trash-meta">
                  <span>
                    {v.createdBy
                      ? t('admin.workflow.versions.saved', {
                          when: when(v.createdAt),
                          name: t('common.value', { value: v.createdBy.name }),
                        })
                      : t('admin.workflow.versions.savedBySystem', { when: when(v.createdAt) })}
                  </span>
                  {v.publishedAt && (
                    <span>
                      {v.publishedBy
                        ? t('admin.workflow.versions.publishedAt', {
                            when: when(v.publishedAt),
                            name: t('common.value', { value: v.publishedBy.name }),
                          })
                        : t('admin.workflow.versions.publishedBySystem', {
                            when: when(v.publishedAt),
                          })}
                    </span>
                  )}
                </p>
              </div>
              {v.state !== 'draft' &&
                (confirming === v.version ? (
                  <div className="token-confirm">
                    <p id={`${id}-c-${v.version}`}>
                      {t('admin.workflow.versions.confirmRestore', { version: v.version })}
                    </p>
                    <div className="token-confirm-actions">
                      <button
                        ref={confirmButton}
                        type="button"
                        className="button-primary"
                        disabled={busy}
                        onClick={() => onRestore(v.version)}
                      >
                        {t('admin.workflow.versions.confirmRestoreButton', { version: v.version })}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setConfirming(null)}
                      >
                        {t('admin.workflow.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy}
                    aria-label={t('admin.workflow.versions.restoreNamed', { version: v.version })}
                    onClick={() => (replacesWork ? setConfirming(v.version) : onRestore(v.version))}
                  >
                    {t('admin.workflow.versions.restore')}
                  </button>
                ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
