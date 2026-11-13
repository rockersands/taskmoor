import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { DangerAction } from '../shell/DangerAction';
import type { StatusInput, WorkflowsClient } from './client';
import { STAGES, type Stage, type Status } from './definition';
import { STAGE_HINTS, STAGE_LABELS } from './describe';

export interface StatusesSectionProps {
  statuses: Status[] | null;
  failed: boolean;
  client: WorkflowsClient;
  /** Takes the list after a change; the section reloads nothing itself. */
  onChanged: (statuses: Status[]) => void;
  refuse: (error: unknown) => boolean;
}

/**
 * The workspace's statuses (CORE-014, M1-030): in order, each with its stage; add one, rename
 * it or change its stage while no ticket is in it, move it up or down, and delete it when no
 * ticket and no workflow uses it.
 */
export function StatusesSection({
  statuses,
  failed,
  client,
  onChanged,
  refuse,
}: StatusesSectionProps) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = (text: string) => t('common.value', { value: text });

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone('');
    try {
      await work();
    } catch (e) {
      if (!refuse(e)) setError(t('admin.workflows.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (target: Status | null, input: StatusInput) => {
    const saved = target
      ? await client.updateStatus(target.id, input)
      : await client.createStatus(input);
    onChanged(await client.statuses());
    setEditing(null);
    setDone(
      t(target ? 'admin.statuses.saved' : 'admin.statuses.added', { name: value(saved.name) }),
    );
    heading.current?.focus();
  };

  const move = (list: Status[], index: number, by: -1 | 1) =>
    act(async () => {
      const ids = list.map((s) => s.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(index + by, 0, moved as number);
      onChanged(await client.orderStatuses(ids));
      setDone(t('admin.statuses.moved', { name: value(list[index]?.name ?? '') }));
    });

  // Asks first (D13). Once deleted, the list's heading takes the focus, as the row is gone; a
  // refusal keeps the question open, the reason above the list.
  const remove = async (status: Status) => {
    setBusy(true);
    setError(null);
    setDone('');
    try {
      await client.deleteStatus(status.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'status_in_use') {
        const body = e.body as { ticketCount?: number; workflows?: unknown[] };
        setError(
          t('admin.statuses.inUse', {
            name: value(status.name),
            tickets: body.ticketCount ?? 0,
            workflows: body.workflows?.length ?? 0,
          }),
        );
      } else if (!refuse(e)) {
        setError(t('admin.workflows.actionFailed'));
      }
      throw e;
    } finally {
      setBusy(false);
    }
    // Deleted: reading the list again cannot take that back, so a failure here is only said.
    await act(async () => {
      onChanged(await client.statuses());
      setDone(t('admin.statuses.deleted', { name: value(status.name) }));
      heading.current?.focus();
    });
  };

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <div className="sso-list-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
          {t('admin.statuses.title')}
        </h2>
        {statuses && (
          <button
            ref={addButton}
            type="button"
            className="button-primary"
            aria-expanded={editing === 'new'}
            onClick={() => {
              setDone('');
              setEditing('new');
            }}
          >
            {t('admin.statuses.add')}
          </button>
        )}
      </div>
      <p className="page-note">{t('admin.statuses.intro')}</p>
      {editing === 'new' && (
        <StatusForm
          onSave={(input) => save(null, input)}
          onCancel={() => {
            setEditing(null);
            addButton.current?.focus();
          }}
        />
      )}
      {!statuses && !failed && (
        <p role="status" className="page-note">
          {t('admin.statuses.loading')}
        </p>
      )}
      {failed && (
        <p role="alert" className="form-error">
          {t('admin.statuses.failed')}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {statuses && (
        <ol className="status-list" aria-labelledby={`${id}-title`}>
          {statuses.map((status, index) => (
            <li key={status.id} className="status-item">
              <div className="status-main">
                <span className={`stage-dot stage-${status.stage}`} aria-hidden="true" />
                <span className="status-name">{value(status.name)}</span>
                <span className={`stage-badge stage-${status.stage}`}>
                  {t('workflow.stageBadge', { stage: t(STAGE_LABELS[status.stage]) })}
                </span>
              </div>
              {editing === status.id ? (
                <StatusForm
                  status={status}
                  onSave={(input) => save(status, input)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="token-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    aria-label={t('admin.statuses.editNamed', { name: value(status.name) })}
                    onClick={() => {
                      setDone('');
                      setEditing(status.id);
                    }}
                  >
                    {t('admin.statuses.edit')}
                  </button>
                  {index > 0 && (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={busy}
                      aria-label={t('admin.statuses.moveUp', { name: value(status.name) })}
                      onClick={() => void move(statuses, index, -1)}
                    >
                      {t('admin.workflow.rule.up')}
                    </button>
                  )}
                  {index < statuses.length - 1 && (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={busy}
                      aria-label={t('admin.statuses.moveDown', { name: value(status.name) })}
                      onClick={() => void move(statuses, index, 1)}
                    >
                      {t('admin.workflow.rule.down')}
                    </button>
                  )}
                  <DangerAction
                    label={t('admin.statuses.delete')}
                    name={t('admin.statuses.deleteNamed', { name: value(status.name) })}
                    outcome={t('admin.statuses.confirmDelete', { name: value(status.name) })}
                    confirmLabel={t('admin.statuses.deleteNamed', { name: value(status.name) })}
                    onConfirm={() => remove(status)}
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <p role="status" className="form-status">
        {done}
      </p>
    </section>
  );
}

/** Name, stage and description of a new status or one being edited. */
function StatusForm({
  status,
  onSave,
  onCancel,
}: {
  status?: Status;
  onSave: (input: StatusInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(status?.name ?? '');
  const [stage, setStage] = useState<Stage>(status?.stage ?? 'active');
  const [description, setDescription] = useState(status?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = status
    ? t('admin.statuses.formEdit', { name: t('common.value', { value: status.name }) })
    : t('admin.statuses.formNew');

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setError(t('admin.statuses.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), stage, description });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'name_taken') setError(t('admin.statuses.nameTaken'));
      else if (code === 'status_in_use') {
        const count = ((e as ApiError).body as { ticketCount?: number }).ticketCount ?? 0;
        setError(
          t('admin.statuses.stageInUse', {
            name: t('common.value', { value: status?.name ?? name }),
            count,
          }),
        );
      } else setError(t('admin.statuses.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form status-form" onSubmit={submit} aria-label={title} noValidate>
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('admin.statuses.name')}</label>
        <input
          ref={nameInput}
          id={`${id}-name`}
          type="text"
          maxLength={255}
          value={name}
          aria-invalid={error === t('admin.statuses.nameRequired')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset>
        <legend>{t('admin.statuses.stage')}</legend>
        {STAGES.map((s) => (
          <div key={s} className="form-field form-field-inline sso-option">
            <input
              id={`${id}-stage-${s}`}
              type="radio"
              name={`${id}-stage`}
              checked={stage === s}
              aria-describedby={`${id}-stage-${s}-hint`}
              onChange={() => setStage(s)}
            />
            <label htmlFor={`${id}-stage-${s}`}>
              <span className={`stage-dot stage-${s}`} aria-hidden="true" />
              {t(STAGE_LABELS[s])}
            </label>
            <p id={`${id}-stage-${s}-hint`} className="form-hint sso-option-hint">
              {t(STAGE_HINTS[s])}
            </p>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-description`}>{t('admin.statuses.description')}</label>
        <textarea
          id={`${id}-description`}
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {status ? t('admin.statuses.save') : t('admin.statuses.create')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.statuses.cancel')}
        </button>
      </div>
    </form>
  );
}
