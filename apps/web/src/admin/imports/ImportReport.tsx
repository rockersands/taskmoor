import { useId } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../../i18n/I18nProvider';
import { EmptyState } from '../../shell/EmptyState';
import { TableScroller } from '../TableScroller';
import type { FidelityReport, KindProgress, RecordOutcome } from './client';
import { kindLabel, outcomeLabel, warningExample, warningExplanation } from './labels';

const OUTCOMES = ['created', 'updated', 'unchanged', 'linked', 'failed', 'skipped'] as const;

/** Per kind: records read and what became of them, as the run's progress and its report say. */
export function KindTable({ rows, caption }: { rows: KindProgress[]; caption: string }) {
  const t = useT();
  const intl = useIntl();
  const n = (value: number) => intl.formatNumber(value);
  return (
    <TableScroller label={caption}>
      <table className="data-table api-usage-table import-kinds">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('admin.imports.column.kind')}</th>
            <th scope="col">{t('admin.imports.column.read')}</th>
            {OUTCOMES.map((o) => (
              <th key={o} scope="col">
                {t(outcomeLabel(o))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kind}>
              <th scope="row">{t(kindLabel(row.kind))}</th>
              <td>{n(row.read)}</td>
              {OUTCOMES.map((o) => (
                <td key={o}>{n(row[o])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

/**
 * A finished run's fidelity report (M1-097; IMP-010, IMP-013): the totals, what became of each
 * kind, every warning with what its code means, what was not imported and why, the failures,
 * and the mapping of configuration objects, with the report to download as a page.
 */
export function ImportReport({
  report,
  downloadUrl,
}: {
  report: FidelityReport;
  downloadUrl: string;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const n = (value: number) => intl.formatNumber(value);
  const pct = (value: number | null) =>
    value === null ? '' : intl.formatNumber(value, { style: 'percent', maximumFractionDigits: 2 });
  const run = report.run;
  const deleted = report.warnings.filter((w) => w.code === 'deleted_in_source');
  return (
    <section aria-labelledby={`${id}-title`} className="import-report">
      <h3 id={`${id}-title`} className="facts-title">
        {t('admin.imports.report.title', { id: run.id })}
      </h3>
      <p>
        {report.totals.target === null
          ? t('admin.imports.report.totalsDry', {
              source: n(report.totals.source),
              failed: n(report.totals.failed),
            })
          : t('admin.imports.report.totals', {
              source: n(report.totals.source),
              target: n(report.totals.target),
              failed: n(report.totals.failed),
              fidelity: pct(report.totals.fidelity),
            })}
      </p>
      {run.deltaFrom !== undefined && (
        <p className="page-note">
          {t('admin.imports.report.delta', {
            from: run.deltaFrom,
            deleted: n(deleted.reduce((sum, w) => sum + w.count, 0)),
          })}
        </p>
      )}
      {report.sampleSummary.compared > 0 && (
        <p className="page-note">
          {t('admin.imports.report.samples', {
            matched: n(report.sampleSummary.matched),
            compared: n(report.sampleSummary.compared),
          })}
        </p>
      )}
      <p>
        <a href={downloadUrl} download>
          {t('admin.imports.report.download')}
        </a>
      </p>
      <KindTable
        caption={t('admin.imports.report.kinds')}
        rows={report.entities.map((e) => ({ kind: e.kind, read: e.source, ...e.outcomes }))}
      />

      <h4 className="import-subtitle">
        {t('admin.imports.report.warnings', {
          count: n(report.warnings.reduce((sum, w) => sum + w.count, 0)),
        })}
      </h4>
      {report.warnings.length === 0 ? (
        <EmptyState compact title={t('admin.imports.report.noWarnings')} />
      ) : (
        <ul className="import-warnings">
          {report.warnings.map((w) => (
            <li key={`${w.kind}|${w.code}|${w.detail ?? ''}`}>
              <p>
                <strong>{t(kindLabel(w.kind))}</strong>{' '}
                {t('admin.imports.report.warningCount', { count: n(w.count) })}
              </p>
              <p>{t(warningExplanation(w.code))}</p>
              <p className="page-note import-code">
                {w.detail
                  ? t('admin.imports.report.codeDetail', { code: w.code, detail: w.detail })
                  : t('admin.imports.report.code', { code: w.code })}
                {w.examples.length > 0 &&
                  ` ${t('admin.imports.report.examples', {
                    examples: w.examples.map((e) => warningExample(t, w.code, e)).join(', '),
                  })}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {report.unsupported.length > 0 && (
        <>
          <h4 className="import-subtitle">{t('admin.imports.report.unsupported')}</h4>
          <ul className="import-warnings">
            {report.unsupported.map((u) => (
              <li key={u.kind}>
                {t('admin.imports.report.unsupportedItem', {
                  kind: u.kind,
                  count: n(u.count),
                  reason: u.reason,
                })}
              </li>
            ))}
          </ul>
        </>
      )}

      {report.failures.length > 0 && (
        <>
          <h4 className="import-subtitle">{t('admin.imports.report.failures')}</h4>
          <ul className="import-warnings">
            {report.failures.map((f) => (
              <li key={`${f.kind}|${f.sourceId}`}>
                {t('admin.imports.report.failure', {
                  kind: t(kindLabel(f.kind)),
                  id: f.sourceId,
                  error: f.error,
                })}
              </li>
            ))}
          </ul>
          {report.failuresTruncated && (
            <p className="page-note">{t('admin.imports.report.moreFailures')}</p>
          )}
        </>
      )}

      {report.mapping.length > 0 && (
        <details className="import-mapping">
          <summary>
            {t('admin.imports.report.mapping', { count: n(report.mapping.length) })}
          </summary>
          <ul className="import-warnings">
            {report.mapping.map((m) => (
              <li key={`${m.kind}|${m.sourceId}`}>
                {t('admin.imports.report.mapped', {
                  kind: t(kindLabel(m.kind)),
                  name: m.label ?? m.sourceId,
                  outcome: t(outcomeLabel(m.outcome as RecordOutcome)),
                })}
                {m.reason && ` ${t('admin.imports.report.reason', { reason: m.reason })}`}
              </li>
            ))}
          </ul>
          {report.mappingTruncated && (
            <p className="page-note">{t('admin.imports.report.moreMapping')}</p>
          )}
        </details>
      )}
    </section>
  );
}
