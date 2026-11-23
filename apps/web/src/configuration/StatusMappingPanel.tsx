import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MappingImpact, StatusMigration, TypeStatusMapping } from './client';

/** The server refused a change of workflows for tickets it was not told where to move (WF-001). */
export function needsMapping(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.body as { error?: string } | null)?.error === 'status_mapping_required'
  );
}

/** What a change that moved tickets says after its own words: how many moved or are moving. */
export function movedText(t: Translate, migration: StatusMigration | null): string {
  if (!migration || migration.total === 0) return '';
  return t(migration.status === 'done' ? 'statusMapping.moved' : 'statusMapping.moving', {
    count: migration.total,
  });
}

export interface StatusMappingPanelProps {
  /** What the change would do, from the preview. */
  impact: MappingImpact;
  /** The panel's heading: the change about to be made. */
  title: string;
  /** The button that makes the change and moves the tickets. */
  confirmLabel: string;
  /** The tickets changed since the preview, so this is a second look (a 409 on confirming). */
  changed?: boolean;
  busy?: boolean;
  onConfirm: (mapping: TypeStatusMapping) => void;
  onCancel: () => void;
}

/**
 * The status mapping step of a change of workflow map (WF-001, WF-002; T-320): for each ticket
 * type and status the new workflows lack, how many tickets are there and a status of the type's
 * new workflow for them, then the change with `typeStatusMapping`. Every choice is the person's:
 * nothing is chosen for them, and the change waits until each has one. Used when a track switches
 * maps and when a map's workflows change, as the workflow editor's publish step does for a
 * workflow's own statuses.
 */
export function StatusMappingPanel({
  impact,
  title,
  confirmLabel,
  changed = false,
  busy = false,
  onConfirm,
  onCancel,
}: StatusMappingPanelProps) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const rowKey = (typeId: number, statusId: number) => `${typeId}:${statusId}`;

  // The step opens where the person is looking: its heading takes the focus.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const rows = impact.lostStatuses;
    if (rows.some((r) => !chosen[rowKey(r.ticketType.id, r.status.id)])) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const mapping: TypeStatusMapping = {};
    for (const r of rows) {
      const byType = mapping[String(r.ticketType.id)] ?? {};
      byType[String(r.status.id)] = Number(chosen[rowKey(r.ticketType.id, r.status.id)]);
      mapping[String(r.ticketType.id)] = byType;
    }
    onConfirm(mapping);
  };

  return (
    <form className="people-form" aria-labelledby={`${id}-title`} noValidate onSubmit={submit}>
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
        {title}
      </h2>
      <p className="page-note">{t('statusMapping.lead', { count: impact.ticketCount })}</p>
      {changed && (
        <p role="alert" className="form-error">
          {t('statusMapping.changed')}
        </p>
      )}
      <fieldset className="form-field">
        <legend className="form-label">{t('statusMapping.legend')}</legend>
        {impact.lostStatuses.map((row) => {
          const key = rowKey(row.ticketType.id, row.status.id);
          const field = `${id}-${row.ticketType.id}-${row.status.id}`;
          const target = impact.targetWorkflows.find((w) => w.id === row.workflow.id);
          const unset = missing && !chosen[key];
          return (
            <div key={key} className="form-field">
              <label htmlFor={field} className="form-label">
                {t('statusMapping.moveTo', {
                  count: row.ticketCount,
                  type: row.ticketType.name,
                  status: row.status.name,
                })}
              </label>
              <select
                id={field}
                value={chosen[key] ?? ''}
                aria-describedby={`${field}-hint`}
                aria-invalid={unset || undefined}
                onChange={(event) => setChosen((c) => ({ ...c, [key]: event.target.value }))}
              >
                <option value="">{t('statusMapping.choose')}</option>
                {(target?.statuses ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p id={`${field}-hint`} className="form-hint">
                {t('statusMapping.of', { workflow: row.workflow.name, type: row.ticketType.name })}
              </p>
            </div>
          );
        })}
      </fieldset>
      {missing && (
        <p role="alert" className="form-error">
          {t('statusMapping.missing')}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {confirmLabel}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('statusMapping.cancel')}
        </button>
      </div>
    </form>
  );
}

export interface MigrationProgressProps {
  /** The migration the change started, as its answer gave it. */
  migration: StatusMigration;
  read: (id: number) => Promise<StatusMigration>;
  /** How often to read it again, in milliseconds. */
  every?: number;
}

/**
 * How far the tickets a change of workflows moves have got (WF-001; T-320): up to 500 move in the
 * request itself, the rest in the background, read again every two seconds until all have moved.
 * Tickets not yet moved keep working meanwhile: a transition moves them first.
 */
export function MigrationProgress({ migration, read, every = 2000 }: MigrationProgressProps) {
  const t = useT();
  const id = useId();
  const [now, setNow] = useState(migration);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (now.status === 'done' || failed) return;
    let live = true;
    const timer = setTimeout(() => {
      read(now.id).then(
        (next) => live && setNow(next),
        () => live && setFailed(true),
      );
    }, every);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [now, failed, read, every]);
  const moved = Math.min(now.migrated, now.total);
  return (
    <div className="bulk-progress">
      <label htmlFor={`${id}-bar`} className="form-label">
        {t('statusMapping.progress', { moved, total: now.total })}
      </label>
      <progress id={`${id}-bar`} max={now.total} value={moved} />
      {failed ? (
        <p role="alert" className="form-error">
          {t('statusMapping.progressFailed')}
        </p>
      ) : (
        <p role="status" className="form-status">
          {now.status === 'done' ? t('statusMapping.done', { total: now.total }) : ''}
        </p>
      )}
    </div>
  );
}
