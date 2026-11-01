import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../../i18n/I18nProvider';
import type { FidelityReport, ImportRunView, ImportsClient } from './client';
import { ImportReport, KindTable } from './ImportReport';
import { formatLabel, kindLabel, statusLabel } from './labels';

const FINISHED = new Set(['done', 'failed', 'cancelled']);
export const isFinished = (run: ImportRunView) => FINISHED.has(run.status);

/**
 * One run as it goes (M1-097; IMP-013 (1)): its state, the kind it is on, per kind the records
 * done so far, a cancel while it runs, and the fidelity report once it has finished. It asks
 * the server again every `pollMs` until the run ends.
 */
export function ImportRunPanel({
  client,
  runId,
  pollMs = 2000,
  onFinished,
}: {
  client: ImportsClient;
  runId: number;
  pollMs?: number;
  onFinished?: (run: ImportRunView, report: FidelityReport | null) => void;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [run, setRun] = useState<ImportRunView | null>(null);
  const [report, setReport] = useState<FidelityReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The parent's callback, current without restarting the polling when it changes.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRun(null);
    setReport(null);
    const tick = async () => {
      try {
        const next = await client.run(runId);
        if (!live) return;
        setRun(next);
        if (isFinished(next)) {
          const found = await client.report(runId).catch(() => null);
          if (!live) return;
          setReport(found);
          finished.current?.(next, found);
          return;
        }
        timer = setTimeout(() => void tick(), pollMs);
      } catch {
        if (live) setFailed(true);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, runId, pollMs]);

  const cancel = async () => {
    setCancelling(true);
    try {
      setRun(await client.cancel(runId));
    } catch {
      setFailed(true);
    } finally {
      setCancelling(false);
    }
  };

  if (failed) {
    return (
      <p role="alert" className="form-error">
        {t('admin.imports.run.loadFailed')}
      </p>
    );
  }
  if (!run) {
    return (
      <p role="status" className="page-note">
        {t('admin.imports.run.loading')}
      </p>
    );
  }
  const read = run.progress.reduce((sum, k) => sum + k.read, 0);
  return (
    <section aria-labelledby={`${id}-title`} className="import-run">
      <h3 id={`${id}-title`} className="facts-title">
        {t(run.dryRun ? 'admin.imports.run.titleDry' : 'admin.imports.run.title', {
          id: run.id,
          format: t(formatLabel(run.importSource)),
        })}
      </h3>
      <p role="status" className="import-run-status">
        {t(statusLabel(run.status))}
        {!isFinished(run) &&
          ` ${
            run.checkingDeletions
              ? t('admin.imports.run.checkingDeletions')
              : run.currentKind
                ? t('admin.imports.run.on', { kind: t(kindLabel(run.currentKind)) })
                : ''
          }`}
      </p>
      <p className="page-note">
        {t('admin.imports.run.counts', {
          read: intl.formatNumber(read),
          warnings: intl.formatNumber(run.warnings),
          system: run.sourceSystem,
        })}
        {run.deltaFrom !== null && ` ${t('admin.imports.run.deltaFrom', { id: run.deltaFrom })}`}
      </p>
      {run.lastError && run.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.imports.run.error', { error: run.lastError })}
        </p>
      )}
      {!isFinished(run) && (
        <div className="form-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void cancel()}
            disabled={cancelling || run.cancelRequested}
          >
            {run.cancelRequested
              ? t('admin.imports.run.cancelAsked')
              : t('admin.imports.run.cancel')}
          </button>
        </div>
      )}
      {report ? (
        <ImportReport report={report} downloadUrl={client.reportUrl(run.id)} />
      ) : (
        run.progress.length > 0 && (
          <KindTable caption={t('admin.imports.run.progress')} rows={run.progress} />
        )
      )}
    </section>
  );
}
