import { type Ref, useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { lintMessage, type Names } from './describe';
import type { LintIssue } from './lint';
import type { Selection } from './WorkflowDiagram';

export interface LintPanelProps {
  issues: readonly LintIssue[];
  /** Errors already worded: the text mode's syntax or shape problems. */
  errors?: readonly string[];
  names: Names;
  /** Opens the status or transition an issue names. */
  onShow?: ((selection: Selection) => void) | undefined;
  headingRef?: Ref<HTMLHeadingElement>;
}

const MAX_SHOWN = 30;

/** The status or transition an issue is about, when the editor can show it. */
export function issueTarget(issue: LintIssue): Selection {
  if ('transitionId' in issue) return { kind: 'transition', id: issue.transitionId };
  if (issue.kind === 'unknown-status' || issue.kind === 'initial-missing') return null;
  return { kind: 'status', id: issue.statusId };
}

/**
 * The checks before publishing (WF-012, M1-030): errors the server would refuse and warnings
 * worth a look, each with a button to the status or transition it names.
 */
export function LintPanel({ issues, errors = [], names, onShow, headingRef }: LintPanelProps) {
  const t = useT();
  const id = useId();
  const errorCount = errors.length + issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - issues.filter((i) => i.severity === 'error').length;
  const nameOf = (selection: Selection) =>
    selection?.kind === 'transition'
      ? names.transition(selection.id)
      : selection
        ? names.status(selection.id)
        : '';

  return (
    <section aria-labelledby={`${id}-title`} className="workflow-checks">
      <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="facts-title">
        {t('workflow.lint.title')}
      </h2>
      {errorCount + warningCount === 0 ? (
        <p className="page-note">{t('workflow.lint.clean')}</p>
      ) : (
        <>
          <p className="page-note">
            {t('workflow.lint.summary', { errors: errorCount, warnings: warningCount })}
          </p>
          <ul className="lint-list">
            {errors.slice(0, MAX_SHOWN).map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: problems have no other identity
              <li key={`e${index}`} className="lint-item lint-error">
                <span className="lint-severity">{t('workflow.lint.error')}</span>
                <span className="lint-text">{line}</span>
              </li>
            ))}
            {issues.slice(0, MAX_SHOWN).map((issue, index) => {
              const selection = issueTarget(issue);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: issues have no other identity
                <li key={`i${index}`} className={`lint-item lint-${issue.severity}`}>
                  <span className="lint-severity">
                    {t(
                      issue.severity === 'error' ? 'workflow.lint.error' : 'workflow.lint.warning',
                    )}
                  </span>
                  <span className="lint-text">{lintMessage(t, issue, names)}</span>
                  {onShow && selection && (
                    <button
                      type="button"
                      className="button-secondary lint-show"
                      onClick={() => onShow(selection)}
                    >
                      {t('workflow.lint.show', { name: nameOf(selection) })}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
