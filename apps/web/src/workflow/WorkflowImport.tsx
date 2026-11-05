import { type FormEvent, forwardRef, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import type { Imported, ImportProblem, WorkflowSummary, WorkflowsClient } from './client';
import type { Status, WorkflowDefinition } from './definition';
import { definitionProblemMessage, namesFor, STAGE_LABELS } from './describe';

/**
 * Workflow files (M1-127, WF-011): a file downloaded from any Taskmoor server comes in as a new
 * workflow or as the next draft of one. The report says how each status came in (matched by
 * name or created) and what the file names that this workspace has no match for, with what
 * became of the part that named it; nothing of that kind lets more people through.
 */
const workflowHref = (workflowId: number) => `#/admin/workflows/${workflowId}`;

const KINDS = new Set([
  'status',
  'group',
  'role',
  'user',
  'priority',
  'closeReason',
  'ticketType',
  'release',
  'area',
  'field',
  'permission',
]);

/** One problem as a sentence: what, where, and what became of it. */
export function problemMessage(t: Translate, problem: ImportProblem): string {
  const where = problem.transition
    ? t('admin.workflows.report.inTransition', {
        name: t('common.value', { value: problem.transition.name }),
      })
    : problem.status !== undefined
      ? t('admin.workflows.report.inStatus', {
          name: t('common.value', { value: problem.status }),
          action: problem.rule,
        })
      : t('admin.workflows.report.onCreate');
  return t('admin.workflows.report.problem', {
    kind: KINDS.has(problem.kind) ? problem.kind : 'other',
    name: t('common.value', { value: problem.name }),
    where,
    outcome: problem.outcome,
  });
}

/** The report of one import. */
export const ImportReport = forwardRef<HTMLHeadingElement, { imported: Imported; draft: boolean }>(
  function ImportReport({ imported, draft }, heading) {
    const t = useT();
    const id = useId();
    const { workflow, report } = imported;
    const name = t('common.value', { value: workflow.name });
    const stage = (s: keyof typeof STAGE_LABELS) => t(STAGE_LABELS[s]);
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="glass-card account-section workflow-import-report"
      >
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
          {t('admin.workflows.report.title', { name })}
        </h2>
        <p className="page-note">
          {draft
            ? t('admin.workflows.report.draft', { version: workflow.draft?.version ?? 0 })
            : t('admin.workflows.report.newWorkflow')}{' '}
          <a className="workflow-name-link" href={routeHref(workflowHref(workflow.id))}>
            {t('admin.workflows.report.open', { name })}
          </a>
        </p>
        <h3 className="facts-title">{t('admin.workflows.report.statuses')}</h3>
        <ul className="workflow-import-list">
          {report.statuses.map((s) => {
            const value = t('common.value', { value: s.name });
            return (
              <li key={s.statusId}>
                {s.outcome === 'created'
                  ? t('admin.workflows.report.statusCreated', {
                      name: value,
                      stage: stage(s.stage),
                    })
                  : s.stageHere
                    ? t('admin.workflows.report.stageDiffers', {
                        name: value,
                        here: stage(s.stageHere),
                        file: stage(s.stage),
                      })
                    : t('admin.workflows.report.statusMatched', { name: value })}
              </li>
            );
          })}
        </ul>
        <h3 className="facts-title">{t('admin.workflows.report.problems')}</h3>
        {report.problems.length === 0 ? (
          <p className="page-note">{t('admin.workflows.report.noProblems')}</p>
        ) : (
          <>
            <p className="page-note">
              {t('admin.workflows.report.problemCount', { count: report.problems.length })}
            </p>
            <ul className="workflow-import-list">
              {report.problems.map((p, i) => (
                // The same reference can be missing twice in one place: the position tells apart.
                // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
                <li key={i}>{problemMessage(t, p)}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  },
);

/** What a refused import says, in the reader's words. */
function refusal(t: Translate, error: unknown, statuses: Status[], file: unknown): string {
  if (!(error instanceof ApiError)) return t('admin.workflows.import.failed');
  const detail = (error.body as { detail?: unknown } | null)?.detail as
    | { document?: { path: string }[]; problem?: string }
    | undefined;
  const fixed: Partial<Record<string, MessageId>> = {
    not_a_workflow_document: 'admin.workflows.import.notWorkflow',
    unsupported_version: 'admin.workflows.import.unsupported',
    name_taken: 'admin.workflows.form.nameTaken',
  };
  const code = error.code ?? '';
  const known = fixed[code];
  if (known) return t(known);
  if (code === 'invalid_request' && detail?.document?.[0]) {
    return t('admin.workflows.import.invalidAt', { path: detail.document[0].path });
  }
  if (code === 'invalid_request' && detail?.problem) {
    const definition = (file as { definition?: WorkflowDefinition } | null)?.definition ?? null;
    return t('admin.workflows.import.cannotSave', {
      reason: definitionProblemMessage(t, detail, namesFor(t, statuses, definition)),
    });
  }
  return t('admin.workflows.import.failed');
}

/** A chosen file's text. */
const readText = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

/** The form: a file, and whether it becomes a new workflow or the draft of one. */
export function ImportWorkflowForm({
  client,
  workflows,
  statuses,
  refuse,
  onImported,
  onCancel,
}: {
  client: WorkflowsClient;
  workflows: WorkflowSummary[];
  statuses: Status[];
  refuse: (e: unknown) => boolean;
  onImported: (imported: Imported, draft: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<unknown>(undefined);
  const [into, setInto] = useState('new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fileInput.current?.focus();
  }, []);

  const choose = async (chosen: File | undefined) => {
    setError(null);
    setFile(undefined);
    if (!chosen) return;
    try {
      const parsed: unknown = JSON.parse(await readText(chosen));
      setFile(parsed);
      const named = (parsed as { workflow?: { name?: unknown } } | null)?.workflow?.name;
      if (typeof named === 'string' && name === '') setName(named);
    } catch {
      setError(t('admin.workflows.import.unreadable'));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (file === undefined) {
      if (!error) setError(t('admin.workflows.import.fileRequired'));
      fileInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const imported =
        into === 'new'
          ? await client.importNew(file, name.trim() || undefined)
          : await client.importDraft(Number(into), file);
      onImported(imported, into !== 'new');
    } catch (e) {
      if (refuse(e)) return;
      setError(refusal(t, e, statuses, file));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form sso-editor"
      onSubmit={submit}
      aria-label={t('admin.workflows.import.title')}
      noValidate
    >
      <div className="form-field">
        <label htmlFor={`${id}-file`}>{t('admin.workflows.import.file')}</label>
        <input
          ref={fileInput}
          id={`${id}-file`}
          type="file"
          accept=".json,application/json"
          aria-describedby={`${id}-file-hint`}
          aria-invalid={error !== null && file === undefined}
          onChange={(e) => void choose(e.target.files?.[0])}
        />
        <p id={`${id}-file-hint`} className="form-hint">
          {t('admin.workflows.import.fileHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-into`}>{t('admin.workflows.import.into')}</label>
        <select id={`${id}-into`} value={into} onChange={(e) => setInto(e.target.value)}>
          <option value="new">{t('admin.workflows.import.asNew')}</option>
          {workflows.map((w) => (
            <option key={w.id} value={String(w.id)}>
              {t('admin.workflows.import.asDraft', { name: t('common.value', { value: w.name }) })}
            </option>
          ))}
        </select>
      </div>
      {into === 'new' && (
        <div className="form-field">
          <label htmlFor={`${id}-name`}>{t('admin.workflows.form.name')}</label>
          <input
            id={`${id}-name`}
            type="text"
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('admin.workflows.import.submit')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.workflows.cancel')}
        </button>
      </div>
    </form>
  );
}
