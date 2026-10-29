import { type ReactNode, useId, useMemo } from 'react';
import { timeZoneOptions } from '../account/options';
import { useT } from '../i18n/I18nProvider';
import type { NumberField, SprintSettings } from './client';

/** The server's bounds of a cycle (`sprintCycleInput`, AGL-012). */
export const MIN_CYCLE_DAYS = 1;
export const MAX_CYCLE_DAYS = 91;
/** A new cycle's length: two weeks, as AGL-012's example. */
const DEFAULT_CYCLE_DAYS = 14;

/** Sprint settings as the form edits them: numbers stay text until they are saved. */
export interface SprintDraft {
  statistic: SprintSettings['estimation']['statistic'];
  /** The number field's id, or '' when none is picked. */
  fieldId: string;
  timeTracking: SprintSettings['timeTracking'];
  parallelSprints: boolean;
  cycle: boolean;
  lengthDays: string;
  timeZone: string;
}

/** The draft of saved settings; `timeZone` is a new cycle's zone (the person's, or UTC). */
export function sprintDraftOf(settings: SprintSettings, timeZone: string): SprintDraft {
  const { estimation, cycle } = settings;
  return {
    statistic: estimation.statistic,
    fieldId: estimation.fieldId === undefined ? '' : String(estimation.fieldId),
    timeTracking: settings.timeTracking,
    parallelSprints: settings.parallelSprints,
    cycle: Boolean(cycle),
    lengthDays: String(cycle?.lengthDays ?? DEFAULT_CYCLE_DAYS),
    timeZone: cycle?.timeZone ?? timeZone,
  };
}

/**
 * The settings a draft saves as. A field statistic without a field, a length that is not a
 * number and a cycle beside parallel sprints go to the server as they are: its refusal is the
 * one shown next to the field.
 */
export function sprintSettingsOf(draft: SprintDraft): SprintSettings {
  return {
    estimation:
      draft.statistic === 'field' && draft.fieldId !== ''
        ? { statistic: 'field', fieldId: Number(draft.fieldId) }
        : { statistic: draft.statistic },
    timeTracking: draft.timeTracking,
    parallelSprints: draft.parallelSprints,
    cycle: draft.cycle ? { lengthDays: Number(draft.lengthDays), timeZone: draft.timeZone } : null,
  };
}

export interface SprintSettingsSectionProps {
  value: SprintDraft;
  onChange: (change: Partial<SprintDraft>) => void;
  /** Number fields the person sees; a saved field missing from them still shows by its id. */
  numberFields: readonly NumberField[];
  /** The server's refusals by path, as the board PATCH reports them (`sprintSettings.cycle`). */
  problems: Readonly<Record<string, string>>;
}

/**
 * A Scrum board's sprint settings (M1-044, M1-045): the estimation statistic with its number
 * field (AGL-007), time tracking, parallel sprints (AGL-011) and the auto-rolling cycle, off
 * or a length in days on a time zone (AGL-012). Part of the board settings form, which saves
 * it with the rest through `PATCH /api/v1/boards/:id`.
 */
export function SprintSettingsSection({
  value,
  onChange,
  numberFields,
  problems,
}: SprintSettingsSectionProps) {
  const t = useT();
  const id = useId();
  const zones = useMemo(() => timeZoneOptions(value.timeZone), [value.timeZone]);
  const fields =
    value.fieldId === '' || numberFields.some((f) => String(f.id) === value.fieldId)
      ? numberFields
      : [
          ...numberFields,
          {
            id: Number(value.fieldId),
            name: t('sprints.settings.fieldUnknown', { id: value.fieldId }),
          },
        ];

  const problemTexts: Record<string, (code: string) => string> = {
    'estimation.fieldId': (code) =>
      code === 'not_a_number_field'
        ? t('sprints.settings.notANumberField')
        : t('sprints.settings.pickField'),
    cycle: (code) =>
      code === 'not_with_parallel_sprints'
        ? t('sprints.settings.notWithParallel')
        : t('boards.settings.invalidValue'),
    'cycle.lengthDays': () =>
      t('sprints.settings.badLength', { min: MIN_CYCLE_DAYS, max: MAX_CYCLE_DAYS }),
    'cycle.timeZone': (code) =>
      code === 'unknown_time_zone'
        ? t('sprints.settings.unknownTimeZone')
        : t('boards.settings.invalidValue'),
  };
  const problem = (path: string) => problems[`sprintSettings.${path}`];
  /** Props of a control the server refused, with its hint (if any) and the refusal. */
  const described = (path: string, inputId: string, hintId?: string) => {
    const ids = [...(hintId ? [hintId] : []), ...(problem(path) ? [`${inputId}-problem`] : [])];
    return {
      ...(ids.length > 0 ? { 'aria-describedby': ids.join(' ') } : {}),
      ...(problem(path) ? { 'aria-invalid': true as const } : {}),
    };
  };
  const problemText = (path: string, inputId: string): ReactNode => {
    const code = problem(path);
    if (code === undefined) return null;
    const text = problemTexts[path];
    return (
      <p id={`${inputId}-problem`} className="form-error">
        {text ? text(code) : t('boards.settings.invalidValue')}
      </p>
    );
  };

  const statisticId = `${id}-statistic`;
  const fieldId = `${id}-field`;
  const trackingId = `${id}-tracking`;
  const parallelId = `${id}-parallel`;
  const cycleId = `${id}-cycle`;
  const lengthId = `${id}-length`;
  const zoneId = `${id}-zone`;

  return (
    <fieldset className="board-settings-section sprint-settings">
      <legend>{t('sprints.settings.title')}</legend>
      <div className="form-field">
        <label htmlFor={statisticId} className="form-label">
          {t('sprints.settings.statistic')}
        </label>
        <select
          id={statisticId}
          value={value.statistic}
          onChange={(e) => onChange({ statistic: e.target.value as SprintDraft['statistic'] })}
          {...described('estimation.statistic', statisticId)}
        >
          <option value="originalEstimate">
            {t('sprints.settings.statistic.originalEstimate')}
          </option>
          <option value="field">{t('sprints.settings.statistic.field')}</option>
          <option value="ticketCount">{t('sprints.settings.statistic.ticketCount')}</option>
        </select>
        {problemText('estimation.statistic', statisticId)}
      </div>
      {value.statistic === 'field' && (
        <div className="form-field">
          <label htmlFor={fieldId} className="form-label">
            {t('sprints.settings.field')}
          </label>
          <select
            id={fieldId}
            required
            value={value.fieldId}
            onChange={(e) => onChange({ fieldId: e.target.value })}
            {...described(
              'estimation.fieldId',
              fieldId,
              numberFields.length === 0 ? `${fieldId}-hint` : undefined,
            )}
          >
            <option value="">{t('sprints.settings.fieldPlaceholder')}</option>
            {fields.map((field) => (
              <option key={field.id} value={String(field.id)}>
                {t('common.value', { value: field.name })}
              </option>
            ))}
          </select>
          {numberFields.length === 0 && (
            <p id={`${fieldId}-hint`} className="form-hint">
              {t('sprints.settings.noFields')}
            </p>
          )}
          {problemText('estimation.fieldId', fieldId)}
        </div>
      )}
      <div className="form-field">
        <label htmlFor={trackingId} className="form-label">
          {t('sprints.settings.timeTracking')}
        </label>
        <select
          id={trackingId}
          value={value.timeTracking}
          onChange={(e) =>
            onChange({ timeTracking: e.target.value === 'none' ? 'none' : 'remainingEstimate' })
          }
          {...described('timeTracking', trackingId)}
        >
          <option value="remainingEstimate">
            {t('sprints.settings.timeTracking.remainingEstimate')}
          </option>
          <option value="none">{t('sprints.settings.timeTracking.none')}</option>
        </select>
        {problemText('timeTracking', trackingId)}
      </div>
      <div className="sprint-settings-option">
        <label className="board-settings-check">
          <input
            id={parallelId}
            type="checkbox"
            checked={value.parallelSprints}
            onChange={(e) => onChange({ parallelSprints: e.target.checked })}
            {...described('parallelSprints', parallelId)}
          />
          {t('sprints.settings.parallel')}
        </label>
        {problemText('parallelSprints', parallelId)}
      </div>
      <div className="sprint-settings-option">
        <label className="board-settings-check">
          <input
            id={cycleId}
            type="checkbox"
            checked={value.cycle}
            onChange={(e) => onChange({ cycle: e.target.checked })}
            {...described('cycle', cycleId, `${cycleId}-hint`)}
          />
          {t('sprints.settings.cycle')}
        </label>
        <p id={`${cycleId}-hint`} className="form-hint">
          {t('sprints.settings.cycleHint')}
        </p>
        {problemText('cycle', cycleId)}
      </div>
      {value.cycle && (
        <div className="board-settings-limits">
          <div className="form-field">
            <label htmlFor={lengthId} className="form-label">
              {t('sprints.settings.lengthDays')}
            </label>
            <input
              id={lengthId}
              type="number"
              required
              min={MIN_CYCLE_DAYS}
              max={MAX_CYCLE_DAYS}
              step={1}
              inputMode="numeric"
              value={value.lengthDays}
              onChange={(e) => onChange({ lengthDays: e.target.value })}
              {...described('cycle.lengthDays', lengthId, `${lengthId}-hint`)}
            />
            <p id={`${lengthId}-hint`} className="form-hint">
              {t('sprints.settings.lengthHint', { min: MIN_CYCLE_DAYS, max: MAX_CYCLE_DAYS })}
            </p>
            {problemText('cycle.lengthDays', lengthId)}
          </div>
          <div className="form-field sprint-settings-zone">
            <label htmlFor={zoneId} className="form-label">
              {t('sprints.settings.timeZone')}
            </label>
            <select
              id={zoneId}
              value={value.timeZone}
              onChange={(e) => onChange({ timeZone: e.target.value })}
              {...described('cycle.timeZone', zoneId, `${zoneId}-hint`)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {t('common.value', { value: zone.replaceAll('_', ' ') })}
                </option>
              ))}
            </select>
            <p id={`${zoneId}-hint`} className="form-hint">
              {t('sprints.settings.timeZoneHint')}
            </p>
            {problemText('cycle.timeZone', zoneId)}
          </div>
        </div>
      )}
    </fieldset>
  );
}
