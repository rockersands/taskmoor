import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { PlanSourceInput, SourceOptions } from './client';

export interface SourcePickerProps {
  options: SourceOptions | null;
  value: PlanSourceInput[];
  onChange: (value: PlanSourceInput[]) => void;
}

const keyOf = (s: PlanSourceInput) =>
  s.kind === 'track' ? `t${s.trackId}` : `s${s.savedSearchId}`;

/**
 * A plan's sources (PLN-001): tracks and saved searches the person sees, ticked in the order they
 * should be listed. Boards are not offered: each belongs to one track, and the track does the same.
 * A text box narrows both lists, for people who see hundreds of tracks.
 */
export function SourcePicker({ options, value, onChange }: SourcePickerProps) {
  const t = useT();
  const id = useId();
  const [filter, setFilter] = useState('');
  const chosen = new Set(value.map(keyOf));
  const toggle = (source: PlanSourceInput, on: boolean) =>
    onChange(on ? [...value, source] : value.filter((s) => keyOf(s) !== keyOf(source)));
  const needle = filter.trim().toLowerCase();
  const tracks = (options?.tracks ?? []).filter(
    (x) => !needle || `${x.key} ${x.name}`.toLowerCase().includes(needle),
  );
  const searches = (options?.savedSearches ?? []).filter(
    (x) => !needle || x.name.toLowerCase().includes(needle),
  );
  if (!options) return <p className="report-empty">{t('reports.loading')}</p>;
  return (
    <div className="plan-sources">
      <label className="form-field" htmlFor={`${id}-filter`}>
        <span className="form-label">{t('plans.sources.find')}</span>
        <input
          id={`${id}-filter`}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <p className="board-hint" aria-live="polite">
        {t('plans.sources.chosen', { count: value.length })}
      </p>
      <fieldset className="plan-source-group">
        <legend>{t('plans.sources.tracks')}</legend>
        {tracks.length === 0 ? (
          <p className="report-empty">{t('plans.sources.noTracks')}</p>
        ) : (
          <ul>
            {tracks.map((x) => {
              const source: PlanSourceInput = { kind: 'track', trackId: x.id };
              return (
                <li key={x.id}>
                  <label className="reports-check">
                    <input
                      type="checkbox"
                      checked={chosen.has(keyOf(source))}
                      onChange={(event) => toggle(source, event.target.checked)}
                    />
                    {t('plans.filter.trackOption', { key: x.key, name: x.name })}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <fieldset className="plan-source-group">
        <legend>{t('plans.sources.savedSearches')}</legend>
        {searches.length === 0 ? (
          <p className="report-empty">{t('plans.sources.noSavedSearches')}</p>
        ) : (
          <ul>
            {searches.map((x) => {
              const source: PlanSourceInput = { kind: 'savedSearch', savedSearchId: x.id };
              return (
                <li key={x.id}>
                  <label className="reports-check">
                    <input
                      type="checkbox"
                      checked={chosen.has(keyOf(source))}
                      onChange={(event) => toggle(source, event.target.checked)}
                    />
                    {x.name}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
    </div>
  );
}
