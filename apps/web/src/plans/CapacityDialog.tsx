import { Fragment, useEffect, useId, useState } from 'react';
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

/** What stops a save: an amount that is not one, or a note typed where no amount is. */
type Problem = { kind: 'invalid' } | { kind: 'note'; at: 'every' | number };

/**
 * Setting the capacity of a team or a person in a plan (PLN-005, PLN-009): one amount and note for
 * every period, and, for each period in view, its own amount and note (leave, a holiday), which
 * replace the first there. An empty amount means none, and a note goes with an amount: a note
 * typed without one is refused in words at the amount, never dropped. Only what changed is
 * sent, as one change.
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
  /** The amount a typed note is missing: every period's, or a period's by its index. */
  const [noteAt, setNoteAt] = useState<{ at: 'every' | number } | null>(null);
  const [busy, setBusy] = useState(false);
  const noteProblemId = `${id}-note-problem`;
  // That amount takes the focus once it says what is missing, each time a save is refused.
  useEffect(() => {
    if (!noteAt) return;
    document.getElementById(noteAt.at === 'every' ? `${id}-every` : `${id}-p${noteAt.at}`)?.focus();
  }, [noteAt, id]);
  /** The amount field's description and state while its note waits for it. */
  const amountState = (at: 'every' | number) =>
    noteAt?.at === at ? { 'aria-invalid': true as const, 'aria-describedby': noteProblemId } : {};
  const noteProblem = (at: 'every' | number, period?: string) =>
    noteAt?.at === at ? (
      <p id={noteProblemId} className="form-error">
        {period === undefined
          ? t('plans.capacity.dialog.noteNeedsAmountEvery')
          : t('plans.capacity.dialog.noteNeedsAmount', { period })}
      </p>
    ) : null;

  const subjectOf = subject.kind === 'team' ? { teamId: subject.id } : { userId: subject.id };
  const changes = (): CapacityEntry[] | Problem => {
    const out: CapacityEntry[] = [];
    const amount = parseAmount(every);
    if (amount === 'invalid') return { kind: 'invalid' };
    const values = amounts.map((text) => parseAmount(text));
    if (values.includes('invalid')) return { kind: 'invalid' };
    // A note typed where no amount is would be lost. Emptying an amount alone removes that
    // capacity, the note it had with it.
    const typed = (note: string, was: string | undefined) =>
      note.trim() !== '' && note !== (was ?? '');
    const before = capacity.default;
    if (amount === null && typed(everyNote, before?.note)) return { kind: 'note', at: 'every' };
    const missing = values.findIndex((v, i) => v === null && typed(notes[i] ?? '', own(i)?.note));
    if (missing >= 0) return { kind: 'note', at: missing };
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
      const value = (values[i] ?? null) as number | null;
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
    if (!Array.isArray(entries)) {
      if (entries.kind === 'invalid') {
        setNoteAt(null);
        setProblem(t('plans.capacity.dialog.invalid'));
        return;
      }
      // Said at the amount the note is missing, which takes the focus.
      setProblem(null);
      setNoteAt({ at: entries.at });
      return;
    }
    setNoteAt(null);
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
          : saved === 'settings_changed'
            ? t('plans.capacity.settingsChanged')
            : t('plans.capacity.saveFailed'),
    );
  };
  /** A row's amount or note changed: what was said about its note no longer holds. */
  const edited = (at: 'every' | number) => {
    if (noteAt?.at === at) setNoteAt(null);
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
                {...amountState('every')}
                onChange={(event) => {
                  setEvery(event.target.value);
                  edited('every');
                }}
              />
            </label>
            <label className="form-field" htmlFor={`${id}-every-note`}>
              <span className="form-label">{t('plans.capacity.dialog.everyNote')}</span>
              <input
                id={`${id}-every-note`}
                maxLength={200}
                value={everyNote}
                onChange={(event) => {
                  setEveryNote(event.target.value);
                  edited('every');
                }}
              />
            </label>
          </div>
          {noteProblem('every')}
        </fieldset>
        <fieldset className="capacity-dialog-group">
          <legend>{t('plans.capacity.dialog.periods')}</legend>
          <p className="board-hint">{t('plans.capacity.dialog.periodsHint')}</p>
          {periods.map((p, i) => (
            <Fragment key={p.start}>
              <div className="capacity-dialog-row">
                <label className="form-field" htmlFor={`${id}-p${i}`}>
                  <span className="form-label">
                    {t('plans.capacity.dialog.amountFor', { period: p.label })}
                  </span>
                  <input
                    id={`${id}-p${i}`}
                    inputMode="decimal"
                    value={amounts[i] ?? ''}
                    placeholder={shown(capacity.default?.amount)}
                    {...amountState(i)}
                    onChange={(event) => {
                      setAmounts((list) => list.map((v, k) => (k === i ? event.target.value : v)));
                      edited(i);
                    }}
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
                    onChange={(event) => {
                      setNotes((list) => list.map((v, k) => (k === i ? event.target.value : v)));
                      edited(i);
                    }}
                  />
                </label>
              </div>
              {noteProblem(i, p.label)}
            </Fragment>
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
