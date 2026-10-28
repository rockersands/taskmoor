import { useEffect, useId, useRef, useState } from 'react';
import { type Translate, useT } from '../i18n/I18nProvider';
import {
  type AnyParamSpec,
  addableTypes,
  blankRule,
  entryOf,
  fieldsOf,
  idsFromText,
  OP_LABELS,
  OPS,
  type RuleDefaults,
  type RuleKind,
  SYSTEM_FIELDS,
  valueFromText,
  valueToText,
} from './catalogue';
import type { Lookups } from './client';
import { type GuardNode, LIMITS, type Status } from './definition';
import { ruleTypeLabel } from './describe';
import { fieldLabel } from './refusal';

/** What the forms' pickers offer: the workspace's statuses, the workflow's transitions, names. */
export interface PickerContext {
  statuses: readonly Status[];
  transitions: readonly { id: number; name: string }[];
  lookups: Lookups;
}

type Rule = { type: string } & Record<string, unknown>;

const value = (t: Translate, text: string) => t('common.value', { value: text });

/** First choices for a new rule's pickers, from what the workspace and workflow hold. */
export function defaultsFrom(context: PickerContext): RuleDefaults {
  const first = <T,>(list: readonly T[] | null | undefined) => list?.[0];
  const status = first(context.statuses);
  const transition = first(context.transitions);
  const role = first(context.lookups.roles);
  const group = first(context.lookups.groups);
  return {
    ...(status ? { status: String(status.id) } : {}),
    ...(transition ? { transition: String(transition.id) } : {}),
    ...(role ? { role: String(role.id) } : {}),
    ...(group ? { group: String(group.id) } : {}),
  };
}

interface Option {
  value: string;
  label: string;
}

/** A select that always shows the stored value, even one this client does not offer. */
function SelectField({
  id,
  label,
  value: current,
  options,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  hint?: string | undefined;
}) {
  const t = useT();
  const known = options.some((o) => o.value === current);
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={current}
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-invalid={current === ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {current === '' && <option value="">{t('admin.workflow.rule.choose')}</option>}
        {!known && current !== '' && <option value={current}>{value(t, current)}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="form-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Checkboxes for a list of ids; ids this client does not know stay listed and ticked. */
function CheckboxList({
  legend,
  options,
  values,
  onChange,
}: {
  legend: string;
  options: Option[];
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const t = useT();
  const id = useId();
  const extra = values.filter((v) => !options.some((o) => o.value === v));
  const all = [...options, ...extra.map((v) => ({ value: v, label: value(t, v) }))];
  return (
    <fieldset className="rule-choices">
      <legend>{legend}</legend>
      {all.map((o) => (
        <div key={o.value} className="form-field form-field-inline">
          <input
            id={`${id}-${o.value}`}
            type="checkbox"
            checked={values.includes(o.value)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value),
              )
            }
          />
          <label htmlFor={`${id}-${o.value}`}>{o.label}</label>
        </div>
      ))}
    </fieldset>
  );
}

/**
 * A text box for a value stored in another form (a number, JSON, a list of ids). It keeps what
 * is typed while it does not read yet, and follows the stored value when it changes elsewhere.
 */
function ParsedField({
  id,
  label,
  stored,
  format,
  parse,
  onChange,
  hint,
  inputMode,
}: {
  id: string;
  label: string;
  stored: unknown;
  format: (value: unknown) => string;
  parse: (text: string) => { ok: true; value: unknown } | { ok: false };
  onChange: (value: unknown) => void;
  hint?: string | undefined;
  inputMode?: 'decimal' | 'numeric' | 'text' | undefined;
}) {
  const t = useT();
  const [text, setText] = useState(() => format(stored));
  const [invalid, setInvalid] = useState(false);
  // The value this box last read or showed: a stored value that differs came from elsewhere.
  const shown = useRef(JSON.stringify(stored));
  useEffect(() => {
    const next = JSON.stringify(stored);
    if (next === shown.current) return;
    shown.current = next;
    setText(format(stored));
    setInvalid(false);
  }, [stored, format]);
  const describedBy = [hint ? `${id}-hint` : '', invalid ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        value={text}
        aria-invalid={invalid}
        aria-describedby={describedBy || undefined}
        onChange={(event) => {
          setText(event.target.value);
          const read = parse(event.target.value);
          setInvalid(!read.ok);
          if (read.ok) {
            shown.current = JSON.stringify(read.value);
            onChange(read.value);
          }
        }}
      />
      {hint && (
        <p id={`${id}-hint`} className="form-hint">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={`${id}-error`} className="form-hint rule-invalid">
          {t('admin.workflow.rule.invalid')}
        </p>
      )}
    </div>
  );
}

const numberText = (v: unknown) => (typeof v === 'number' ? String(v) : '');
const parseNumber = (text: string) => {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(n)
    ? { ok: true as const, value: n }
    : { ok: false as const };
};
const parseInteger = (min: number, max: number) => (text: string) => {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
    ? { ok: true as const, value: n }
    : { ok: false as const };
};
const parseValue = (text: string) => ({ ok: true as const, value: valueFromText(text) });
const idsText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const parseIds = (text: string) => {
  const ids = idsFromText(text);
  return ids.every((x) => /^[1-9][0-9]{0,9}$/.test(x))
    ? { ok: true as const, value: ids }
    : { ok: false as const };
};
const levelsText = (v: unknown) => JSON.stringify(v ?? {});
const parseLevels = (text: string) => {
  try {
    const read = JSON.parse(text) as unknown;
    if (
      read &&
      typeof read === 'object' &&
      !Array.isArray(read) &&
      Object.values(read).every((x) => typeof x === 'string')
    ) {
      return { ok: true as const, value: read };
    }
  } catch {
    // Falls through: not JSON.
  }
  return { ok: false as const };
};

/** The parameters of one guard, check, effect or rule, as a form built from the catalogue. */
export function RuleFields({
  kind,
  rule,
  onChange,
  context,
}: {
  kind: RuleKind;
  rule: Rule;
  onChange: (rule: Rule) => void;
  context: PickerContext;
}) {
  const t = useT();
  const id = useId();
  const entry = entryOf(kind, rule.type);
  if (!entry) return null;
  const set = (name: string, next: unknown, optional = false) => {
    const copy: Rule = { ...rule };
    if (
      optional &&
      (next === undefined ||
        next === false ||
        (Array.isArray(next) && next.length === 0) ||
        next === '')
    ) {
      delete copy[name];
    } else {
      copy[name] = next;
    }
    onChange(copy);
  };
  const statusOptions = context.statuses.map((s) => ({
    value: String(s.id),
    label: value(t, s.name),
  }));
  const named = (list: readonly { id: number; name: string }[] | null) =>
    list?.map((x) => ({ value: String(x.id), label: value(t, x.name) })) ?? null;

  const control = (name: string, spec: AnyParamSpec) => {
    const key = `${id}-${name}`;
    const label = t(spec.labelId);
    const hint = spec.hintId ? t(spec.hintId) : undefined;
    const stored = rule[name];
    const text = typeof stored === 'string' ? stored : '';
    const optional = spec.optional === true;
    switch (spec.kind) {
      case 'field': {
        const names = fieldsOf(spec.fields);
        return (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={names.map((f) => ({ value: f, label: fieldLabel(t, f) }))}
            onChange={(v) => set(name, v)}
          />
        );
      }
      case 'systemField':
        return (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={SYSTEM_FIELDS.map((f) => ({ value: f, label: fieldLabel(t, f) }))}
            onChange={(v) => set(name, v)}
          />
        );
      case 'op':
        return (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={OPS.map((o) => ({ value: o, label: t(OP_LABELS[o]) }))}
            onChange={(v) => set(name, v)}
          />
        );
      case 'status':
        return (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={statusOptions}
            onChange={(v) => set(name, v)}
          />
        );
      case 'transition':
        return (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={context.transitions.map((x) => ({
              value: String(x.id),
              label: value(t, x.name),
            }))}
            onChange={(v) => set(name, v)}
          />
        );
      case 'role':
      case 'group': {
        const options = named(
          spec.kind === 'role' ? context.lookups.roles : context.lookups.groups,
        );
        return options ? (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={options}
            onChange={(v) => set(name, v)}
          />
        ) : (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored}
            format={(v) => (typeof v === 'string' ? v : '')}
            parse={(s) =>
              /^[1-9][0-9]{0,9}$/.test(s.trim()) ? { ok: true, value: s.trim() } : { ok: false }
            }
            inputMode="numeric"
            onChange={(v) => set(name, v)}
          />
        );
      }
      case 'permission': {
        const permissions = context.lookups.permissions;
        return permissions ? (
          <SelectField
            key={name}
            id={key}
            label={label}
            value={text}
            options={permissions.map((p) => ({ value: p, label: value(t, p) }))}
            onChange={(v) => set(name, v)}
          />
        ) : (
          <div key={name} className="form-field">
            <label htmlFor={key}>{label}</label>
            <input id={key} type="text" value={text} onChange={(e) => set(name, e.target.value)} />
          </div>
        );
      }
      case 'statuses':
        return (
          <CheckboxList
            key={name}
            legend={label}
            options={statusOptions}
            values={Array.isArray(stored) ? (stored as string[]) : []}
            onChange={(v) => set(name, v, optional)}
          />
        );
      case 'roles':
      case 'groups': {
        const options = named(
          spec.kind === 'roles' ? context.lookups.roles : context.lookups.groups,
        );
        return options ? (
          <CheckboxList
            key={name}
            legend={label}
            options={options}
            values={Array.isArray(stored) ? (stored as string[]) : []}
            onChange={(v) => set(name, v, optional)}
          />
        ) : (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored ?? []}
            format={idsText}
            parse={parseIds}
            hint={t('admin.workflow.rule.idsHint')}
            onChange={(v) => set(name, v, optional)}
          />
        );
      }
      case 'users':
        return (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored ?? []}
            format={idsText}
            parse={parseIds}
            hint={t('admin.workflow.rule.idsHint')}
            onChange={(v) => set(name, v, optional)}
          />
        );
      case 'boolean':
        return (
          <div key={name} className="form-field form-field-inline">
            <input
              id={key}
              type="checkbox"
              checked={stored === true}
              onChange={(e) => set(name, e.target.checked, optional)}
            />
            <label htmlFor={key}>{label}</label>
          </div>
        );
      case 'number':
        return (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored}
            format={numberText}
            parse={parseNumber}
            inputMode="decimal"
            onChange={(v) => set(name, v)}
          />
        );
      case 'integer':
        return (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored}
            format={numberText}
            parse={parseInteger(spec.min, spec.max)}
            inputMode="numeric"
            onChange={(v) => set(name, v)}
          />
        );
      case 'value':
        return (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored}
            format={valueToText}
            parse={parseValue}
            hint={hint}
            onChange={(v) => set(name, v)}
          />
        );
      case 'levels':
        return (
          <ParsedField
            key={name}
            id={key}
            label={label}
            stored={stored}
            format={levelsText}
            parse={parseLevels}
            hint={hint}
            onChange={(v) => set(name, v)}
          />
        );
      case 'assignTarget':
        return (
          <AssignTarget key={name} label={label} stored={stored} onChange={(v) => set(name, v)} />
        );
      case 'url':
        return (
          <div key={name} className="form-field">
            <label htmlFor={key}>{label}</label>
            <input
              id={key}
              type="url"
              value={text}
              aria-invalid={!/^https?:\/\/\S+/.test(text)}
              onChange={(e) => set(name, e.target.value)}
            />
          </div>
        );
      case 'readonly':
        return (
          <div key={name} className="form-field">
            <label htmlFor={key}>{label}</label>
            <input id={key} type="text" value={text} readOnly />
          </div>
        );
      default:
        // text and pattern
        return (
          <div key={name} className="form-field">
            <label htmlFor={key}>{label}</label>
            <input
              id={key}
              type="text"
              value={text}
              spellCheck={false}
              aria-invalid={text === ''}
              onChange={(e) => set(name, e.target.value)}
            />
          </div>
        );
    }
  };

  return (
    <>
      {Object.entries(entry.params).map(([name, spec]) => control(name, spec))}
      {kind === 'check' && (
        <div className="form-field">
          <label htmlFor={`${id}-message`}>{t('admin.workflow.rule.message')}</label>
          <input
            id={`${id}-message`}
            type="text"
            maxLength={500}
            value={typeof rule.message === 'string' ? rule.message : ''}
            aria-describedby={`${id}-message-hint`}
            onChange={(e) => set('message', e.target.value, true)}
          />
          <p id={`${id}-message-hint`} className="form-hint">
            {t('admin.workflow.rule.messageHint')}
          </p>
        </div>
      )}
    </>
  );
}

/** Who a local-mode assign rule assigns: the person running it, the requester or someone. */
function AssignTarget({
  label,
  stored,
  onChange,
}: {
  label: string;
  stored: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const mode =
    stored === 'requester'
      ? 'requester'
      : stored && typeof stored === 'object'
        ? 'user'
        : 'current-user';
  const user =
    stored && typeof stored === 'object' && 'user' in stored ? String(stored.user ?? '') : '';
  const choices = [
    ['current-user', 'workflow.assignTo.currentUser'],
    ['requester', 'workflow.assignTo.requester'],
    ['user', 'workflow.assignTo.user'],
  ] as const;
  return (
    <fieldset className="rule-choices">
      <legend>{label}</legend>
      {choices.map(([choice, labelId]) => (
        <div key={choice} className="form-field form-field-inline">
          <input
            id={`${id}-${choice}`}
            type="radio"
            name={`${id}-to`}
            checked={mode === choice}
            onChange={() => onChange(choice === 'user' ? { user } : choice)}
          />
          <label htmlFor={`${id}-${choice}`}>{t(labelId)}</label>
        </div>
      ))}
      {mode === 'user' && (
        <ParsedField
          id={`${id}-user`}
          label={t('workflow.assignTo.userId')}
          stored={user}
          format={(v) => (typeof v === 'string' ? v : '')}
          parse={(s) =>
            /^[1-9][0-9]{0,9}$/.test(s.trim()) ? { ok: true, value: s.trim() } : { ok: false }
          }
          inputMode="numeric"
          onChange={(v) => onChange({ user: v })}
        />
      )}
    </fieldset>
  );
}

/** Moves an item of a list by one place. */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...list];
  const target = index + by;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}

/** One rule in a list: its form and the buttons that move or remove it. */
function RuleItem({
  kind,
  number,
  rule,
  first,
  last,
  context,
  onChange,
  onMove,
  onRemove,
}: {
  kind: RuleKind;
  number: string;
  rule: Rule;
  first: boolean;
  last: boolean;
  context: PickerContext;
  onChange: (rule: Rule) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <li className="rule-item">
      <fieldset className="rule-fields">
        <legend>
          {t('admin.workflow.rule.legend', {
            kind,
            number,
            type: ruleTypeLabel(t, kind, rule.type),
          })}
        </legend>
        <RuleFields kind={kind} rule={rule} onChange={onChange} context={context} />
      </fieldset>
      <ItemActions
        kind={kind}
        number={number}
        first={first}
        last={last}
        onMove={onMove}
        onRemove={onRemove}
      />
    </li>
  );
}

function ItemActions({
  kind,
  number,
  first,
  last,
  onMove,
  onRemove,
  removeLabel,
}: {
  kind: RuleKind;
  number: string;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  const t = useT();
  return (
    <div className="rule-actions">
      {!first && (
        <button
          type="button"
          className="button-secondary"
          aria-label={t('admin.workflow.rule.moveUp', { kind, number })}
          onClick={() => onMove(-1)}
        >
          {t('admin.workflow.rule.up')}
        </button>
      )}
      {!last && (
        <button
          type="button"
          className="button-secondary"
          aria-label={t('admin.workflow.rule.moveDown', { kind, number })}
          onClick={() => onMove(1)}
        >
          {t('admin.workflow.rule.down')}
        </button>
      )}
      <button
        type="button"
        className="button-secondary"
        aria-label={removeLabel ?? t('admin.workflow.rule.remove', { kind, number })}
        onClick={onRemove}
      >
        {t('admin.workflow.rule.removeShort')}
      </button>
    </div>
  );
}

/** A type picker and an Add button for a new guard, check, effect or rule. */
export function AddRule({
  kind,
  onAdd,
  disabled = false,
}: {
  kind: RuleKind;
  onAdd: (type: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const types = addableTypes(kind);
  const [type, setType] = useState(types[0] ?? '');
  return (
    <div className="rule-add">
      <div className="form-field">
        <label htmlFor={id}>{t('admin.workflow.rule.add', { kind })}</label>
        <select id={id} value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((x) => (
            <option key={x} value={x}>
              {ruleTypeLabel(t, kind, x)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="button-secondary"
        disabled={disabled}
        onClick={() => onAdd(type)}
      >
        {t('admin.workflow.rule.addButton', { kind })}
      </button>
    </div>
  );
}

/** A list of checks, effects or rules, in the order they run, with their forms. */
export function RuleList({
  kind,
  rules,
  onChange,
  context,
  emptyText,
}: {
  kind: Exclude<RuleKind, 'guard'>;
  rules: readonly Rule[];
  onChange: (rules: Rule[]) => void;
  context: PickerContext;
  emptyText: string;
}) {
  return (
    <div className="rule-list">
      {rules.length === 0 ? (
        <p className="form-hint">{emptyText}</p>
      ) : (
        <ol className="rule-items">
          {rules.map((rule, index) => (
            <RuleItem
              // Rules have no id; the position is what names them.
              // biome-ignore lint/suspicious/noArrayIndexKey: items are named by position
              key={index}
              kind={kind}
              number={String(index + 1)}
              rule={rule}
              first={index === 0}
              last={index === rules.length - 1}
              context={context}
              onChange={(next) => onChange(rules.map((r, i) => (i === index ? next : r)))}
              onMove={(by) => onChange(moved(rules, index, by))}
              onRemove={() => onChange(rules.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      )}
      <AddRule
        kind={kind}
        disabled={rules.length >= LIMITS.rulesPerList}
        onAdd={(type) => onChange([...rules, blankRule(kind, type, defaultsFrom(context)) as Rule])}
      />
    </div>
  );
}

type Group = { all: GuardNode[] } | { any: GuardNode[] };
const isGroup = (node: GuardNode): node is Group => 'all' in node || 'any' in node;
const modeOf = (group: Group): 'all' | 'any' => ('all' in group ? 'all' : 'any');
const childrenOf = (group: Group): GuardNode[] => ('all' in group ? group.all : group.any);
const groupOf = (mode: 'all' | 'any', children: GuardNode[]): Group =>
  mode === 'all' ? { all: children } : { any: children };

/**
 * A transition's guards as a tree of all/any groups (WF-003). A lone guard at the root shows
 * as a group of one and becomes one only when something changes; an emptied root clears the
 * guards.
 */
export function GuardTree({
  guards,
  onChange,
  context,
}: {
  guards: GuardNode | undefined;
  onChange: (guards: GuardNode | undefined) => void;
  context: PickerContext;
}) {
  const t = useT();
  const root: Group | null = guards ? (isGroup(guards) ? guards : { all: [guards] }) : null;
  if (!root) {
    return (
      <div className="rule-list">
        <p className="form-hint">{t('admin.workflow.transition.noGuards')}</p>
        <div className="rule-actions">
          <AddRule
            kind="guard"
            onAdd={(type) =>
              onChange({ all: [blankRule('guard', type, defaultsFrom(context)) as GuardNode] })
            }
          />
        </div>
      </div>
    );
  }
  return (
    <GuardGroup
      group={root}
      depth={1}
      number=""
      context={context}
      onChange={(next) => onChange(next && childrenOf(next).length > 0 ? next : undefined)}
    />
  );
}

function GuardGroup({
  group,
  depth,
  number,
  context,
  onChange,
}: {
  group: Group;
  depth: number;
  /** The group's place, "" for the root, "2" or "2.1" for nested groups. */
  number: string;
  context: PickerContext;
  onChange: (group: Group) => void;
}) {
  const t = useT();
  const id = useId();
  const mode = modeOf(group);
  const children = childrenOf(group);
  const set = (next: GuardNode[]) => onChange(groupOf(mode, next));
  const place = (index: number) => (number ? `${number}.${index + 1}` : String(index + 1));
  // The server refuses guards nested deeper than ten: a group here holds guards one deeper.
  const canNest = depth + 2 <= LIMITS.guardDepth;
  return (
    <div className="guard-group">
      <div className="form-field guard-combine">
        <label htmlFor={`${id}-mode`}>{t('admin.workflow.guard.combine')}</label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) => onChange(groupOf(e.target.value === 'any' ? 'any' : 'all', children))}
        >
          <option value="all">{t('admin.workflow.guard.all')}</option>
          <option value="any">{t('admin.workflow.guard.any')}</option>
        </select>
      </div>
      <ol className="rule-items">
        {children.map((child, index) => {
          const n = place(index);
          const first = index === 0;
          const last = index === children.length - 1;
          const replace = (next: GuardNode) =>
            set(children.map((c, i) => (i === index ? next : c)));
          const move = (by: -1 | 1) => set(moved(children, index, by));
          const remove = () => set(children.filter((_, i) => i !== index));
          if (isGroup(child)) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: guards are named by position
              <li key={index} className="rule-item guard-nested">
                <fieldset className="rule-fields">
                  <legend>
                    {t('admin.workflow.guard.group', { number: n, mode: modeOf(child) })}
                  </legend>
                  <GuardGroup
                    group={child}
                    depth={depth + 1}
                    number={n}
                    context={context}
                    onChange={(next) => replace(next)}
                  />
                </fieldset>
                <ItemActions
                  kind="guard"
                  number={n}
                  first={first}
                  last={last}
                  onMove={move}
                  onRemove={remove}
                  removeLabel={t('admin.workflow.guard.removeGroup', { number: n })}
                />
              </li>
            );
          }
          return (
            <RuleItem
              // biome-ignore lint/suspicious/noArrayIndexKey: guards are named by position
              key={index}
              kind="guard"
              number={n}
              rule={child as Rule}
              first={first}
              last={last}
              context={context}
              onChange={(next) => replace(next as unknown as GuardNode)}
              onMove={move}
              onRemove={remove}
            />
          );
        })}
      </ol>
      <div className="rule-actions">
        <AddRule
          kind="guard"
          disabled={children.length >= LIMITS.groupChildren}
          onAdd={(type) =>
            set([...children, blankRule('guard', type, defaultsFrom(context)) as GuardNode])
          }
        />
        <button
          type="button"
          className="button-secondary"
          disabled={!canNest || children.length >= LIMITS.groupChildren}
          aria-describedby={canNest ? undefined : `${id}-depth`}
          onClick={() => set([...children, { any: [] }])}
        >
          {t('admin.workflow.guard.addGroup')}
        </button>
        {!canNest && (
          <p id={`${id}-depth`} className="form-hint">
            {t('admin.workflow.guard.depthLimit')}
          </p>
        )}
      </div>
    </div>
  );
}
