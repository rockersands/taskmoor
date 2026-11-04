import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';
import type { CapacityEntry, CapacityOf, CapacityUnit } from './client';

export interface CapacityDialogProps {
  /** Whose capacity: a team or a person of the plan's teams. */
  subject: { kind: 'team' | 'person'; id: number; name: string };
  unit: CapacityUnit;
  /** The periods in view, each with the label the page shows. */
  periods: { start: string; label: string }[];
  capacity: CapacityOf;
  /** Saves the changes; true when saved, else the refusal's code. */
  onSave: (entries: CapacityEntry[]) => Promise<true | string>;
  onClose: () => void;
}

/** A capacity as typed: empty for none, else a number from 0 to 100,000 in hundredths. */
function parseAmount(text: string): number | null | 'invalid' {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  return value <= 100_000 ? value : 'invalid';
}

const shown = (amount: number | null | undefined) =>
  amount === null || amount === undefined ? '' : String(amount);

/**
 * Setting the capacity of a team or a person in a plan (PLN-005, PLN-009): one amount and note for
 * every period, and, for each period in view, its own amount and note (leave, a holiday), which
 * replace the first there. An empty amount means none. Only what changed is sent, as one change.
 */
export function CapacityDialog({
  subject,
  unit,
  periods,
  capacity,
  onSave,
  onClose,
}: CapacityDialogProps) {
  const t = useT();
  const id = useId();
  const [every, setEvery] = useState(shown(capacity.default?.amount));
  const [everyNote, setEveryNote] = useState(capacity.default?.note ?? '');
  const own = (i: number) => (capacity.periods[i]?.from === 'period' ? capacity.periods[i] : null);
  const [amounts, setAmounts] = useState(() => periods.map((_, i) => shown(own(i)?.amount)));
  const [notes, setNotes] = useState(() => periods.map((_, i) => own(i)?.note ?? ''));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subjectOf = subject.kind === 'team' ? { teamId: subject.id } : { userId: subject.id };
  const changes = (): CapacityEntry[] | 'invalid' => {
    const out: CapacityEntry[] = [];
    const amount = parseAmount(every);
    if (amount === 'invalid') return 'invalid';
    const before = capacity.default;
    if (
      amount !== (before?.amount ?? null) ||
      (amount !== null && everyNote !== (before?.note ?? ''))
    ) {
      out.push({
        ...subjectOf,
        period: null,
        amount,
        ...(amount === null ? {} : { note: everyNote }),
      });
    }
    for (const [i, p] of periods.entries()) {
      const value = parseAmount(amounts[i] ?? '');
      if (value === 'invalid') return 'invalid';
      const was = own(i);
      const note = notes[i] ?? '';
      if (value !== (was?.amount ?? null) || (value !== null && note !== (was?.note ?? ''))) {
        out.push({
          ...subjectOf,
          period: p.start,
          amount: value,
          ...(value === null ? {} : { note }),
        });
      }
    }
    return out;
  };

  const save = async () => {
    const entries = changes();
    if (entries === 'invalid') {
      setProblem(t('plans.capacity.dialog.invalid'));
      return;
    }
    if (entries.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setProblem(null);
    const saved = await onSave(entries);
    setBusy(false);
    if (saved === true) return;
    setProblem(
      saved === 'forbidden'
        ? t('plans.capacity.forbidden')
        : saved === 'invalid_fields'
          ? t('plans.capacity.notInPlan')
          : t('plans.capacity.saveFailed'),
    );
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('plans.capacity.dialog.close')}
      focusFirstField
      className="capacity-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{t('plans.capacity.dialog.title', { name: subject.name })}</h2>
        <p className="board-hint">
          {t(
            unit === 'hours'
              ? 'plans.capacity.dialog.intro.hours'
              : 'plans.capacity.dialog.intro.points',
            { name: subject.name },
          )}
        </p>
        <fieldset className="capacity-dialog-group">
          <legend>{t('plans.capacity.dialog.every')}</legend>
          <div className="capacity-dialog-row">
            <label className="form-field" htmlFor={`${id}-every`}>
              <span className="form-label">{t('plans.capacity.dialog.everyAmount')}</span>
              <input
                id={`${id}-every`}
                inputMode="decimal"
                value={every}
                onChange={(event) => setEvery(event.target.value)}
              />
            </label>
            <label className="form-field" htmlFor={`${id}-every-note`}>
              <span className="form-label">{t('plans.capacity.dialog.everyNote')}</span>
              <input
                id={`${id}-every-note`}
                maxLength={200}
                value={everyNote}
                onChange={(event) => setEveryNote(event.target.value)}
              />
            </label>
          </div>
        </fieldset>
        <fieldset className="capacity-dialog-group">
          <legend>{t('plans.capacity.dialog.periods')}</legend>
          <p className="board-hint">{t('plans.capacity.dialog.periodsHint')}</p>
          {periods.map((p, i) => (
            <div className="capacity-dialog-row" key={p.start}>
              <label className="form-field" htmlFor={`${id}-p${i}`}>
                <span className="form-label">
                  {t('plans.capacity.dialog.amountFor', { period: p.label })}
                </span>
                <input
                  id={`${id}-p${i}`}
                  inputMode="decimal"
                  value={amounts[i] ?? ''}
                  placeholder={shown(capacity.default?.amount)}
                  onChange={(event) =>
                    setAmounts((list) => list.map((v, k) => (k === i ? event.target.value : v)))
                  }
                />
              </label>
              <label className="form-field" htmlFor={`${id}-n${i}`}>
                <span className="form-label">
                  {t('plans.capacity.dialog.noteFor', { period: p.label })}
                </span>
                <input
                  id={`${id}-n${i}`}
                  maxLength={200}
                  value={notes[i] ?? ''}
                  onChange={(event) =>
                    setNotes((list) => list.map((v, k) => (k === i ? event.target.value : v)))
                  }
                />
              </label>
            </div>
          ))}
        </fieldset>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('plans.capacity.dialog.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('plans.capacity.dialog.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
