import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { EmptyState } from '../../shell/EmptyState';
import { PageHeader } from '../../shell/PageHeader';
import { type ImportRunView, type ImportsClient, importsClient } from './client';
import { ImportRunPanel } from './ImportRunPanel';
import { ImportWizard } from './ImportWizard';
import { formatLabel, statusLabel } from './labels';

/** Runs a delta run can start from (M1-096): finished real runs of a backup or a Cloud site. */
const deltaReady = (run: ImportRunView) =>
  run.status === 'done' &&
  !run.dryRun &&
  (run.importSource === 'dc-backup' || run.importSource === 'cloud-rest');

/**
 * Settings > Imports (M1-097; IMP-013): the import wizard for site administrators, and the
 * earlier runs, each with its progress or report, and a delta run from the ones that can start
 * one.
 */
export function ImportsPage({
  client = importsClient,
  pollMs,
}: {
  client?: ImportsClient;
  pollMs?: number;
}) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const titleId = useId();
  const id = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [runs, setRuns] = useState<ImportRunView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // `focus`: the new form's title takes the focus, as the button that asked for it is gone.
  const [wizard, setWizard] = useState<{
    key: number;
    delta: ImportRunView | null;
    focus: boolean;
  }>({ key: 0, delta: null, focus: false });
  const [shown, setShown] = useState<number | null>(null);
  const top = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setRuns(await client.runs());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    if (notAdmin) return;
    void reload();
  }, [reload, notAdmin]);

  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
  const fresh = (delta: ImportRunView | null, focus = false) => {
    setWizard((w) => ({ key: w.key + 1, delta, focus }));
    setShown(null);
  };

  return (
    <section aria-labelledby={titleId} className="page imports-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.imports.title')}
        {...(notAdmin
          ? {}
          : { purpose: t('settings.importsHint'), about: t('admin.imports.intro') })}
      />
      {notAdmin ? (
        <p className="page-note">{t('admin.imports.forbidden')}</p>
      ) : (
        <>
          <div ref={top}>
            <ImportWizard
              key={wizard.key}
              client={client}
              delta={wizard.delta}
              {...(pollMs !== undefined ? { pollMs } : {})}
              onStarted={() => void reload()}
              onDone={() => void reload()}
              focusTitle={wizard.focus}
              onAnother={() => fresh(null, true)}
            />
          </div>

          <section aria-labelledby={`${id}-runs`} className="import-runs">
            <h2 id={`${id}-runs`} className="facts-title">
              {t('admin.imports.runs')}
            </h2>
            {loadFailed ? (
              <p role="alert" className="form-error">
                {t('admin.imports.loadFailed')}
              </p>
            ) : runs === null ? (
              <p className="page-note">{t('admin.imports.loading')}</p>
            ) : runs.length === 0 ? (
              <EmptyState title={t('admin.imports.none')}>{t('empty.imports.body')}</EmptyState>
            ) : (
              <ul className="import-run-list">
                {runs.map((run) => {
                  const label = run.name || t('admin.imports.unnamed', { id: run.id });
                  return (
                    <li key={run.id} className="glass-card import-run-item">
                      <h3 className="import-run-name">
                        {t('admin.imports.runName', { id: run.id, name: label })}
                      </h3>
                      <p className="page-note">
                        {t(run.dryRun ? 'admin.imports.runLineDry' : 'admin.imports.runLine', {
                          format: t(formatLabel(run.importSource)),
                          system: run.sourceSystem,
                          status: t(statusLabel(run.status)),
                          when: when(run.createdAt),
                        })}
                        {run.deltaFrom !== null &&
                          ` ${t('admin.imports.run.deltaFrom', { id: run.deltaFrom })}`}
                      </p>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          aria-expanded={shown === run.id}
                          onClick={() => setShown(shown === run.id ? null : run.id)}
                        >
                          {shown === run.id
                            ? t('admin.imports.hide', { id: run.id })
                            : t('admin.imports.show', { id: run.id })}
                        </button>
                        {deltaReady(run) && (
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => {
                              fresh(run);
                              top.current?.scrollIntoView?.({ block: 'start' });
                            }}
                          >
                            {t('admin.imports.delta', { id: run.id })}
                          </button>
                        )}
                      </div>
                      {shown === run.id && (
                        <ImportRunPanel
                          client={client}
                          runId={run.id}
                          {...(pollMs !== undefined ? { pollMs } : {})}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
