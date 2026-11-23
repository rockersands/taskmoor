import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import {
  type Field,
  type FieldConfig,
  type FieldsClient,
  FORMULA_OUTPUTS,
  type FormulaCheck,
  type FormulaOutput,
  type FormulaProblem,
  NUMBER_OUTPUTS,
} from './client';
import { CurrencyInput, DecimalsSelect } from './FieldSettings';
import {
  FORMULA_FUNCTIONS,
  FORMULA_GIVES,
  FORMULA_SYSTEM_FIELDS,
  formulaProblemText,
  readableFields,
  readName,
} from './formulaWords';

/** How long typing pauses before the formula is checked. */
export const CHECK_DELAY_MS = 400;

export interface FormulaEditorProps {
  config: FieldConfig;
  onChange: (config: FieldConfig) => void;
  /** Every field the page knows: the help lists those a formula reads, the check names them. */
  fields: readonly Field[];
  check: FieldsClient['checkFormula'];
  /** The formula field being changed, so the check finds cycles through it; none for a new one. */
  fieldId?: number;
  /** The local-mode track a field belongs to; null for a shared one. */
  trackId: number | null;
  /** A save the server refused with `invalid_formula`, for the expression saved. */
  refused?: { problem: FormulaProblem; expression: string } | null;
}

/** The settings a formula keeps for an output: decimals for numbers, a currency for amounts. */
export function formulaConfig(config: FieldConfig, output: FormulaOutput): FieldConfig {
  const out: FieldConfig = { expression: config.expression ?? '', output };
  if (NUMBER_OUTPUTS.has(output) && config.decimals !== undefined) out.decimals = config.decimals;
  if (output === 'currency') out.currency = config.currency ?? '';
  return out;
}

/**
 * The formula editor (CORE-011 (3); T-320): the expression, what it gives (number, currency,
 * percentage, date, duration or text) with decimals and a currency where those fit, and a check
 * while typing (`GET /formulas/check`) that says where a mistake is, by line and column, in the
 * reader's language, or what the formula gives and which fields it reads. A short help lists the
 * fields it can read, in braces, and its functions, with a link to the manual.
 */
export function FormulaEditor({
  config,
  onChange,
  fields,
  check,
  fieldId,
  trackId,
  refused = null,
}: FormulaEditorProps) {
  const t = useT();
  const id = useId();
  const expression = config.expression ?? '';
  const output: FormulaOutput = config.output ?? 'number';
  const [result, setResult] = useState<{ for: string; check: FormulaCheck } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Checked once typing pauses; an answer for an older text is dropped.
  useEffect(() => {
    if (expression.trim() === '') {
      setResult(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      check({
        expression,
        output,
        ...(fieldId !== undefined ? { fieldId } : {}),
        ...(fieldId === undefined && trackId !== null ? { trackId } : {}),
      }).then(
        (answer) => live && setResult({ for: `${output}\n${expression}`, check: answer }),
        () => live && setResult(null),
      );
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [check, expression, output, fieldId, trackId]);

  const current = result?.for === `${output}\n${expression}` ? result.check : null;
  const saidRefusal =
    refused && refused.expression === expression
      ? formulaProblemText(t, refused.problem, expression)
      : null;
  const verdict =
    saidRefusal ??
    (current === null
      ? ''
      : current.ok
        ? [
            t(FORMULA_GIVES[current.type] ?? 'admin.fields.formula.gives.number'),
            current.reads.length === 0 && current.childReads.length === 0
              ? t('admin.fields.formula.readsNothing')
              : t('admin.fields.formula.reads', {
                  fields: [...new Set([...current.reads, ...current.childReads])]
                    .map((ref) => readName(ref, fields))
                    .join(', '),
                }),
          ].join(' ')
        : formulaProblemText(t, current.error, expression));
  const wrong = saidRefusal !== null || (current !== null && !current.ok);
  const readable = readableFields(fields, trackId, fieldId);

  return (
    <fieldset className="sets-choices formula-editor">
      <legend>{t('admin.fields.formula.legend')}</legend>
      <div className="form-field formula-expression">
        <label htmlFor={`${id}-expression`} className="form-label">
          {t('admin.fields.formula.expression')}
        </label>
        <textarea
          id={`${id}-expression`}
          required
          rows={3}
          spellCheck={false}
          maxLength={4000}
          aria-describedby={`${id}-verdict ${id}-hint`}
          aria-invalid={wrong || undefined}
          value={expression}
          onChange={(event) => onChange({ ...config, expression: event.target.value, output })}
        />
        <p id={`${id}-hint`} className="form-hint">
          {t('admin.fields.formula.hint')}
        </p>
        <p id={`${id}-verdict`} role="status" className={wrong ? 'form-error' : 'form-hint'}>
          {verdict}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-output`} className="form-label">
          {t('admin.fields.formula.output')}
        </label>
        <select
          id={`${id}-output`}
          value={output}
          onChange={(event) => onChange(formulaConfig(config, event.target.value as FormulaOutput))}
        >
          {FORMULA_OUTPUTS.map((o) => (
            <option key={o} value={o}>
              {t(`admin.fields.formula.output.${o}` as MessageId)}
            </option>
          ))}
        </select>
      </div>
      {NUMBER_OUTPUTS.has(output) && (
        <div className="form-field">
          <label htmlFor={`${id}-decimals`} className="form-label">
            {t('admin.fields.settings.decimals')}
          </label>
          <DecimalsSelect
            id={`${id}-decimals`}
            value={config.decimals}
            onChange={(decimals) => {
              const { decimals: _, ...rest } = formulaConfig(config, output);
              onChange(decimals === undefined ? rest : { ...rest, decimals });
            }}
          />
        </div>
      )}
      {output === 'currency' && (
        <CurrencyInput
          id={`${id}-currency`}
          value={config.currency ?? ''}
          onChange={(currency) => onChange({ ...formulaConfig(config, output), currency })}
        />
      )}
      <div className="formula-help">
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={helpOpen}
          aria-controls={`${id}-help`}
          onClick={() => setHelpOpen(!helpOpen)}
        >
          {t('admin.fields.formula.help')}
        </button>
        {helpOpen && (
          <div id={`${id}-help`} className="people-panel">
            <p id={`${id}-help-fields`} className="form-label">
              {t('admin.fields.formula.helpFields')}
            </p>
            <ul className="formula-names" aria-labelledby={`${id}-help-fields`}>
              {[...FORMULA_SYSTEM_FIELDS.map((s) => s.name), ...readable.map((f) => f.name)].map(
                (name) => (
                  <li key={name}>
                    <code>{`{${name}}`}</code>
                  </li>
                ),
              )}
            </ul>
            <p id={`${id}-help-functions`} className="form-label">
              {t('admin.fields.formula.helpFunctions')}
            </p>
            <ul className="formula-names" aria-labelledby={`${id}-help-functions`}>
              {FORMULA_FUNCTIONS.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
            <p className="form-hint">{t('admin.fields.formula.helpMore')}</p>
          </div>
        )}
      </div>
    </fieldset>
  );
}
