import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { TutorialSection, TutorialSectionId, TutorialStatus } from './sections';

interface TutorialPickerProps {
  /** The sections this person is offered (`sectionsFor`), in order. */
  sections: readonly TutorialSection[];
  status: Partial<Record<TutorialSectionId, TutorialStatus>>;
  selected: readonly TutorialSectionId[];
  onSelect: (selected: TutorialSectionId[]) => void;
  /** Starts, resumes or replays one section at once; the first-run offer leaves it out. */
  onStart?: (section: TutorialSectionId) => void;
  /** Inside other glass, as in the first-run offer: the cards are wells, with no blur of their own. */
  nested?: boolean;
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
 * The tutorial's sections as cards to tick (ADR-115): what each makes, how long it takes, where
 * the person is in it, and a button to start, resume or replay just that one. Used by the
 * first-run offer and by Settings, Tutorials.
 */
export function TutorialPicker({
  sections,
  status,
  selected,
  onSelect,
  onStart,
  nested = false,
}: TutorialPickerProps) {
  const t = useT();
  const baseId = useId();
  return (
    <ul className="tutorial-picker">
      {sections.map((section) => {
        const { id, icon: Icon } = section;
        const state = status[id] ?? 'new';
        const checked = selected.includes(id);
        const title = t(section.titleId);
        const hintId = `${baseId}-${id}-hint`;
        return (
          <li
            key={id}
            className={nested ? 'tutorial-card tutorial-card-well' : 'tutorial-card glass-card'}
            data-checked={checked}
          >
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
                {section.who === 'site' && <span>{t('tutorial.adminOnly')}</span>}
                {section.who === 'setup' && <span>{t('tutorial.setupOnly')}</span>}
                <span className="tutorial-card-status" data-status={state}>
                  {t(STATUS[state])}
                </span>
              </p>
            </div>
            {onStart && (
              <button
                type="button"
                className="button-quiet tutorial-card-start"
                aria-label={t('tutorial.actionOn', { action: t(ACTION[state]), title })}
                onClick={() => onStart(id)}
              >
                {t(ACTION[state])}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
