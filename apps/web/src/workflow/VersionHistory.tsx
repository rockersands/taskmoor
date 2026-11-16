import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { DangerAction } from '../shell/DangerAction';
import type { VersionEntry } from './client';

export interface VersionHistoryProps {
  versions: VersionEntry[] | null;
  loading: boolean;
  failed: boolean;
  /** Whether restoring would replace a draft or unsaved changes, which asks first. */
  replacesWork: boolean;
  /** The saved draft's version that a restore replaces, for the question; null for none. */
  draft?: number | null;
  busy: boolean;
  /** Resolves to whether it was restored; a refusal keeps the question open. */
  onRestore: (version: number) => Promise<boolean>;
  headingRef?: Ref<HTMLHeadingElement>;
}

const STATE_LABELS: Record<VersionEntry['state'], MessageId> = {
  published: 'admin.workflow.versions.published',
  draft: 'admin.workflow.versions.draft',
  earlier: 'admin.workflow.versions.earlier',
};

/**
 * Every version of a workflow, newest first (WF-002 (3)): who saved and published each, and a
 * way to bring an earlier one back as the draft, to publish like any other. Restoring over a
 * draft or unsaved changes replaces that work, so it asks first (D13, T-267); with nothing to
 * replace it acts at once.
 */
export function VersionHistory({
  versions,
  loading,
  failed,
  replacesWork,
  draft = null,
  busy,
  onRestore,
  headingRef,
}: VersionHistoryProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const list = useRef<HTMLOListElement>(null);
  /** A version restored at once: its button, now one that asks, gets the focus back. */
  const [restored, setRestored] = useState<number | null>(null);
  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    if (restored === null) return;
    setRestored(null);
    list.current?.querySelector<HTMLButtonElement>(`[data-version="${restored}"] button`)?.focus();
  }, [restored]);

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
        <ol ref={list} className="workflow-versions" aria-labelledby={`${id}-title`}>
          {versions.map((v) => (
            <li key={v.version} className="workflow-version" data-version={v.version}>
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
                (replacesWork ? (
                  <DangerAction
                    label={t('admin.workflow.versions.restore')}
                    name={t('admin.workflow.versions.restoreNamed', { version: v.version })}
                    outcome={t('admin.workflow.versions.confirmRestore', {
                      version: v.version,
                      draft: draft ?? 'none',
                    })}
                    confirmLabel={t('admin.workflow.versions.confirmRestoreButton', {
                      version: v.version,
                    })}
                    busy={busy}
                    onConfirm={async () => {
                      if (!(await onRestore(v.version))) throw new Error('refused');
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy}
                    aria-label={t('admin.workflow.versions.restoreNamed', { version: v.version })}
                    onClick={() =>
                      void onRestore(v.version).then((done) => {
                        if (done) setRestored(v.version);
                      })
                    }
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
