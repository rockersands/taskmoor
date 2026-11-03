import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';
import type { CompleteTarget, Sprint, SprintClient } from './client';

/** How many of a sprint's tickets are done (the board's rightmost column) and how many are open. */
export interface SprintCounts {
  done: number;
  open: number;
}

/** The value of a choice in the target select: `backlog`, `new` or a planned sprint's id. */
export const targetOf = (value: string): CompleteTarget =>
  value === 'backlog'
    ? { type: 'backlog' }
    : value === 'new'
      ? { type: 'new' }
      : { type: 'sprint', sprintId: Number(value) };

interface CompleteTargetSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The board's planned sprints, which can take the open tickets. */
  futures: readonly Sprint[];
}

/**
 * Where a completed sprint's open tickets go (AGL-010 (1)): the backlog, a planned sprint or a
 * new one, the choices the server takes. The label is the page's own.
 */
export function CompleteTargetSelect({ id, value, onChange, futures }: CompleteTargetSelectProps) {
  const t = useT();
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="backlog">{t('sprints.backlog.title')}</option>
      {futures.map((s) => (
        <option key={s.id} value={String(s.id)}>
          {s.name}
        </option>
      ))}
      <option value="new">{t('sprints.complete.newSprint')}</option>
    </select>
  );
}

/** Why a sprint was not completed, in the person's words. */
export function completeRefusal(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t('sprints.complete.failed');
  const body = error.body as { fields?: Record<string, string> } | null;
  if (error.status === 403) return t('sprints.complete.forbidden');
  if (error.code === 'sprint_not_active') return t('sprints.complete.notActive');
  if (error.status === 404) return t('sprints.complete.gone');
  if (body?.fields?.['moveTo.sprintId']) return t('sprints.complete.targetGone');
  return t('sprints.complete.failed');
}

export interface CompleteSprintDialogProps {
  sprint: Sprint;
  /** The board's planned sprints, which can take the open tickets. */
  futures: readonly Sprint[];
  /** What the board counts in the sprint; null when it could not count them. */
  counts: SprintCounts | null;
  client: Pick<SprintClient, 'complete'>;
  /** The sprint is completed. */
  onCompleted: () => void;
  onClose: () => void;
  /** Where focus goes once the dialog has closed (ModalDialog's). */
  restoreFocus?: (opener: HTMLElement | null) => void;
}

/**
 * Completing a sprint from its board (T-106; AGL-010): how many of its tickets are done and
 * how many are open, where the open ones go, and Complete or Cancel. The server decides; a
 * refusal stays in the dialog in plain words.
 */
export function CompleteSprintDialog({
  sprint,
  futures,
  counts,
  client,
  onCompleted,
  onClose,
  restoreFocus,
}: CompleteSprintDialogProps) {
  const t = useT();
  const titleId = useId();
  const targetId = useId();
  const [target, setTarget] = useState('backlog');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = useRef<HTMLButtonElement>(null);
  // A sprint with nothing open needs no place for it; the server still takes one.
  const asksWhere = counts === null || counts.open > 0;

  useEffect(() => {
    if (problem) submit.current?.focus();
  }, [problem]);

  const close = () => {
    if (!busy) onClose();
  };

  const complete = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await client.complete(sprint.id, asksWhere ? targetOf(target) : { type: 'backlog' });
      onCompleted();
    } catch (error) {
      setBusy(false);
      setProblem(completeRefusal(t, error));
    }
  };

  return (
    <ModalDialog
      onClose={close}
      labelledBy={titleId}
      closeLabel={t('sprints.completeDialog.close')}
      className="sprint-complete-dialog"
      {...(restoreFocus ? { restoreFocus } : {})}
    >
      <h2 id={titleId} className="section-title">
        {t('sprints.completeDialog.title', { name: sprint.name })}
      </h2>
      <p className="page-note">
        {counts === null
          ? t('sprints.completeDialog.uncounted')
          : counts.done + counts.open === 0
            ? t('sprints.completeDialog.empty')
            : counts.open === 0
              ? t('sprints.completeDialog.allDone', { done: counts.done })
              : t('sprints.completeDialog.counts', { done: counts.done, open: counts.open })}
      </p>
      {asksWhere && (
        <div className="form-field">
          <label htmlFor={targetId}>{t('sprints.completeDialog.target')}</label>
          <CompleteTargetSelect
            id={targetId}
            value={target}
            onChange={setTarget}
            futures={futures}
          />
        </div>
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <button
          ref={submit}
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => void complete()}
        >
          {t('sprints.complete.submit')}
        </button>
        <button type="button" className="button-quiet" onClick={close}>
          {t('sprints.completeDialog.cancel')}
        </button>
      </div>
    </ModalDialog>
  );
}
