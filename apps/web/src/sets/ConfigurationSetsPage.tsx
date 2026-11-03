import { useCallback, useEffect, useId, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  FIXED_FIELDS,
  type FieldRule,
  type Named,
  type RuleSet,
  type RuleSetSummary,
  type SetsClient,
  SYSTEM_FIELDS,
  setsClient,
  type TypeSet,
} from './client';

export interface ConfigurationSetsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: SetsClient;
}

/**
 * Configuration sets (CORE-003, CORE-008), for administrators: type sets (which ticket types a
 * track offers) and field rule sets (which fields are required or hidden, with help text, for
 * every type). Rules for one ticket type, who may edit a field, layout sets, and visibility and
 * notification policies are set through the API for now; a save keeps the rules it does not show.
 */
export function ConfigurationSetsPage({ client = setsClient }: ConfigurationSetsPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'loaded';
        types: Named[];
        fields: Named[];
        typeSets: TypeSet[];
        ruleSets: RuleSetSummary[];
      }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [types, fields, typeSets, ruleSets] = await Promise.all([
        client.ticketTypes(),
        client.customFields(),
        client.typeSets(),
        client.ruleSets(),
      ]);
      setState({ status: 'loaded', types, fields, typeSets, ruleSets });
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
      if (!(error instanceof ApiError)) return t('admin.sets.problem.other');
      const body = error.body as { error?: string; trackCount?: number } | null;
      if (body?.error === 'in_use') {
        return t('admin.sets.problem.inUse', { tracks: body.trackCount ?? 0 });
      }
      if (body?.error === 'default' || body?.error === 'default_type_set') {
        return t('admin.sets.problem.default');
      }
      if (body?.error === 'type_in_use') return t('admin.sets.problem.typeInUse');
      if (body?.error === 'name_taken') return t('admin.sets.problem.nameTaken');
      if (error.status === 400) return t('admin.sets.problem.invalid');
      if (error.status === 403) return t('admin.sets.problem.forbidden');
      return t('admin.sets.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };
  const failed = (error: unknown) => setProblem(refusal(error));

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <h1 id={titleId} className="page-title">
        {t('admin.sets.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.sets.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.sets.intro')}</p>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.sets.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.sets.failed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <>
              <TypeSetsSection
                client={client}
                types={state.types}
                sets={state.typeSets}
                said={said}
                failed={failed}
              />
              <RuleSetsSection
                client={client}
                fields={state.fields}
                sets={state.ruleSets}
                said={said}
                failed={failed}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

interface Feedback {
  said: (message: string) => void;
  failed: (error: unknown) => void;
}

/** Checkboxes for the ticket types a set holds. */
function TypePicker({
  legend,
  types,
  chosen,
  onChange,
}: {
  legend: string;
  types: Named[];
  chosen: number[];
  onChange: (ids: number[]) => void;
}) {
  const id = useId();
  return (
    <fieldset className="sets-choices">
      <legend>{legend}</legend>
      {types.map((type) => (
        <div key={type.id} className="form-field form-field-inline">
          <input
            id={`${id}-${type.id}`}
            type="checkbox"
            checked={chosen.includes(type.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...chosen, type.id]
                  : chosen.filter((typeId) => typeId !== type.id),
              )
            }
          />
          <label htmlFor={`${id}-${type.id}`}>{type.name}</label>
        </div>
      ))}
    </fieldset>
  );
}

function TypeSetsSection({
  client,
  types,
  sets,
  said,
  failed,
}: Feedback & { client: SetsClient; types: Named[]; sets: TypeSet[] }) {
  const t = useT();
  const headingId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section aria-labelledby={headingId} className="people-page">
      <h2 id={headingId} className="facts-title">
        {t('admin.sets.typeSets')}
      </h2>
      <form
        className="people-inline"
        aria-label={t('admin.sets.addTypeSet')}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted || chosen.length === 0) return;
          client.createTypeSet({ name: wanted, ticketTypeIds: chosen }).then((made) => {
            setName('');
            setChosen([]);
            setOpen(made.id);
            said(t('admin.sets.added', { name: made.name }));
          }, failed);
        }}
      >
        <div className="form-field">
          <label htmlFor={nameId} className="form-label">
            {t('admin.sets.typeSetName')}
          </label>
          <input
            id={nameId}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <TypePicker
          legend={t('admin.sets.typesIn')}
          types={types}
          chosen={chosen}
          onChange={setChosen}
        />
        <button type="submit" className="button-secondary" disabled={chosen.length === 0}>
          {t('admin.sets.addTypeSet')}
        </button>
      </form>
      <ul className="people-list">
        {sets.map((set) => (
          <li key={set.id} className="people-item people-group">
            <div className="people-main">
              <p className="people-name">
                {set.name}
                {set.defaultFor.length > 0 && (
                  <span className="people-badge">{t('admin.sets.default')}</span>
                )}
              </p>
              <p className="people-meta">
                {t('admin.sets.typeSetSummary', {
                  types: set.ticketTypes.map((type) => type.name).join(', '),
                  tracks: set.tracks.length,
                })}
              </p>
            </div>
            <div className="people-actions">
              <button
                type="button"
                className="button-secondary people-action"
                aria-expanded={open === set.id}
                aria-label={t('admin.sets.manageOf', { name: set.name })}
                onClick={() => setOpen(open === set.id ? null : set.id)}
              >
                {t('admin.sets.manage')}
              </button>
            </div>
            {open === set.id && (
              <TypeSetPanel
                key={set.id}
                set={set}
                types={types}
                client={client}
                said={said}
                failed={failed}
                onDeleted={() => setOpen(null)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TypeSetPanel({
  set,
  types,
  client,
  said,
  failed,
  onDeleted,
}: Feedback & { set: TypeSet; types: Named[]; client: SetsClient; onDeleted: () => void }) {
  const t = useT();
  const [chosen, setChosen] = useState(set.ticketTypes.map((type) => type.id));
  const [confirming, setConfirming] = useState(false);
  return (
    <form
      className="people-panel"
      aria-label={t('admin.sets.editOf', { name: set.name })}
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length === 0) return;
        client
          .updateTypeSet(set.id, { ticketTypeIds: chosen })
          .then((saved) => said(t('admin.sets.saved', { name: saved.name })), failed);
      }}
    >
      <TypePicker
        legend={t('admin.sets.typesIn')}
        types={types}
        chosen={chosen}
        onChange={setChosen}
      />
      {set.tracks.length > 0 && (
        <p className="page-note">
          {t('admin.sets.usedBy', { tracks: set.tracks.map((tr) => tr.key).join(', ') })}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={chosen.length === 0}>
          {t('admin.sets.save')}
        </button>
        <DeleteButton
          name={set.name}
          confirming={confirming}
          setConfirming={setConfirming}
          hidden={set.defaultFor.length > 0}
          onDelete={() =>
            client.deleteTypeSet(set.id).then(() => {
              onDeleted();
              said(t('admin.sets.deleted', { name: set.name }));
            }, failed)
          }
        />
      </div>
    </form>
  );
}

function DeleteButton({
  name,
  confirming,
  setConfirming,
  hidden,
  onDelete,
}: {
  name: string;
  confirming: boolean;
  setConfirming: (on: boolean) => void;
  hidden: boolean;
  onDelete: () => void;
}) {
  const t = useT();
  if (hidden) return null;
  if (!confirming) {
    return (
      <button
        type="button"
        className="button-secondary"
        aria-label={t('admin.sets.deleteOf', { name })}
        onClick={() => setConfirming(true)}
      >
        {t('admin.sets.delete')}
      </button>
    );
  }
  return (
    <>
      <span className="people-confirm">{t('admin.sets.confirmDelete', { name })}</span>
      <button
        type="button"
        className="button-danger"
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
      >
        {t('admin.sets.confirmYes')}
      </button>
      <button type="button" className="button-secondary" onClick={() => setConfirming(false)}>
        {t('admin.sets.confirmNo')}
      </button>
    </>
  );
}

function RuleSetsSection({
  client,
  fields,
  sets,
  said,
  failed,
}: Feedback & { client: SetsClient; fields: Named[]; sets: RuleSetSummary[] }) {
  const t = useT();
  const headingId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section aria-labelledby={headingId} className="people-page">
      <h2 id={headingId} className="facts-title">
        {t('admin.sets.ruleSets')}
      </h2>
      <form
        className="people-inline"
        aria-label={t('admin.sets.addRuleSet')}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted) return;
          client.createRuleSet({ name: wanted }).then((made) => {
            setName('');
            setOpen(made.id);
            said(t('admin.sets.added', { name: made.name }));
          }, failed);
        }}
      >
        <div className="form-field">
          <label htmlFor={nameId} className="form-label">
            {t('admin.sets.ruleSetName')}
          </label>
          <input
            id={nameId}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary">
          {t('admin.sets.addRuleSet')}
        </button>
      </form>
      <ul className="people-list">
        {sets.map((set) => (
          <li key={set.id} className="people-item people-group">
            <div className="people-main">
              <p className="people-name">
                {set.name}
                {set.isDefault && <span className="people-badge">{t('admin.sets.default')}</span>}
              </p>
            </div>
            <div className="people-actions">
              <button
                type="button"
                className="button-secondary people-action"
                aria-expanded={open === set.id}
                aria-label={t('admin.sets.manageOf', { name: set.name })}
                onClick={() => setOpen(open === set.id ? null : set.id)}
              >
                {t('admin.sets.manage')}
              </button>
            </div>
            {open === set.id && (
              <RuleSetPanel
                id={set.id}
                fields={fields}
                client={client}
                said={said}
                failed={failed}
                onDeleted={() => setOpen(null)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Row {
  field: string;
  required: boolean;
  hidden: boolean;
  description: string;
  editableBy: unknown;
}

/** The every-type rule of each field, with the defaults where the set has none. */
function rowsOf(set: RuleSet, keys: string[]): Row[] {
  return keys.map((field) => {
    const rule = set.rules.find((r) => r.ticketTypeId === null && r.field === field);
    return {
      field,
      required: FIXED_FIELDS.has(field) || (rule?.required ?? false),
      hidden: rule?.hidden ?? false,
      description: rule?.description ?? '',
      editableBy: rule?.editableBy ?? null,
    };
  });
}

function RuleSetPanel({
  id,
  fields,
  client,
  said,
  failed,
  onDeleted,
}: Feedback & { id: number; fields: Named[]; client: SetsClient; onDeleted: () => void }) {
  const t = useT();
  const formId = useId();
  const [set, setSet] = useState<RuleSet | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirming, setConfirming] = useState(false);
  const keys = [...SYSTEM_FIELDS, ...fields.map((f) => `cf[${f.id}]`)];
  const show = (found: RuleSet) => {
    setSet(found);
    setRows(rowsOf(found, keys));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per set
  useEffect(() => {
    client.ruleSet(id).then(show, failed);
  }, [id]);

  if (!set) return <p className="page-note people-panel">{t('admin.sets.loading')}</p>;
  const label = (field: string) => {
    const custom = /^cf\[(\d+)\]$/.exec(field)?.[1];
    if (custom) return fields.find((f) => f.id === Number(custom))?.name ?? field;
    return t(`workflow.field.${field}` as MessageId);
  };
  const change = (field: string, patch: Partial<Row>) =>
    setRows((list) => list.map((r) => (r.field === field ? { ...r, ...patch } : r)));

  return (
    <form
      className="people-panel"
      aria-label={t('admin.sets.editOf', { name: set.name })}
      onSubmit={(event) => {
        event.preventDefault();
        // Rules for one ticket type are kept as they are; the every-type rules are the rows.
        const typed = set.rules.filter((r) => r.ticketTypeId !== null);
        const shown: FieldRule[] = rows
          .filter((r) => !FIXED_FIELDS.has(r.field) || r.description)
          .filter((r) => r.required || r.hidden || r.description || r.editableBy)
          .map((r) => ({
            ticketTypeId: null,
            field: r.field,
            required: r.required,
            hidden: r.hidden,
            description: r.description || null,
            editableBy: r.editableBy,
          }));
        client.updateRuleSet(id, { rules: [...typed, ...shown] }).then((saved) => {
          show(saved);
          said(t('admin.sets.saved', { name: saved.name }));
        }, failed);
      }}
    >
      {rows.map((row) => {
        const fixed = FIXED_FIELDS.has(row.field);
        return (
          <fieldset key={row.field} className="sets-rule">
            <legend>{label(row.field)}</legend>
            <div className="form-field form-field-inline">
              <input
                id={`${formId}-${row.field}-required`}
                type="checkbox"
                checked={row.required}
                disabled={fixed || row.hidden}
                onChange={(event) => change(row.field, { required: event.target.checked })}
              />
              <label htmlFor={`${formId}-${row.field}-required`}>{t('admin.sets.required')}</label>
            </div>
            <div className="form-field form-field-inline">
              <input
                id={`${formId}-${row.field}-hidden`}
                type="checkbox"
                checked={row.hidden}
                disabled={fixed || row.required}
                onChange={(event) => change(row.field, { hidden: event.target.checked })}
              />
              <label htmlFor={`${formId}-${row.field}-hidden`}>{t('admin.sets.hidden')}</label>
            </div>
            <div className="form-field">
              <label htmlFor={`${formId}-${row.field}-help`} className="form-label">
                {t('admin.sets.help')}
              </label>
              <input
                id={`${formId}-${row.field}-help`}
                type="text"
                value={row.description}
                onChange={(event) => change(row.field, { description: event.target.value })}
              />
            </div>
          </fieldset>
        );
      })}
      {set.usedBy.length > 0 && (
        <p className="page-note">
          {t('admin.sets.usedBy', { tracks: set.usedBy.map((tr) => tr.key).join(', ') })}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.sets.save')}
        </button>
        <DeleteButton
          name={set.name}
          confirming={confirming}
          setConfirming={setConfirming}
          hidden={set.isDefault}
          onDelete={() =>
            client.deleteRuleSet(id).then(() => {
              onDeleted();
              said(t('admin.sets.deleted', { name: set.name }));
            }, failed)
          }
        />
      </div>
    </form>
  );
}
