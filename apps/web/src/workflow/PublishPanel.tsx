import { type FormEvent, type Ref, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { Impact } from './client';
import { lintMessage, type Names } from './describe';
import type { LintIssue } from './lint';

export interface PublishPanelProps {
  /** The draft's version number, which publishing makes current. */
  version: number;
  impact: Impact | null;
  loading: boolean;
  failed: boolean;
  /** The checks' warnings; errors stop publishing before this panel opens. */
  warnings: readonly LintIssue[];
  names: Names;
  /** The draft's statuses, where tickets of dropped statuses may go. */
  draftStatusIds: readonly number[];
  busy: boolean;
  error: string | null;
  onPublish: (statusMapping: Record<string, number>) => void;
  onCancel: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * The publish step (WF-002 (1), (2), WF-012): who the new version reaches, the warnings it
 * still has, and for every status it drops that holds tickets, the status they move to. The
 * publish itself is one transaction on the server; the next transition uses the new version.
 */
export function PublishPanel({
  version,
  impact,
  loading,
  failed,
  warnings,
  names,
  draftStatusIds,
  busy,
  error,
  onPublish,
  onCancel,
  headingRef,
}: PublishPanelProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const needed = impact?.removedStatuses.filter((r) => r.ticketCount > 0) ?? [];
  const empty = impact?.removedStatuses.filter((r) => r.ticketCount === 0) ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (needed.some((r) => !mapping[String(r.statusId)])) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onPublish(
      Object.fromEntries(
        needed.map((r) => [String(r.statusId), Number(mapping[String(r.statusId)])]),
      ),
    );
  };

  return (
    <section aria-labelledby={`${id}-title`} className="workflow-panel workflow-publish">
      <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="facts-title">
        {t('admin.workflow.publishPanel.title', { version })}
      </h2>
      {loading && (
        <p role="status" className="page-note">
          {t('admin.workflow.publishPanel.loading')}
        </p>
      )}
      {failed && (
        <p role="alert" className="form-error">
          {t('admin.workflow.publishPanel.failed')}
        </p>
      )}
      {impact && (
        <form
          className="form workflow-form"
          onSubmit={submit}
          aria-labelledby={`${id}-title`}
          noValidate
        >
          <p className="page-note">
            {t('admin.workflow.publishPanel.tracks', {
              count: impact.tracks.length,
              keys: intl.formatList(impact.tracks.map((x) => t('common.value', { value: x.key }))),
            })}
          </p>
          {warnings.length > 0 && (
            <div className="workflow-publish-warnings">
              <p>{t('admin.workflow.publishPanel.warnings', { count: warnings.length })}</p>
              <ul className="lint-list">
                {warnings.map((w, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no other identity
                  <li key={index} className="lint-item lint-warning">
                    <span className="lint-text">{lintMessage(t, w, names)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {impact.removedStatuses.length > 0 && (
            <fieldset>
              <legend>{t('admin.workflow.publishPanel.dropped')}</legend>
              {needed.map((r) => (
                <div key={r.statusId} className="form-field">
                  <label htmlFor={`${id}-map-${r.statusId}`}>
                    {t('admin.workflow.publishPanel.moveTo', {
                      count: r.ticketCount,
                      status: names.status(r.statusId),
                    })}
                  </label>
                  <select
                    id={`${id}-map-${r.statusId}`}
                    value={mapping[String(r.statusId)] ?? ''}
                    aria-invalid={missing && !mapping[String(r.statusId)]}
                    onChange={(e) =>
                      setMapping((m) => ({ ...m, [String(r.statusId)]: e.target.value }))
                    }
                  >
                    <option value="">{t('admin.workflow.publishPanel.choose')}</option>
                    {draftStatusIds.map((s) => (
                      <option key={s} value={String(s)}>
                        {names.status(s)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {empty.map((r) => (
                <p key={r.statusId} className="form-hint">
                  {t('admin.workflow.publishPanel.empty', { status: names.status(r.statusId) })}
                </p>
              ))}
            </fieldset>
          )}
          {(missing || error) && (
            <p role="alert" className="form-error">
              {missing ? t('workflow.problem.mappingRequired') : error}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('admin.workflow.publishPanel.confirm')}
            </button>
            <button type="button" className="button-secondary" onClick={onCancel}>
              {t('admin.workflow.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
