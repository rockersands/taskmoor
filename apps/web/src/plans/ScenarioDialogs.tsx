import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ModalDialog } from '../shell/ModalDialog';
import type { Outcome, ScenarioRow } from './scenarioClient';

/** The words of a refused scenario write. */
const REFUSED: Record<string, MessageId> = {
  too_many_scenarios: 'scenario.refused.tooMany',
  version_conflict: 'scenario.refused.conflict',
  main_scenario: 'scenario.refused.main',
  apply_in_progress: 'scenario.refused.applying',
  forbidden: 'scenario.refused.forbidden',
  not_found: 'scenario.refused.gone',
};

/** Why a scenario write was refused, in words. */
export const scenarioRefusal = (t: ReturnType<typeof useT>, code: string) =>
  t(REFUSED[code] ?? 'scenario.refused.other');

export interface NewScenarioDialogProps {
  /** The plan's scenarios, to start from one. */
  scenarios: readonly ScenarioRow[];
  /** Makes it; the first a plan has is main. */
  onCreate: (
    name: string,
    from: number | undefined,
  ) => Promise<Outcome<{ scenario: ScenarioRow; left: { notShown: number } }>>;
  /** It was made: the page opens it, saying how many drafts stayed behind. */
  onMade: (scenario: ScenarioRow, notShown: number) => void;
  onClose: () => void;
}

/**
 * A new scenario (ADR-122 stage 6): a name, and where it starts, empty or as a copy of another
 * scenario's drafts the person is shown (the rest are only counted, after it is made). A sheet on
 * a phone, as every dialog is.
 */
export function NewScenarioDialog({
  scenarios,
  onCreate,
  onMade,
  onClose,
}: NewScenarioDialogProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setProblem(t('scenario.new.nameRequired'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const made = await onCreate(trimmed, from === '' ? undefined : Number(from)).catch(() => null);
    setBusy(false);
    if (!made) setProblem(t('scenario.refused.other'));
    else if (!made.ok) setProblem(scenarioRefusal(t, made.code));
    else onMade(made.value.scenario, made.value.left.notShown);
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('scenario.cancel')}
      focusFirstField
      className="scenario-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{t('scenario.new.title')}</h2>
        <p className="board-hint">{t('scenario.new.intro')}</p>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('scenario.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            aria-invalid={problem === t('scenario.new.nameRequired') || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {scenarios.length > 0 && (
          <label className="form-field" htmlFor={`${id}-from`}>
            <span className="form-label">{t('scenario.new.from')}</span>
            <select
              id={`${id}-from`}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            >
              <option value="">{t('scenario.new.empty')}</option>
              {scenarios.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {t('scenario.new.copyOf', { name: s.name, count: s.drafts })}
                </option>
              ))}
            </select>
          </label>
        )}
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('scenario.new.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('scenario.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

export interface RenameScenarioDialogProps {
  scenario: ScenarioRow;
  onRename: (name: string) => Promise<Outcome<ScenarioRow>>;
  onDone: (scenario: ScenarioRow) => void;
  onClose: () => void;
}

/** Renaming a scenario; a name changed by someone meanwhile is refused and said. */
export function RenameScenarioDialog({
  scenario,
  onRename,
  onDone,
  onClose,
}: RenameScenarioDialogProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(scenario.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setProblem(t('scenario.new.nameRequired'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const done = await onRename(trimmed).catch(() => null);
    setBusy(false);
    if (!done) setProblem(t('scenario.refused.other'));
    else if (!done.ok) setProblem(scenarioRefusal(t, done.code));
    else onDone(done.value);
  };
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('scenario.cancel')}
      focusFirstField
      className="scenario-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{t('scenario.rename.title', { name: scenario.name })}</h2>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('scenario.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('scenario.rename.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('scenario.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

export interface AskFirstProps {
  /** The first step's button, such as "Apply 3 changes" or "Make Faster main". */
  label: string;
  /** The first step's name when a list repeats it. */
  name?: string;
  /** The question: what will happen, said before anything does. */
  question: ReactNode;
  /** The button that does it. */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  /** The first step's look: primary for the page's main action, secondary otherwise. */
  look?: 'primary' | 'secondary';
}

/**
 * An action that changes something others rely on and asks first (ADR-122 stage 6): Apply and
 * Make main. Pressing it opens the question in its place with the action by name beside Cancel,
 * focus on Cancel; Escape, Cancel and the answer itself put the button back and focus it (the
 * caller moves focus on when the button goes). Unlike `DangerAction` it removes nothing, so it has
 * the plain look.
 */
export function AskFirst({
  label,
  name,
  question,
  confirmLabel,
  onConfirm,
  disabled = false,
  look = 'primary',
}: AskFirstProps) {
  const t = useT();
  const id = useId();
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (asking) cancel.current?.focus();
    else if (back.current) {
      back.current = false;
      trigger.current?.focus();
    }
  }, [asking]);
  const stop = () => {
    back.current = true;
    setAsking(false);
  };
  if (!asking) {
    return (
      <button
        ref={trigger}
        type="button"
        className={look === 'primary' ? 'button-primary' : 'button-secondary'}
        aria-label={name}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, not a set of fields
    <div
      className="danger-confirm ask-first"
      role="group"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        stop();
      }}
    >
      <p id={id} className="danger-confirm-outcome">
        {question}
      </p>
      <div className="danger-confirm-actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            // Focus goes back to the first step; the caller moves it on if that step goes.
            back.current = true;
            setAsking(false);
            void onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" className="button-secondary" onClick={stop}>
          {t('scenario.cancel')}
        </button>
      </div>
    </div>
  );
}
