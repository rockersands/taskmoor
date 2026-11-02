import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { TUTORIAL_SECTIONS, type TutorialSectionId, type TutorialStatus } from './sections';

interface TutorialPickerProps {
  /** Site administrators also see the sections that need one. */
  admin: boolean;
  status: Partial<Record<TutorialSectionId, TutorialStatus>>;
  selected: readonly TutorialSectionId[];
  onSelect: (selected: TutorialSectionId[]) => void;
  /** Starts, resumes or replays one section at once. */
  onStart: (section: TutorialSectionId) => void;
}

const STATUS: Record<TutorialStatus, MessageId> = {
  new: 'tutorial.status.new',
  active: 'tutorial.status.active',
  done: 'tutorial.status.done',
  skipped: 'tutorial.status.skipped',
};

const ACTION: Record<TutorialStatus, MessageId> = {
  new: 'tutorial.start',
  active: 'tutorial.resume',
  done: 'tutorial.replay',
  skipped: 'tutorial.start',
};

/**
 * The tutorial's sections as cards to tick (ADR-112): what each makes, how long it takes, where
 * the person is in it, and a button to start, resume or replay just that one. Used by the
 * first-run offer and by Settings, Tutorials.
 */
export function TutorialPicker({
  admin,
  status,
  selected,
  onSelect,
  onStart,
}: TutorialPickerProps) {
  const t = useT();
  const baseId = useId();
  const sections = TUTORIAL_SECTIONS.filter((s) => admin || !s.admin);
  return (
    <ul className="tutorial-picker">
      {sections.map((section) => {
        const { id, icon: Icon } = section;
        const state = status[id] ?? 'new';
        const checked = selected.includes(id);
        const title = t(section.titleId);
        const hintId = `${baseId}-${id}-hint`;
        return (
          <li key={id} className="tutorial-card glass-card" data-checked={checked}>
            <label className="tutorial-card-pick">
              <input
                type="checkbox"
                checked={checked}
                aria-label={t('tutorial.pick', { title })}
                aria-describedby={hintId}
                onChange={(event) =>
                  onSelect(
                    event.target.checked
                      ? [...selected, id]
                      : selected.filter((other) => other !== id),
                  )
                }
              />
              <span className="tutorial-card-icon">
                <Icon />
              </span>
            </label>
            <div className="tutorial-card-text">
              <p className="tutorial-card-title">{title}</p>
              <p id={hintId} className="tutorial-card-hint">
                {t(section.hintId)}
              </p>
              <p className="tutorial-card-meta">
                <span>{t('tutorial.minutes', { minutes: section.minutes })}</span>
                {section.admin && <span>{t('tutorial.adminOnly')}</span>}
                <span className="tutorial-card-status" data-status={state}>
                  {t(STATUS[state])}
                </span>
              </p>
            </div>
            <button
              type="button"
              className="button-quiet tutorial-card-start"
              aria-label={`${t(ACTION[state])}: ${title}`}
              onClick={() => onStart(id)}
            >
              {t(ACTION[state])}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
