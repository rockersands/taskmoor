import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';

/** A site team a plan may plan with; `memberCount` null when the list did not give it. */
export interface TeamOption {
  id: number;
  name: string;
  memberCount: number | null;
}

export interface TeamPickerProps {
  options: TeamOption[] | null;
  /** Team ids, in the order the Capacity view lists them. */
  value: number[];
  onChange: (value: number[]) => void;
}

/**
 * The site teams a plan plans with (PLN-005; ADR-076), ticked in the order the Capacity view lists
 * them. Everyone signed in reads teams, so every team is offered; a team gives nobody access. A
 * text box narrows the list on sites with many teams.
 */
export function TeamPicker({ options, value, onChange }: TeamPickerProps) {
  const t = useT();
  const id = useId();
  const [filter, setFilter] = useState('');
  if (!options) return <p className="report-loading">{t('reports.loading')}</p>;
  const chosen = new Set(value);
  const needle = filter.trim().toLowerCase();
  const shown = options.filter((x) => !needle || x.name.toLowerCase().includes(needle));
  const toggle = (team: number, on: boolean) =>
    onChange(on ? [...value, team] : value.filter((x) => x !== team));
  return (
    // Inside the settings' "Teams and capacity" box it is a plain group, not a box in a box (PL-41).
    <fieldset className="plan-source-group plan-team-group">
      <legend>{t('plans.settings.teams')}</legend>
      <p className="board-hint">{t('plans.settings.teamsHint')}</p>
      {options.length === 0 ? (
        <EmptyState compact title={t('plans.settings.noTeams')} />
      ) : (
        <>
          {options.length > 8 && (
            <label className="form-field" htmlFor={`${id}-filter`}>
              <span className="form-label">{t('plans.settings.findTeam')}</span>
              <input
                id={`${id}-filter`}
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
          )}
          <p className="board-hint" aria-live="polite">
            {t('plans.settings.teamsChosen', { count: value.length })}
          </p>
          <ul>
            {shown.map((x) => (
              <li key={x.id} className="form-field form-field-inline">
                <input
                  id={`${id}-team-${x.id}`}
                  type="checkbox"
                  checked={chosen.has(x.id)}
                  onChange={(event) => toggle(x.id, event.target.checked)}
                />
                <label htmlFor={`${id}-team-${x.id}`}>
                  {x.memberCount === null
                    ? x.name
                    : t('plans.settings.teamOption', { name: x.name, count: x.memberCount })}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </fieldset>
  );
}
