import { type Ref, useEffect, useId, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import { DangerAction } from '../shell/DangerAction';
import { fieldsOf } from './catalogue';
import {
  type CheckDef,
  type EffectDef,
  LIMITS,
  type RuleDef,
  type Transition,
  type WorkflowDefinition,
  withOptional,
} from './definition';
import type { Names } from './describe';
import { GuardTree, type PickerContext, RuleList } from './RuleEditor';
import { fieldLabel } from './refusal';

type Rule = { type: string } & Record<string, unknown>;

export interface TransitionInspectorProps {
  transition: Transition;
  definition: WorkflowDefinition;
  names: Names;
  context: PickerContext;
  onChange: (transition: Transition) => void;
  onRulesChange: (rules: RuleDef[]) => void;
  onDelete: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Focus the name field on mount: a transition just added gets its name first. */
  focusName?: boolean;
}

const EVENT = /^[a-z][a-z0-9-]{0,99}$/;

/**
 * Everything about one transition (spec 01a section 3.1; WF-001, WF-003 to WF-006, WF-009):
 * name, where it starts and goes, the fields it asks for, its guards, checks and effects in the
 * order the engine runs them, local-mode rules, properties, its event and the external events
 * that run it. Every change goes straight into the draft being edited.
 */
export function TransitionInspector({
  transition,
  definition,
  names,
  context,
  onChange,
  onRulesChange,
  onDelete,
  headingRef,
  focusName = false,
}: TransitionInspectorProps) {
  const t = useT();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const statusIds = definition.statuses.map((s) => s.statusId);
  const rules = definition.rules?.[String(transition.id)] ?? [];
  const set = <K extends keyof Transition>(key: K, value: Transition[K] | undefined) =>
    onChange(withOptional(transition, key, value));
  const nameMissing = transition.name.trim() === '';
  const eventInvalid = transition.event !== undefined && !EVENT.test(transition.event);

  useEffect(() => {
    if (focusName) nameInput.current?.focus();
  }, [focusName]);

  const fromList = transition.from === 'any' ? [] : transition.from;
  const properties = Object.entries(transition.properties ?? {});
  const triggers = transition.triggers ?? [];

  return (
    <section className="glass-card workflow-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="facts-title">
        {t('admin.workflow.transition.heading', { name: names.transition(transition.id) })}
      </h2>
      <div className="form workflow-form">
        <div className="form-field">
          <label htmlFor={`${id}-name`}>{t('admin.workflow.transition.name')}</label>
          <input
            ref={nameInput}
            id={`${id}-name`}
            type="text"
            maxLength={255}
            value={transition.name}
            aria-invalid={nameMissing}
            aria-describedby={nameMissing ? `${id}-name-error` : undefined}
            onChange={(e) => onChange({ ...transition, name: e.target.value })}
          />
          {nameMissing && (
            <p id={`${id}-name-error`} className="form-hint rule-invalid">
              {t('admin.workflow.transition.nameRequired')}
            </p>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-description`}>{t('admin.workflow.transition.description')}</label>
          <textarea
            id={`${id}-description`}
            rows={2}
            maxLength={2000}
            value={transition.description ?? ''}
            onChange={(e) => set('description', e.target.value === '' ? undefined : e.target.value)}
          />
        </div>

        <fieldset>
          <legend>{t('admin.workflow.transition.from')}</legend>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-from-list`}
              type="radio"
              name={`${id}-from`}
              checked={transition.from !== 'any'}
              onChange={() =>
                set('from', [statusIds.find((s) => s !== transition.to) ?? transition.to])
              }
            />
            <label htmlFor={`${id}-from-list`}>{t('admin.workflow.transition.fromList')}</label>
          </div>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-from-any`}
              type="radio"
              name={`${id}-from`}
              checked={transition.from === 'any'}
              onChange={() => set('from', 'any')}
            />
            <label htmlFor={`${id}-from-any`}>{t('admin.workflow.transition.fromAny')}</label>
          </div>
          {transition.from !== 'any' && (
            <fieldset className="rule-choices">
              <legend>{t('admin.workflow.transition.sources')}</legend>
              {[...statusIds, ...fromList.filter((s) => !statusIds.includes(s))].map((s) => (
                <div key={s} className="form-field form-field-inline">
                  <input
                    id={`${id}-source-${s}`}
                    type="checkbox"
                    checked={fromList.includes(s)}
                    onChange={(e) =>
                      set(
                        'from',
                        e.target.checked ? [...fromList, s] : fromList.filter((x) => x !== s),
                      )
                    }
                  />
                  <label htmlFor={`${id}-source-${s}`}>{names.status(s)}</label>
                </div>
              ))}
              {fromList.length === 0 && (
                <p className="form-hint rule-invalid">{t('admin.workflow.transition.fromNone')}</p>
              )}
            </fieldset>
          )}
        </fieldset>

        <div className="form-field">
          <label htmlFor={`${id}-to`}>{t('admin.workflow.transition.to')}</label>
          <select
            id={`${id}-to`}
            value={String(transition.to)}
            onChange={(e) => set('to', Number(e.target.value))}
          >
            {[...statusIds, ...(statusIds.includes(transition.to) ? [] : [transition.to])].map(
              (s) => (
                <option key={s} value={String(s)}>
                  {names.status(s)}
                </option>
              ),
            )}
          </select>
        </div>

        <fieldset className="rule-choices">
          <legend>{t('admin.workflow.transition.layout')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.layoutHint')}</p>
          {[
            ...fieldsOf('writable'),
            ...(transition.layout ?? []).filter((f) => !fieldsOf('writable').includes(f)),
          ].map((field) => {
            const layout = transition.layout ?? [];
            return (
              <div key={field} className="form-field form-field-inline">
                <input
                  id={`${id}-layout-${field}`}
                  type="checkbox"
                  checked={layout.includes(field)}
                  disabled={!layout.includes(field) && layout.length >= LIMITS.layoutFields}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...layout, field]
                      : layout.filter((f) => f !== field);
                    set('layout', next.length > 0 ? next : undefined);
                  }}
                />
                <label htmlFor={`${id}-layout-${field}`}>{fieldLabel(t, field)}</label>
              </div>
            );
          })}
        </fieldset>

        <fieldset>
          <legend>{t('admin.workflow.transition.guards')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.guardsHint')}</p>
          <GuardTree
            guards={transition.guards}
            context={context}
            onChange={(guards) => set('guards', guards)}
          />
        </fieldset>

        <fieldset>
          <legend>{t('admin.workflow.transition.checks')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.checksHint')}</p>
          <RuleList
            kind="check"
            rules={(transition.checks ?? []) as Rule[]}
            context={context}
            emptyText={t('admin.workflow.transition.noChecks')}
            onChange={(checks) =>
              set('checks', checks.length > 0 ? (checks as unknown as CheckDef[]) : undefined)
            }
          />
        </fieldset>

        <fieldset>
          <legend>{t('admin.workflow.transition.effects')}</legend>
          <ol className="effect-order">
            <li className="effect-fixed">
              <span>
                {t('admin.workflow.effects.status', { status: names.status(transition.to) })}
              </span>
              <span className="effect-tag">{t('admin.workflow.effects.fixed')}</span>
            </li>
            {(transition.layout?.length ?? 0) > 0 && (
              <li className="effect-fixed">
                <span>{t('admin.workflow.effects.layout')}</span>
              </li>
            )}
            <li className="effect-optional">
              <div className="effect-optional-body">
                <span className="effect-optional-title">
                  {t('admin.workflow.effects.optional')}
                </span>
                <RuleList
                  kind="effect"
                  rules={(transition.effects ?? []) as Rule[]}
                  context={context}
                  emptyText={t('admin.workflow.transition.noEffects')}
                  onChange={(effects) =>
                    set(
                      'effects',
                      effects.length > 0 ? (effects as unknown as EffectDef[]) : undefined,
                    )
                  }
                />
              </div>
            </li>
            {rules.length > 0 && (
              <li className="effect-fixed">
                <span>{t('admin.workflow.effects.rules')}</span>
              </li>
            )}
            <li className="effect-fixed">
              <span>{t('admin.workflow.effects.comment')}</span>
              <span className="effect-tag">{t('admin.workflow.effects.fixed')}</span>
            </li>
            <li className="effect-fixed">
              <span>{t('admin.workflow.effects.history')}</span>
              <span className="effect-tag">{t('admin.workflow.effects.fixed')}</span>
            </li>
            <li className="effect-fixed">
              <span>{t('admin.workflow.effects.index')}</span>
              <span className="effect-tag">{t('admin.workflow.effects.fixed')}</span>
            </li>
            <li className="effect-fixed">
              <span>
                {transition.event
                  ? t('admin.workflow.effects.event', { event: transition.event })
                  : t('admin.workflow.effects.eventGeneric')}
              </span>
              <span className="effect-tag">{t('admin.workflow.effects.fixed')}</span>
            </li>
          </ol>
          <p className="form-hint">{t('admin.workflow.effects.notifications')}</p>
        </fieldset>

        <fieldset>
          <legend>{t('admin.workflow.transition.rules')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.rulesHint')}</p>
          <RuleList
            kind="rule"
            rules={rules as Rule[]}
            context={context}
            emptyText={t('admin.workflow.transition.noRules')}
            onChange={(next) => onRulesChange(next as unknown as RuleDef[])}
          />
        </fieldset>

        <fieldset>
          <legend>{t('admin.workflow.transition.properties')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.propertiesHint')}</p>
          {properties.length > 0 && (
            <ol className="rule-items">
              {properties.map(([key, val], index) => {
                const number = index + 1;
                const write = (entries: [string, string][]) =>
                  set('properties', entries.length > 0 ? Object.fromEntries(entries) : undefined);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a key being typed is not stable
                  <li key={index} className="property-row">
                    <div className="form-field">
                      <label htmlFor={`${id}-pk-${index}`}>
                        {t('admin.workflow.transition.propertyKey', { number })}
                      </label>
                      <input
                        id={`${id}-pk-${index}`}
                        type="text"
                        maxLength={255}
                        value={key}
                        aria-invalid={key === ''}
                        onChange={(e) =>
                          write(
                            properties.map(([k, v], i) =>
                              i === index ? [e.target.value, v] : [k, v],
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor={`${id}-pv-${index}`}>
                        {t('admin.workflow.transition.propertyValue', { number })}
                      </label>
                      <input
                        id={`${id}-pv-${index}`}
                        type="text"
                        maxLength={4000}
                        value={val}
                        onChange={(e) =>
                          write(
                            properties.map(([k, v], i) =>
                              i === index ? [k, e.target.value] : [k, v],
                            ),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => write(properties.filter((_, i) => i !== index))}
                    >
                      {t('admin.workflow.transition.removeProperty', { number })}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="rule-actions">
            <button
              type="button"
              className="button-secondary"
              // A new key must be unique, or it would merge with an existing one.
              disabled={properties.some(([k]) => k === '')}
              onClick={() => set('properties', { ...(transition.properties ?? {}), '': '' })}
            >
              {t('admin.workflow.transition.addProperty')}
            </button>
          </div>
        </fieldset>

        <div className="form-field">
          <label htmlFor={`${id}-event`}>{t('admin.workflow.transition.event')}</label>
          <input
            id={`${id}-event`}
            type="text"
            maxLength={100}
            spellCheck={false}
            value={transition.event ?? ''}
            aria-invalid={eventInvalid}
            aria-describedby={`${id}-event-hint`}
            onChange={(e) => set('event', e.target.value === '' ? undefined : e.target.value)}
          />
          <p id={`${id}-event-hint`} className="form-hint">
            {t('admin.workflow.transition.eventHint')}
          </p>
        </div>

        <fieldset>
          <legend>{t('admin.workflow.transition.triggers')}</legend>
          <p className="form-hint">{t('admin.workflow.transition.triggersHint')}</p>
          {triggers.length > 0 && (
            <ol className="rule-items">
              {triggers.map((trigger, index) => {
                const number = index + 1;
                const write = (next: { event: string }[]) =>
                  set('triggers', next.length > 0 ? next : undefined);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: triggers are named by position
                  <li key={index} className="property-row">
                    <div className="form-field">
                      <label htmlFor={`${id}-tr-${index}`}>
                        {t('admin.workflow.transition.trigger', { number })}
                      </label>
                      <input
                        id={`${id}-tr-${index}`}
                        type="text"
                        maxLength={200}
                        spellCheck={false}
                        value={trigger.event}
                        aria-invalid={!/^[a-z][a-z0-9.:-]{0,199}$/.test(trigger.event)}
                        onChange={(e) =>
                          write(
                            triggers.map((x, i) => (i === index ? { event: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => write(triggers.filter((_, i) => i !== index))}
                    >
                      {t('admin.workflow.transition.removeTrigger', { number })}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="rule-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={triggers.length >= LIMITS.triggers}
              onClick={() => set('triggers', [...triggers, { event: '' }])}
            >
              {t('admin.workflow.transition.addTrigger')}
            </button>
          </div>
        </fieldset>
      </div>

      <div className="workflow-danger">
        {/* Asks first, saying what will happen (D13). */}
        <DangerAction
          label={t('admin.workflow.transition.delete')}
          outcome={t('admin.workflow.transition.confirmDelete', {
            name: names.transition(transition.id),
          })}
          confirmLabel={t('admin.workflow.transition.deleteNamed', {
            name: names.transition(transition.id),
          })}
          onConfirm={onDelete}
        />
      </div>
    </section>
  );
}
