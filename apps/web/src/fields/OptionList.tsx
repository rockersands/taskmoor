import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
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
 * and their own New child option.
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
    onDelete: (option: ChildOption) =>
      client.deleteOption(field.id, context.id, option.id).then(() => {
        void reload();
        onChanged(t('admin.fields.optionDeleted', { value: option.value }));
      }, onProblem),
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
      <h4 id={headingId} className="facts-title">
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
              moved={moved}
              onSeen={() => setMoved(null)}
              {...bind(top, option)}
            >
              {cascade && (
                <ChildOptions
                  parent={option}
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
  onDelete: (option: ChildOption) => unknown;
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
  defaultIds,
  moved,
  onSeen,
  bound,
  onAdd,
}: {
  parent: ChildOption & { children?: ChildOption[] };
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
  moved,
  onSeen,
  onRename,
  onToggle,
  onDelete,
  onMove,
  children,
}: {
  option: ChildOption;
  first: boolean;
  last: boolean;
  isDefault: boolean;
  moved: Moved;
  /** The move was drawn and the keyboard put back: no later change moves it again. */
  onSeen: () => void;
  onRename: (value: string) => void;
  onToggle: () => void;
  onDelete: () => void;
  onMove: (up: boolean) => void;
  children?: ReactNode;
}) {
  const t = useT();
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
        <button
          type="button"
          className="button-secondary people-action"
          aria-label={t('admin.fields.optionDeleteOf', { value: option.value })}
          onClick={onDelete}
        >
          {t('admin.fields.optionDelete')}
        </button>
      </span>
      {children}
    </li>
  );
}
