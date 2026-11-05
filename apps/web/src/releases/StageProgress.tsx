import type { CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type Counted, searchHref } from './client';

const STAGES = ['new', 'active', 'closed'] as const;
const STAGE_LABELS: Record<(typeof STAGES)[number], MessageId> = {
  new: 'search.stage.new',
  active: 'search.stage.active',
  closed: 'search.stage.closed',
};

/** A stage's fill: one blue from light (new) to dark (closed), the flow reports' ordinal ramp. */
const stageFill = (index: number): CSSProperties => ({
  background: `color-mix(in oklab, var(--color-flow-first) ${100 - index * 50}%, var(--color-flow-last))`,
});

/**
 * Tickets by stage: one bar and a legend, each number linking to the search that finds them. A
 * release's page and a release across tracks' page both draw it.
 */
export function StageProgress({
  stages,
}: {
  stages: { new: Counted; active: Counted; closed: Counted };
}) {
  const t = useT();
  const intl = useIntl();
  const number = (c: Counted) =>
    c.exact ? intl.formatNumber(c.count) : t('summary.atLeast', { count: c.count });
  const total = STAGES.reduce((sum, s) => sum + stages[s].count, 0);
  return (
    <>
      <div className="release-bar" aria-hidden="true">
        {STAGES.map((s, i) =>
          stages[s].count > 0 ? (
            <span
              key={s}
              style={{ ...stageFill(i), flexGrow: stages[s].count }}
              title={`${t(STAGE_LABELS[s])}: ${number(stages[s])}`}
            />
          ) : null,
        )}
        {total === 0 && <span className="release-bar-empty" />}
      </div>
      <ul className="release-legend">
        {STAGES.map((s, i) => (
          <li key={s}>
            <span className="release-swatch" style={stageFill(i)} aria-hidden="true" />
            <a
              href={searchHref(stages[s].query)}
              aria-label={t('summary.linkLabel', {
                label: t(STAGE_LABELS[s]),
                count: number(stages[s]),
              })}
            >
              <span>{t(STAGE_LABELS[s])}</span> <strong>{number(stages[s])}</strong>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
