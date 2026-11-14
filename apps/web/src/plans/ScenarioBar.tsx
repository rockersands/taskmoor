import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import type { ScenarioList, ScenarioRow } from './scenarioClient';

/** The value of the select's last choice, which opens the New scenario dialog. */
const NEW = 'new';

export interface ScenarioBarProps {
  /** The plan's scenarios, or null while they load. */
  list: ScenarioList | null;
  /** The scenario the page reads, or null for Live. */
  active: ScenarioRow | null;
  /** The address named a scenario that no longer exists: the page shows the plan live. */
  missing: boolean;
  /** The address of the Changes tab in the active scenario. */
  changesHref: string;
  /** Chooses a scenario, or Live (null). */
  onChoose: (scenario: number | null) => void;
  /** Asks for a new scenario. */
  onNew: () => void;
}

/**
 * The scenario a plan's tabs read (T-089e; PLN-002, PLN-003; ADR-122 stage 6), below the plan's
 * name: a native select of Live first, then the plan's scenarios (the main one says so in words),
 * then New scenario… for those who may draft; and a sentence that says what an edit does here.
 * Live, edits change tickets at once; in a scenario they are drafts, which change nothing until
 * they are applied, and **Review N changes** opens the change list. The choice is in the page's
 * address, so a link opens the same scenario; a change of it is announced. On a phone the select
 * is full width and a finger's height, the sentence under it.
 */
export function ScenarioBar({
  list,
  active,
  missing,
  changesHref,
  onChoose,
  onNew,
}: ScenarioBarProps) {
  const t = useT();
  const id = useId();
  const [said, setSaid] = useState('');
  const editable = list?.editable ?? false;
  // Said when the choice changes, not when the page first opens on one.
  const shownId = active?.id ?? null;
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: announced when the scenario read changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaid(active ? t('scenario.bar.nowIn', { name: active.name }) : t('scenario.bar.nowLive'));
  }, [shownId]);

  const sentence = !active
    ? t('scenario.bar.live')
    : editable
      ? t('scenario.bar.drafting', { name: active.name, count: active.drafts })
      : t('scenario.bar.viewing', { name: active.name });

  return (
    <section className="scenario-bar" aria-labelledby={`${id}-label`}>
      <div className="scenario-bar-choice">
        <label className="form-field" htmlFor={`${id}-select`}>
          <span className="form-label" id={`${id}-label`}>
            {t('scenario.bar.label')}
          </span>
          <select
            id={`${id}-select`}
            value={active ? String(active.id) : ''}
            aria-describedby={`${id}-sentence`}
            disabled={list === null}
            onChange={(event) => {
              const value = event.target.value;
              if (value === NEW) {
                // The select stays on what the page reads until a scenario is made.
                event.target.value = active ? String(active.id) : '';
                onNew();
              } else onChoose(value === '' ? null : Number(value));
            }}
          >
            <option value="">{t('scenario.bar.liveOption')}</option>
            {(list?.scenarios ?? []).map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.main ? t('scenario.bar.mainOption', { name: s.name }) : s.name}
              </option>
            ))}
            {editable && <option value={NEW}>{t('scenario.bar.newOption')}</option>}
          </select>
        </label>
        {active && active.drafts > 0 && (
          <a className="button-secondary scenario-bar-review" href={routeHref(changesHref)}>
            {t('scenario.bar.review', { count: active.drafts })}
          </a>
        )}
      </div>
      <p id={`${id}-sentence`} className={`scenario-bar-sentence${active ? ' is-draft' : ''}`}>
        {sentence}
        {active && active.notShown > 0 && ` ${t('scenario.notShown', { count: active.notShown })}`}
      </p>
      {missing && (
        <p className="board-problem" role="alert">
          {t('scenario.bar.missing')}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}
