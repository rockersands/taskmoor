import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  FIELD_TYPES,
  type Field,
  type FieldConfig,
  type FieldsClient,
  type FieldType,
  type FormulaProblem,
  fieldsClient,
  MULTIPLE_TYPES,
} from './client';
import { FieldPanel } from './FieldPanel';
import { FieldSettings, SETTINGS_TYPES } from './FieldSettings';
import { FormulaEditor, formulaConfig } from './FormulaEditor';

export interface FieldsAdminPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: FieldsClient;
}

/** The refusals the fields page words, by the server's code. */
const REFUSALS: Readonly<Record<string, MessageId>> = {
  name_taken: 'admin.fields.problem.nameTaken',
  value_taken: 'admin.fields.problem.valueTaken',
  context_overlap: 'admin.fields.problem.overlap',
  invalid_default: 'admin.fields.problem.invalidDefault',
  unknown_group: 'admin.fields.problem.listChanged',
  unknown_role: 'admin.fields.problem.listChanged',
  unknown_track: 'admin.fields.problem.listChanged',
  unknown_ticket_type: 'admin.fields.problem.listChanged',
  unknown_parent: 'admin.fields.problem.listChanged',
  track_archived: 'admin.fields.problem.trackArchived',
  guardrail_exceeded: 'admin.fields.problem.limit',
  invalid_request: 'admin.fields.problem.invalid',
};

/**
 * Custom fields (CORE-003, CORE-009, CORE-010, CORE-011), for site and configuration
 * administrators: add a field of any type, formulas included (T-320), with its description and
 * type settings; Manage one (`FieldPanel`) to change its name, description, settings or formula,
 * where it applies, each context's default and options, and to delete it once no ticket holds a
 * value. A choice list's display setting stays API-only in 1.0: the web app always shows a list.
 */
export function FieldsAdminPage({ client = fieldsClient }: FieldsAdminPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const nameId = useId();
  const descriptionId = useId();
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
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [multiple, setMultiple] = useState(false);
  const [config, setConfig] = useState<FieldConfig>({});
  const [refused, setRefused] = useState<{ problem: FormulaProblem; expression: string } | null>(
    null,
  );
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
    (error: unknown, about?: 'context') => {
      if (!(error instanceof ApiError)) return t('admin.fields.problem.other');
      const body = error.body as {
        error?: string;
        ticketCount?: number;
        fields?: { name: string }[];
      } | null;
      if (body?.error === 'in_use') {
        return t('admin.fields.problem.inUse', { tickets: body.ticketCount ?? 0 });
      }
      if (body?.error === 'options_in_use') {
        return t('admin.fields.problem.optionsInUse', { tickets: body.ticketCount ?? 0 });
      }
      if (body?.error === 'used_by_formula') {
        return t('admin.fields.problem.formula', {
          fields: (body.fields ?? []).map((f) => f.name).join(', '),
        });
      }
      if (body?.error === 'name_taken' && about === 'context') {
        return t('admin.fields.problem.contextNameTaken');
      }
      const known =
        body?.error && Object.hasOwn(REFUSALS, body.error) ? REFUSALS[body.error] : null;
      if (known) return t(known);
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
  const chooseType = (next: FieldType) => {
    setType(next);
    setConfig(next === 'formula' ? formulaConfig({}, 'number') : {});
    setRefused(null);
  };
  const fields = state.status === 'loaded' ? state.fields : [];

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
                const settings =
                  type === 'formula' ? formulaConfig(config, config.output ?? 'number') : config;
                client
                  .createField({
                    name: wanted,
                    type,
                    ...(description.trim() ? { description: description.trim() } : {}),
                    ...(MULTIPLE_TYPES.has(type) ? { multiple } : {}),
                    ...(Object.keys(settings).length > 0 ? { config: settings } : {}),
                  })
                  .then(
                    (made) => {
                      setName('');
                      setDescription('');
                      setMultiple(false);
                      chooseType('text');
                      creating.close();
                      said(t('admin.fields.added', { name: made.name }));
                      setOpen(made.id);
                    },
                    (error) => {
                      const body =
                        error instanceof ApiError
                          ? (error.body as { error?: string; formula?: FormulaProblem } | null)
                          : null;
                      if (body?.error === 'invalid_formula' && body.formula) {
                        setRefused({
                          problem: body.formula,
                          expression: settings.expression ?? '',
                        });
                      } else setProblem(refusal(error));
                    },
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
                  maxLength={255}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor={descriptionId} className="form-label">
                  {t('admin.fields.description')}
                </label>
                <textarea
                  id={descriptionId}
                  rows={2}
                  maxLength={2000}
                  aria-describedby={`${descriptionId}-hint`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <p id={`${descriptionId}-hint`} className="form-hint">
                  {t('admin.fields.descriptionHint')}
                </p>
              </div>
              <div className="form-field">
                <label htmlFor={typeId} className="form-label">
                  {t('admin.fields.typeLabel')}
                </label>
                <select
                  id={typeId}
                  value={type}
                  onChange={(event) => chooseType(event.target.value as FieldType)}
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
              {SETTINGS_TYPES.has(type) && (
                <FieldSettings type={type} config={config} onChange={setConfig} />
              )}
              {type === 'formula' && (
                <FormulaEditor
                  config={config}
                  onChange={setConfig}
                  fields={fields}
                  check={client.checkFormula}
                  trackId={null}
                  refused={refused}
                />
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
                    {f.description && <p className="people-meta">{f.description}</p>}
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
                      fields={state.fields}
                      client={client}
                      onChanged={said}
                      onDeleted={(deleted) => {
                        // The field's row goes: the page's heading takes the focus.
                        setOpen(null);
                        said(t('admin.fields.deleted', { name: deleted }));
                        title.current?.focus();
                      }}
                      onProblem={(error, about) => setProblem(refusal(error, about))}
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
