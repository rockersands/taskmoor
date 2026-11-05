import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { ModalDialog } from '../shell/ModalDialog';
import { planHref } from './address';
import type { PlanDuplicated } from './client';

export interface DuplicatePlanDialogProps {
  /** The plan copied. */
  name: string;
  /** How many of its sources are hidden from the person, known before they ask. */
  hiddenSources: number;
  /** Makes the copy, private to the person. */
  onDuplicate: (name: string) => Promise<PlanDuplicated>;
  /** Goes to the copy, when nothing was left out and so nothing is left to say. */
  onOpen: (id: number) => void;
  onClose: () => void;
}

/**
 * Copying a plan (T-089g; PLN-014), for anyone who sees it: it asks only for a name, and says what
 * comes and what does not. When sources were left out it says how many, never which, and offers the
 * copy; otherwise it goes straight there. On a phone it is a sheet, as every dialog is.
 */
export function DuplicatePlanDialog({
  name,
  hiddenSources,
  onDuplicate,
  onOpen,
  onClose,
}: DuplicatePlanDialogProps) {
  const t = useT();
  const id = useId();
  // A plan's name may already be the longest there is; a pair of surrogates is not cut in two.
  const [value, setValue] = useState(() =>
    t('plans.duplicate.defaultName', { name })
      .slice(0, 255)
      .replace(/[\ud800-\udbff]$/, ''),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [left, setLeft] = useState<{ id: number; count: number } | null>(null);

  const save = async () => {
    if (value.trim() === '') {
      setProblem(t('plans.duplicate.nameRequired'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const made = await onDuplicate(value.trim()).catch(() => null);
    setBusy(false);
    if (!made?.ok) {
      setProblem(t('plans.duplicate.failed'));
      return;
    }
    if (made.left.hiddenSources > 0) {
      setLeft({ id: made.plan.id, count: made.left.hiddenSources });
    } else onOpen(made.plan.id);
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('plans.duplicate.cancel')}
      focusFirstField
      className="plan-duplicate-dialog"
    >
      {left ? (
        <>
          <h2 id={`${id}-title`}>{t('plans.duplicate.done')}</h2>
          <p role="status">{t('plans.duplicate.left', { count: left.count })}</p>
          <div className="form-actions">
            <a className="button-primary" href={routeHref(planHref(left.id))}>
              {t('plans.duplicate.open')}
            </a>
            <button type="button" className="button-secondary" onClick={onClose}>
              {t('plans.duplicate.stay')}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h2 id={`${id}-title`}>{t('plans.duplicate.title', { name })}</h2>
          <p className="board-hint">{t('plans.duplicate.intro')}</p>
          {hiddenSources > 0 && (
            <p className="board-hint">{t('plans.duplicate.hidden', { count: hiddenSources })}</p>
          )}
          <label className="form-field" htmlFor={`${id}-name`}>
            <span className="form-label">{t('plans.name')}</span>
            <input
              id={`${id}-name`}
              value={value}
              maxLength={255}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {problem && (
            <p className="board-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('plans.duplicate.save')}
            </button>
            <button type="button" className="button-secondary" onClick={onClose}>
              {t('plans.duplicate.cancel')}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
