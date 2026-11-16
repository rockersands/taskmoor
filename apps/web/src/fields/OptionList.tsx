import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import type { ChildOption, Field, FieldContext, FieldsClient } from './client';

export interface OptionListProps {
  field: Field;
  context: FieldContext;
  client: FieldsClient;
  /** The field as the server answered a change. */
  onField: (field: Field) => void;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
  /** The options the context's default names, to mark them. */
  defaultIds?: readonly number[];
}

/** Where focus goes once a move is drawn: the moved option's Up or Down button. */
type Moved = { id: number; up: boolean } | null;

/**
 * The options of one context (CORE-009 (3); T-320): add, rename, stop offering or offer again,
 * delete one no ticket holds, and move up or down (`PUT .../options/order` with every option at
 * that level). Under each option of a two-level list, its child options, with the same actions
 * and their own New child option. Delete asks first only when it takes more than the option (D13,
 * T-267): its child options, or the context's default. A plain option goes at once, since typing
 * its name brings it back; one a ticket holds is refused either way. Once the row is gone, the
 * list's heading takes the keyboard.
 */
export function OptionList({
  field,
  context,
  client,
  onField,
  onChanged,
  onProblem,
  defaultIds = [],
}: OptionListProps) {
  const t = useT();
  const headingId = useId();
  const [moved, setMoved] = useState<Moved>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // A deleted option's row goes with the focus its question held: the heading takes it.
  const [deleted, setDeleted] = useState(0);
  useEffect(() => {
    if (deleted > 0) heading.current?.focus();
  }, [deleted]);
  const options = context.options ?? [];
  const cascade = field.type === 'cascading-select';
  const reload = () => client.field(field.id).then(onField, onProblem);
  /** A refused add keeps what was typed. */
  const refused = (error: unknown) => {
    onProblem(error);
    return false;
  };

  const actions = (parentId: number | null, siblings: readonly ChildOption[]): Bound => ({
    onRename: (option: ChildOption, wanted: string) =>
      client.updateOption(field.id, context.id, option.id, { value: wanted }).then((saved) => {
        onField(saved);
        onChanged(t('admin.fields.optionRenamed', { value: wanted }));
      }, onProblem),
    onToggle: (option: ChildOption) =>
      client
        .updateOption(field.id, context.id, option.id, { disabled: !option.disabled })
        .then((saved) => {
          onField(saved);
          onChanged(
            t(option.disabled ? 'admin.fields.optionEnabled' : 'admin.fields.optionDisabled', {
              value: option.value,
            }),
          );
        }, onProblem),
    onDelete: async (option: ChildOption) => {
      try {
        await client.deleteOption(field.id, context.id, option.id);
      } catch (error) {
        // Refused: the question stays open to try again or cancel.
        onProblem(error);
        throw error;
      }
      onChanged(t('admin.fields.optionDeleted', { value: option.value }));
      await reload();
      setDeleted((n) => n + 1);
    },
    onMove: (option: ChildOption, up: boolean) => {
      const ids = siblings.map((o) => o.id);
      const from = ids.indexOf(option.id);
      const to = up ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= ids.length) return;
      ids.splice(from, 1);
      ids.splice(to, 0, option.id);
      client.orderOptions(field.id, context.id, parentId, ids).then((saved) => {
        onField(saved);
        setMoved({ id: option.id, up });
        onChanged(t('admin.fields.optionMoved', { value: option.value }));
      }, onProblem);
    },
  });
  const top = actions(null, options);

  return (
    <section aria-labelledby={headingId} className="people-panel">
      <h4 id={headingId} ref={heading} tabIndex={-1} className="facts-title">
        {t('admin.fields.optionsOf', { context: context.name })}
      </h4>
      {options.length === 0 ? (
        <EmptyState compact title={t('admin.fields.noOptions')} />
      ) : (
        <ul className="people-sublist">
          {options.map((option, index) => (
            <OptionRow
              key={option.id}
              option={option}
              first={index === 0}
              last={index === options.length - 1}
              isDefault={defaultIds.includes(option.id)}
              takesDefault={[option, ...(option.children ?? [])].some((o) =>
                defaultIds.includes(o.id),
              )}
              context={context.name}
              moved={moved}
              onSeen={() => setMoved(null)}
              {...bind(top, option)}
            >
              {cascade && (
                <ChildOptions
                  parent={option}
                  context={context.name}
                  defaultIds={defaultIds}
                  moved={moved}
                  onSeen={() => setMoved(null)}
                  bound={actions(option.id, option.children ?? [])}
                  onAdd={(value) =>
                    client.addOption(field.id, context.id, value, option.id).then((saved) => {
                      onField(saved);
                      onChanged(t('admin.fields.childAdded', { value, parent: option.value }));
                      return true;
                    }, refused)
                  }
                />
              )}
            </OptionRow>
          ))}
        </ul>
      )}
      <AddOptionForm
        label={t('admin.fields.addOptionTo', { context: context.name })}
        inputLabel={t('admin.fields.newOption')}
        button={t('admin.fields.addOption')}
        onAdd={(value) =>
          client.addOption(field.id, context.id, value).then((saved) => {
            onField(saved);
            onChanged(t('admin.fields.optionAdded', { value }));
            return true;
          }, refused)
        }
      />
    </section>
  );
}

/** What each option of one level can do, by option. */
interface Bound {
  onRename: (option: ChildOption, wanted: string) => unknown;
  onToggle: (option: ChildOption) => unknown;
  onDelete: (option: ChildOption) => Promise<void>;
  onMove: (option: ChildOption, up: boolean) => unknown;
}
const bind = (actions: Bound, option: ChildOption) => ({
  onRename: (wanted: string) => actions.onRename(option, wanted),
  onToggle: () => actions.onToggle(option),
  onDelete: () => actions.onDelete(option),
  onMove: (up: boolean) => actions.onMove(option, up),
});

/** The child options of one option of a two-level list, and a form to add one. */
function ChildOptions({
  parent,
  context,
  defaultIds,
  moved,
  onSeen,
  bound,
  onAdd,
}: {
  parent: ChildOption & { children?: ChildOption[] };
  /** The context's name, for a delete's question. */
  context: string;
  defaultIds: readonly number[];
  moved: Moved;
  onSeen: () => void;
  bound: Bound;
  onAdd: (value: string) => Promise<boolean>;
}) {
  const t = useT();
  const children = parent.children ?? [];
  return (
    <div className="people-panel">
      {children.length === 0 ? (
        <EmptyState compact title={t('admin.fields.noChildOptions', { parent: parent.value })} />
      ) : (
        <ul
          className="people-sublist"
          aria-label={t('admin.fields.childOptionsOf', { parent: parent.value })}
        >
          {children.map((child, index) => (
            <OptionRow
              key={child.id}
              option={child}
              first={index === 0}
              last={index === children.length - 1}
              isDefault={defaultIds.includes(child.id)}
              takesDefault={defaultIds.includes(child.id)}
              context={context}
              moved={moved}
              onSeen={onSeen}
              {...bind(bound, child)}
            />
          ))}
        </ul>
      )}
      <AddOptionForm
        label={t('admin.fields.addChildTo', { parent: parent.value })}
        inputLabel={t('admin.fields.newChildOption')}
        button={t('admin.fields.addChild')}
        onAdd={onAdd}
      />
    </div>
  );
}

function AddOptionForm({
  label,
  inputLabel,
  button,
  onAdd,
}: {
  label: string;
  inputLabel: string;
  button: string;
  onAdd: (value: string) => Promise<boolean>;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <form
      className="people-inline"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = value.trim();
        if (!wanted) return;
        void onAdd(wanted).then((added) => added && setValue(''));
      }}
    >
      <div className="form-field">
        <label htmlFor={id} className="form-label">
          {inputLabel}
        </label>
        <input
          id={id}
          type="text"
          required
          maxLength={255}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <button type="submit" className="button-secondary">
        {button}
      </button>
    </form>
  );
}

function OptionRow({
  option,
  first,
  last,
  isDefault,
  takesDefault,
  context,
  moved,
  onSeen,
  onRename,
  onToggle,
  onDelete,
  onMove,
  children,
}: {
  option: ChildOption & { children?: ChildOption[] };
  first: boolean;
  last: boolean;
  /** Marked as the default: the context's default names it. */
  isDefault: boolean;
  /** Deleting it leaves the context with no default: the default names it or a child of it. */
  takesDefault: boolean;
  /** The context's name, for the question. */
  context: string;
  moved: Moved;
  /** The move was drawn and the keyboard put back: no later change moves it again. */
  onSeen: () => void;
  onRename: (value: string) => void;
  onToggle: () => void;
  /** Rejects when the server refuses, so the question stays open. */
  onDelete: () => Promise<void>;
  onMove: (up: boolean) => void;
  children?: ReactNode;
}) {
  const t = useT();
  const childCount = option.children?.length ?? 0;
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(option.value);
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);

  // A moved option keeps the keyboard on its button, or the other one at the end of the list.
  useEffect(() => {
    if (moved?.id !== option.id) return;
    const wanted = moved.up ? (first ? down : up) : last ? up : down;
    wanted.current?.focus();
    onSeen();
  }, [moved, option.id, first, last, onSeen]);

  if (editing) {
    return (
      <li>
        <label htmlFor={inputId} className="visually-hidden">
          {t('admin.fields.optionValueOf', { value: option.value })}
        </label>
        <input
          id={inputId}
          type="text"
          maxLength={255}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="people-actions">
          <button
            type="button"
            className="button-secondary people-action"
            onClick={() => {
              const wanted = value.trim();
              if (wanted && wanted !== option.value) onRename(wanted);
              setEditing(false);
            }}
          >
            {t('admin.fields.optionSave')}
          </button>
          <button
            type="button"
            className="button-secondary people-action"
            onClick={() => {
              setValue(option.value);
              setEditing(false);
            }}
          >
            {t('admin.fields.optionCancel')}
          </button>
        </span>
        {children}
      </li>
    );
  }
  return (
    <li>
      <span className="people-sublist-row">
        {option.value}
        {isDefault && <span className="people-badge">{t('admin.fields.defaultBadge')}</span>}
        {option.disabled && (
          <span className="people-badge">{t('admin.fields.optionDisabledBadge')}</span>
        )}
      </span>
      <span className="people-actions">
        <button
          ref={up}
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.fields.optionUpOf', { value: option.value })}
          disabled={first}
          onClick={() => onMove(true)}
        >
          {t('admin.fields.optionUp')}
        </button>
        <button
          ref={down}
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.fields.optionDownOf', { value: option.value })}
          disabled={last}
          onClick={() => onMove(false)}
        >
          {t('admin.fields.optionDown')}
        </button>
        <button
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.fields.optionRenameOf', { value: option.value })}
          onClick={() => setEditing(true)}
        >
          {t('admin.fields.optionRename')}
        </button>
        <button
          type="button"
          className="button-secondary people-action"
          aria-label={t(
            option.disabled ? 'admin.fields.optionEnableOf' : 'admin.fields.optionDisableOf',
            { value: option.value },
          )}
          onClick={onToggle}
        >
          {t(option.disabled ? 'admin.fields.optionEnable' : 'admin.fields.optionDisable')}
        </button>
        {/* Asks first only when its child options or the default go with it (D13, T-267); a
            refusal keeps the question open. A plain option goes at once. */}
        {childCount > 0 || takesDefault ? (
          <DangerAction
            label={t('admin.fields.optionDelete')}
            name={t('admin.fields.optionDeleteOf', { value: option.value })}
            outcome={t('admin.fields.optionDeleteOutcome', {
              value: option.value,
              children: childCount,
              isDefault: takesDefault ? 'yes' : 'no',
              context,
            })}
            confirmLabel={t('admin.fields.optionDeleteOf', { value: option.value })}
            onConfirm={onDelete}
          />
        ) : (
          <button
            type="button"
            className="button-secondary people-action"
            aria-label={t('admin.fields.optionDeleteOf', { value: option.value })}
            onClick={() => void onDelete().catch(() => {})}
          >
            {t('admin.fields.optionDelete')}
          </button>
        )}
      </span>
      {children}
    </li>
  );
}
