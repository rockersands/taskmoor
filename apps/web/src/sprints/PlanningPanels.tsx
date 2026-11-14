import { type ReactNode, useId } from 'react';
import { useDayText } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';
import type { BacklogPanels } from './client';

/** What a panel item stands for: an outcome (by ticket id) or a release. */
export interface PanelTarget {
  kind: 'outcome' | 'release';
  id: number;
}

export interface PlanningPanelsProps {
  panels: BacklogPanels | null;
  failed: boolean;
  /** The item the backlog is filtered by, if any. */
  filter: PanelTarget | null;
  onFilter: (target: PanelTarget | null, name: string) => void;
  /** The item a drag is over, outlined as the place the tickets would go (T-162). */
  over: PanelTarget | null;
}

const same = (a: PanelTarget | null, b: PanelTarget) => a?.kind === b.kind && a.id === b.id;

/**
 * The backlog's planning panels (M1-047, AGL-008): the open outcomes and the unshipped releases
 * of the board's tracks, each with how many of its tickets the viewer sees. Choosing an item
 * filters the backlog to its tickets (pressed again, it shows all); dropping dragged tickets on
 * it puts them under the outcome or into the release. The backlog finds an item under the pointer
 * by its `data-drop-panel` and carries out the drop (T-162). The selection's menus do the same
 * from the keyboard.
 */
export function PlanningPanels({ panels, failed, filter, onFilter, over }: PlanningPanelsProps) {
  const t = useT();
  const day = useDayText();
  const id = useId();

  const item = (target: PanelTarget, name: string, body: ReactNode) => {
    const key = `${target.kind}-${target.id}`;
    const pressed = same(filter, target);
    return (
      <li
        key={key}
        className={`backlog-panel-item${same(over, target) ? ' is-drop-target' : ''}`}
        data-drop-panel={target.kind}
        data-target-id={target.id}
        data-name={name}
      >
        <button
          type="button"
          aria-pressed={pressed}
          onClick={() => onFilter(pressed ? null : target, name)}
        >
          {body}
        </button>
      </li>
    );
  };

  return (
    <aside className="backlog-panels" aria-label={t('sprints.panels.label')}>
      {failed && (
        <p className="board-problem" role="alert">
          {t('sprints.panels.failed')}
        </p>
      )}
      <section className="glass-card backlog-panel" aria-labelledby={`${id}-outcomes`}>
        <h2 id={`${id}-outcomes`}>{t('sprints.panels.outcomes')}</h2>
        {panels &&
          (panels.outcomes.length === 0 ? (
            <EmptyState compact title={t('sprints.panels.noOutcomes')} />
          ) : (
            <ul className="backlog-panel-list">
              {panels.outcomes.map((o) =>
                item(
                  { kind: 'outcome', id: o.id },
                  `${o.key} ${o.summary}`,
                  <>
                    <span className="backlog-panel-key">{o.key}</span>
                    <span className="backlog-panel-name">{o.summary}</span>
                    <span className="backlog-panel-count">
                      {t('sprints.panels.outcomeCount', { count: o.tickets, closed: o.closed })}
                    </span>
                  </>,
                ),
              )}
            </ul>
          ))}
      </section>
      <section className="glass-card backlog-panel" aria-labelledby={`${id}-releases`}>
        <h2 id={`${id}-releases`}>{t('sprints.panels.releases')}</h2>
        {panels &&
          (panels.releases.length === 0 ? (
            <EmptyState compact title={t('sprints.panels.noReleases')} />
          ) : (
            <ul className="backlog-panel-list">
              {panels.releases.map((r) =>
                item(
                  { kind: 'release', id: r.id },
                  r.name,
                  <>
                    <span className="backlog-panel-name">{r.name}</span>
                    <span className="backlog-panel-count">
                      {r.releaseDate
                        ? t('sprints.panels.releaseCountDated', {
                            count: r.tickets,
                            date: day(r.releaseDate),
                          })
                        : t('sprints.panels.releaseCount', { count: r.tickets })}
                    </span>
                  </>,
                ),
              )}
            </ul>
          ))}
      </section>
    </aside>
  );
}
