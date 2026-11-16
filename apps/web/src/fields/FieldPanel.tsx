import { useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { DangerAction } from '../shell/DangerAction';
import { type ContextLists, ContextsSection } from './ContextsSection';
import type { Field, FieldConfig, FieldsClient, FormulaProblem } from './client';
import { FieldSettings, SETTINGS_TYPES } from './FieldSettings';
import { FormulaEditor, formulaConfig } from './FormulaEditor';

export interface FieldPanelProps {
  id: number;
  /** Every field the page lists: a formula's help and check name them. */
  fields: readonly Field[];
  client: FieldsClient;
  onChanged: (message: string) => void;
  onDeleted: (name: string) => void;
  /** A refusal; `context` when it is about one of the field's contexts. */
  onProblem: (error: unknown, about?: 'context') => void;
}

/** The type settings a field keeps, as the page edits them: a formula's with its output. */
const settingsOf = (field: Field): FieldConfig =>
  field.type === 'formula'
    ? formulaConfig(field.config ?? {}, field.config?.output ?? 'number')
    : { ...(field.config ?? {}) };

/**
 * A field's Manage panel (CORE-003, CORE-009, CORE-010, CORE-011; T-320): its name and
 * description; its type settings (a paragraph's length, a number's format) or its formula, each
 * saved whole as `PATCH /fields/:id` replaces them; where it applies, with each context's
 * default and options; and Delete field, which asks first.
 */
export function FieldPanel({
  id,
  fields,
  client,
  onChanged,
  onDeleted,
  onProblem,
}: FieldPanelProps) {
  const t = useT();
  const formId = useId();
  const settingsId = useId();
  const [field, setField] = useState<Field | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [settings, setSettings] = useState<FieldConfig>({});
  const [refused, setRefused] = useState<{ problem: FormulaProblem; expression: string } | null>(
    null,
  );
  const [lists, setLists] = useState<ContextLists | null>(null);

  const show = (found: Field) => {
    setField(found);
    setName(found.name);
    setDescription(found.description);
    setSettings(settingsOf(found));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per field
  useEffect(() => {
    client.field(id).then(show, onProblem);
  }, [id]);

  // The lists its contexts name: tracks and ticket types (a local field's track's own too), and
  // for person and group fields the site's groups, and roles. One that fails reads as empty.
  const trackId = field?.trackId;
  const type = field?.type;
  useEffect(() => {
    if (type === undefined || trackId === undefined) return;
    let live = true;
    const empty = () => [];
    Promise.all([
      client.tracks().catch(empty),
      client.ticketTypes(trackId).catch(empty),
      type === 'user' || type === 'group' ? client.groups().catch(empty) : Promise.resolve([]),
      type === 'user' ? client.roles().catch(empty) : Promise.resolve([]),
    ]).then(([tracks, types, groups, roles]) => {
      if (live) setLists({ tracks, types, groups, roles });
    });
    return () => {
      live = false;
    };
  }, [client, trackId, type]);

  if (!field) return <p className="page-note people-panel">{t('admin.fields.loading')}</p>;

  const saveSettings = (config: FieldConfig) =>
    client.updateField(id, { config }).then(
      (saved) => {
        show(saved);
        setRefused(null);
        onChanged(t('admin.fields.settings.saved', { name: saved.name }));
      },
      (error) => {
        const body =
          error instanceof ApiError
            ? (error.body as { error?: string; formula?: FormulaProblem } | null)
            : null;
        if (body?.error === 'invalid_formula' && body.formula) {
          setRefused({ problem: body.formula, expression: config.expression ?? '' });
        } else onProblem(error);
      },
    );

  return (
    <div className="people-panel">
      <form
        className="people-inline"
        aria-label={t('admin.fields.detailsOf', { name: field.name })}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted) return;
          const change = {
            ...(wanted !== field.name ? { name: wanted } : {}),
            ...(description !== field.description ? { description } : {}),
          };
          if (Object.keys(change).length === 0) return;
          client.updateField(id, change).then((saved) => {
            // The settings being typed stay as they are.
            setField(saved);
            setName(saved.name);
            setDescription(saved.description);
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
            maxLength={255}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${formId}-description`} className="form-label">
            {t('admin.fields.description')}
          </label>
          <textarea
            id={`${formId}-description`}
            rows={2}
            maxLength={2000}
            aria-describedby={`${formId}-description-hint`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <p id={`${formId}-description-hint`} className="form-hint">
            {t('admin.fields.descriptionHint')}
          </p>
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.fields.saveDetails')}
        </button>
      </form>
      {(SETTINGS_TYPES.has(field.type) || field.type === 'formula') && (
        <form
          className="people-form people-panel"
          aria-labelledby={settingsId}
          onSubmit={(event) => {
            event.preventDefault();
            void saveSettings(
              field.type === 'formula'
                ? formulaConfig(settings, settings.output ?? 'number')
                : settings,
            );
          }}
        >
          <h2 id={settingsId} className="facts-title">
            {t(
              field.type === 'formula'
                ? 'admin.fields.formula.titleOf'
                : 'admin.fields.settings.titleOf',
              { name: field.name },
            )}
          </h2>
          {field.type === 'formula' ? (
            <FormulaEditor
              config={settings}
              onChange={setSettings}
              fields={fields}
              check={client.checkFormula}
              fieldId={field.id}
              trackId={field.trackId}
              refused={refused}
            />
          ) : (
            <FieldSettings type={field.type} config={settings} onChange={setSettings} />
          )}
          <div className="form-actions">
            <button type="submit" className="button-secondary">
              {t(
                field.type === 'formula'
                  ? 'admin.fields.formula.save'
                  : 'admin.fields.settings.save',
              )}
            </button>
          </div>
        </form>
      )}
      <ContextsSection
        field={field}
        client={client}
        lists={lists}
        onField={setField}
        onChanged={onChanged}
        onProblem={onProblem}
      />
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
