import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { Status } from './definition';

export interface DefinitionTextProps {
  text: string;
  onChange: (text: string) => void;
  invalid: boolean;
  /** The workflow's status ids with their names, as a key to the JSON. */
  statuses: readonly { id: number; name: string }[];
  describedBy?: string | undefined;
}

/**
 * The text mode (WF-002, M1-030): the definition as the JSON the API stores, imports and
 * exports (WF-011), with a key from status ids to names. Problems show in the checks panel;
 * switching back to the diagram takes the text as it reads.
 */
export function DefinitionText({
  text,
  onChange,
  invalid,
  statuses,
  describedBy,
}: DefinitionTextProps) {
  const t = useT();
  const id = useId();
  return (
    <div className="workflow-text">
      <div className="form-field">
        <label htmlFor={`${id}-text`}>{t('admin.workflow.text.label')}</label>
        <textarea
          id={`${id}-text`}
          className="workflow-text-input"
          rows={24}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={text}
          aria-invalid={invalid}
          aria-describedby={[`${id}-hint`, describedBy].filter(Boolean).join(' ')}
          onChange={(e) => onChange(e.target.value)}
        />
        <p id={`${id}-hint`} className="form-hint">
          {t('admin.workflow.text.hint')}
        </p>
      </div>
      <section aria-labelledby={`${id}-legend`} className="workflow-text-legend">
        <h2 id={`${id}-legend`} className="facts-title">
          {t('admin.workflow.text.legend')}
        </h2>
        <ul>
          {statuses.map((s) => (
            <li key={s.id}>{t('admin.workflow.text.legendItem', { id: s.id, name: s.name })}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The key's entries: the workspace's statuses, the ones the workflow uses first. */
export function legendOf(statuses: readonly Status[], used: readonly number[]) {
  const usedSet = new Set(used);
  return [
    ...statuses.filter((s) => usedSet.has(s.id)),
    ...statuses.filter((s) => !usedSet.has(s.id)),
  ].map((s) => ({ id: s.id, name: s.name }));
}
