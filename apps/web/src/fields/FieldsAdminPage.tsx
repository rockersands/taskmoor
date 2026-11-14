import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  FIELD_TYPES,
  type Field,
  type FieldContext,
  type FieldOption,
  type FieldsClient,
  type FieldType,
  fieldsClient,
  MULTIPLE_TYPES,
  OPTION_TYPES,
} from './client';

export interface FieldsAdminPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: FieldsClient;
}

/**
 * Custom fields (CORE-003, CORE-009), for administrators: add a field of any type but formula,
 * rename it, keep the options of each of its contexts (add, rename, disable, delete one no
 * ticket uses) and delete a field no ticket holds a value of. Where a context applies, and
 * formulas, are set through the API for now.
 */
export function FieldsAdminPage({ client = fieldsClient }: FieldsAdminPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const nameId = useId();
  const typeId = useId();
  const multipleId = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; fields: Field[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const creating = useNewForm();
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [multiple, setMultiple] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', fields: await client.fields() });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const refusal = useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError)) return t('admin.fields.problem.other');
      const body = error.body as {
        error?: string;
        ticketCount?: number;
        fields?: { name: string }[];
      } | null;
      if (body?.error === 'in_use') {
        return t('admin.fields.problem.inUse', { tickets: body.ticketCount ?? 0 });
      }
      if (body?.error === 'used_by_formula') {
        return t('admin.fields.problem.formula', {
          fields: (body.fields ?? []).map((f) => f.name).join(', '),
        });
      }
      if (body?.error === 'name_taken') return t('admin.fields.problem.nameTaken');
      if (body?.error === 'value_taken') return t('admin.fields.problem.valueTaken');
      if (error.status === 403) return t('admin.fields.problem.forbidden');
      return t('admin.fields.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };
  const typeName = (of: FieldType) => t(`admin.fields.type.${of}` as MessageId);

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.fields.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('settings.fieldsHint'),
              about: t('admin.fields.intro'),
              actions: (
                <NewButton
                  label={t('admin.fields.new')}
                  open={creating.open}
                  onToggle={creating.toggle}
                  ref={creating.button}
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.fields.forbidden')}</p>
      ) : (
        <>
          {creating.open && (
            <form
              className="glass-card people-card people-form"
              aria-label={t('admin.fields.add')}
              onSubmit={(event) => {
                event.preventDefault();
                const wanted = name.trim();
                if (!wanted) return;
                client
                  .createField({
                    name: wanted,
                    type,
                    ...(MULTIPLE_TYPES.has(type) ? { multiple } : {}),
                  })
                  .then(
                    (made) => {
                      setName('');
                      setMultiple(false);
                      creating.close();
                      said(t('admin.fields.added', { name: made.name }));
                      setOpen(made.id);
                    },
                    (error) => setProblem(refusal(error)),
                  );
              }}
            >
              <div className="form-field">
                <label htmlFor={nameId} className="form-label">
                  {t('admin.fields.name')}
                </label>
                <input
                  id={nameId}
                  type="text"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor={typeId} className="form-label">
                  {t('admin.fields.typeLabel')}
                </label>
                <select
                  id={typeId}
                  value={type}
                  onChange={(event) => setType(event.target.value as FieldType)}
                >
                  {FIELD_TYPES.map((of) => (
                    <option key={of} value={of}>
                      {typeName(of)}
                    </option>
                  ))}
                </select>
              </div>
              {MULTIPLE_TYPES.has(type) && (
                <div className="form-field form-field-inline">
                  <input
                    id={multipleId}
                    type="checkbox"
                    checked={multiple}
                    onChange={(event) => setMultiple(event.target.checked)}
                  />
                  <label htmlFor={multipleId}>{t('admin.fields.multiple')}</label>
                </div>
              )}
              <div className="form-actions">
                <button type="submit" className="button-primary">
                  {t('admin.fields.add')}
                </button>
                <button type="button" className="button-secondary" onClick={creating.close}>
                  {t('admin.fields.cancelNew')}
                </button>
              </div>
            </form>
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.fields.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.fields.failed')}
            </p>
          )}
          {state.status === 'loaded' && state.fields.length === 0 && (
            <EmptyState title={t('admin.fields.none')}>{t('empty.fields.body')}</EmptyState>
          )}
          {state.status === 'loaded' && state.fields.length > 0 && (
            <ul className="people-list">
              {state.fields.map((f) => (
                <li key={f.id} className="people-item people-group">
                  <div className="people-main">
                    <p className="people-name">
                      {f.name}
                      {f.trackId !== null && (
                        <span className="people-badge">{t('admin.fields.local')}</span>
                      )}
                    </p>
                    <p className="people-meta">
                      {f.multiple
                        ? t('admin.fields.summaryMultiple', { type: typeName(f.type) })
                        : typeName(f.type)}
                    </p>
                  </div>
                  <div className="people-actions">
                    <button
                      type="button"
                      className="button-secondary people-action"
                      aria-expanded={open === f.id}
                      aria-label={t('admin.fields.manageOf', { name: f.name })}
                      onClick={() => setOpen(open === f.id ? null : f.id)}
                    >
                      {t('admin.fields.manage')}
                    </button>
                  </div>
                  {open === f.id && (
                    <FieldPanel
                      id={f.id}
                      client={client}
                      onChanged={said}
                      onDeleted={(deleted) => {
                        // The field's row goes: the page's heading takes the focus.
                        setOpen(null);
                        said(t('admin.fields.deleted', { name: deleted }));
                        title.current?.focus();
                      }}
                      onProblem={(error) => setProblem(refusal(error))}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function FieldPanel({
  id,
  client,
  onChanged,
  onDeleted,
  onProblem,
}: {
  id: number;
  client: FieldsClient;
  onChanged: (message: string) => void;
  onDeleted: (name: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const formId = useId();
  const [field, setField] = useState<Field | null>(null);
  const [name, setName] = useState('');

  const show = (found: Field) => {
    setField(found);
    setName(found.name);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per field
  useEffect(() => {
    client.field(id).then(show, onProblem);
  }, [id]);

  if (!field) return <p className="page-note people-panel">{t('admin.fields.loading')}</p>;

  return (
    <div className="people-panel">
      <form
        className="people-inline"
        aria-label={t('admin.fields.renameOf', { name: field.name })}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted || wanted === field.name) return;
          client.updateField(id, { name: wanted }).then((saved) => {
            show(saved);
            onChanged(t('admin.fields.saved', { name: saved.name }));
          }, onProblem);
        }}
      >
        <div className="form-field">
          <label htmlFor={`${formId}-name`} className="form-label">
            {t('admin.fields.name')}
          </label>
          <input
            id={`${formId}-name`}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.fields.rename')}
        </button>
      </form>
      {OPTION_TYPES.has(field.type) &&
        field.contexts.map((context) => (
          <ContextOptions
            key={context.id}
            field={field}
            context={context}
            client={client}
            onField={show}
            onChanged={onChanged}
            onProblem={onProblem}
          />
        ))}
      <div className="form-actions">
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('admin.fields.delete')}
          name={t('admin.fields.deleteOf', { name: field.name })}
          outcome={t('admin.fields.confirmDelete', { name: field.name })}
          confirmLabel={t('admin.fields.deleteOf', { name: field.name })}
          onConfirm={async () => {
            try {
              await client.deleteField(id);
            } catch (error) {
              onProblem(error);
              throw error;
            }
            onDeleted(field.name);
          }}
        />
      </div>
    </div>
  );
}

/** The options of one context: add, rename, disable or enable, delete. */
function ContextOptions({
  field,
  context,
  client,
  onField,
  onChanged,
  onProblem,
}: {
  field: Field;
  context: FieldContext;
  client: FieldsClient;
  onField: (field: Field) => void;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const headingId = useId();
  const newId = useId();
  const [value, setValue] = useState('');
  const options = context.options ?? [];
  const reload = () => client.field(field.id).then(onField, onProblem);

  return (
    <section aria-labelledby={headingId} className="people-panel">
      <h2 id={headingId} className="facts-title">
        {t('admin.fields.optionsOf', { context: context.name })}
      </h2>
      {options.length === 0 ? (
        <EmptyState compact title={t('admin.fields.noOptions')} />
      ) : (
        <ul className="people-sublist">
          {options.map((option) => (
            <OptionRow
              key={option.id}
              option={option}
              onRename={(wanted) =>
                client
                  .updateOption(field.id, context.id, option.id, { value: wanted })
                  .then((saved) => {
                    onField(saved);
                    onChanged(t('admin.fields.optionRenamed', { value: wanted }));
                  }, onProblem)
              }
              onToggle={() =>
                client
                  .updateOption(field.id, context.id, option.id, { disabled: !option.disabled })
                  .then((saved) => {
                    onField(saved);
                    onChanged(
                      t(
                        option.disabled
                          ? 'admin.fields.optionEnabled'
                          : 'admin.fields.optionDisabled',
                        { value: option.value },
                      ),
                    );
                  }, onProblem)
              }
              onDelete={() =>
                client.deleteOption(field.id, context.id, option.id).then(() => {
                  void reload();
                  onChanged(t('admin.fields.optionDeleted', { value: option.value }));
                }, onProblem)
              }
            />
          ))}
        </ul>
      )}
      <form
        className="people-inline"
        aria-label={t('admin.fields.addOptionTo', { context: context.name })}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = value.trim();
          if (!wanted) return;
          client.addOption(field.id, context.id, wanted).then((saved) => {
            setValue('');
            onField(saved);
            onChanged(t('admin.fields.optionAdded', { value: wanted }));
          }, onProblem);
        }}
      >
        <div className="form-field">
          <label htmlFor={newId} className="form-label">
            {t('admin.fields.newOption')}
          </label>
          <input
            id={newId}
            type="text"
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.fields.addOption')}
        </button>
      </form>
    </section>
  );
}

function OptionRow({
  option,
  onRename,
  onToggle,
  onDelete,
}: {
  option: FieldOption;
  onRename: (value: string) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(option.value);

  if (editing) {
    return (
      <li>
        <label htmlFor={inputId} className="visually-hidden">
          {t('admin.fields.optionValueOf', { value: option.value })}
        </label>
        <input
          id={inputId}
          type="text"
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
      </li>
    );
  }
  return (
    <li>
      <span className="people-sublist-row">
        {option.value}
        {option.disabled && (
          <span className="people-badge">{t('admin.fields.optionDisabledBadge')}</span>
        )}
      </span>
      <span className="people-actions">
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
    </li>
  );
}
