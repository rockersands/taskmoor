import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAdminTrail } from '../admin/AdminLayout';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import {
  type Impact,
  type Lookups,
  type VersionEntry,
  type WorkflowsClient,
  type WorkflowView,
  workflowsClient,
} from './client';
import { DefinitionText, legendOf } from './DefinitionText';
import {
  addingNeedsCloseReason,
  addStatusFreely,
  addTransition,
  formatDefinition,
  freeingSeed,
  freeingSeedNeedsCloseReason,
  nextTransitionId,
  type RuleDef,
  removeStatus,
  removeTransition,
  type Status,
  sameDefinition,
  setInitialStatus,
  statusIdsOf,
  strictSeedSteps,
  type Transition,
  transitionIdsOf,
  updateTransition,
  type WorkflowDefinition,
  withRules,
} from './definition';
import { namesFor, refusalMessage, shapeMessage } from './describe';
import { LintPanel } from './LintPanel';
import { lintDefinition } from './lint';
import { PublishPanel } from './PublishPanel';
import { StatusInspector } from './StatusInspector';
import { StructureLists } from './StructureLists';
import { checkShape, type ParsedText, parseDefinitionText } from './shape';
import { TransitionInspector } from './TransitionInspector';
import { VersionHistory } from './VersionHistory';
import { type Selection, WorkflowDiagram } from './WorkflowDiagram';

export interface WorkflowEditorPageProps {
  workflowId: number;
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: WorkflowsClient;
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'forbidden' }
  | { status: 'missing' }
  | { status: 'loaded'; workflow: WorkflowView; statuses: Status[] };

type Panel = 'publish' | 'history' | 'discard' | null;

const NO_LOOKUPS: Lookups = { roles: null, groups: null, permissions: null };

/** The definition the editor starts from: the draft when there is one, else the published one. */
const baseOf = (workflow: WorkflowView) => (workflow.draft ?? workflow.published).definition;

/**
 * The workflow editor (#/admin/workflows/<id>; M1-030, WF-002): the draft in diagram or text
 * mode, the checks before publishing (WF-012), save, discard, publish with a mapping for the
 * statuses it drops, and the version history with restore. Changes stay in the page until
 * saved; the published version keeps running until the draft is published.
 */
export function WorkflowEditorPage({
  workflowId,
  client = workflowsClient,
}: WorkflowEditorPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const compact = useMediaQuery(COMPACT_QUERY);
  const id = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [working, setWorking] = useState<WorkflowDefinition | null>(null);
  const [mode, setMode] = useState<'diagram' | 'text'>('diagram');
  const [text, setText] = useState('');
  const [textProblem, setTextProblem] = useState<Exclude<ParsedText, { ok: true }> | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [focusTarget, setFocusTarget] = useState<
    'inspector' | 'name' | 'statuses' | 'transitions' | 'checks' | 'panel' | null
  >(null);
  const [lookups, setLookups] = useState<Lookups>(NO_LOOKUPS);
  const [panel, setPanel] = useState<Panel>(null);
  const [impact, setImpact] = useState<{
    loading: boolean;
    failed: boolean;
    impact: Impact | null;
  }>({ loading: false, failed: false, impact: null });
  const [versions, setVersions] = useState<{
    loading: boolean;
    failed: boolean;
    versions: VersionEntry[] | null;
  }>({ loading: false, failed: false, versions: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showDiagram, setShowDiagram] = useState(false);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const statusesHeading = useRef<HTMLHeadingElement>(null);
  const transitionsHeading = useRef<HTMLHeadingElement>(null);
  const checksHeading = useRef<HTMLHeadingElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const discardConfirm = useRef<HTMLButtonElement>(null);

  const refuse = useCallback(
    (e: unknown) => {
      if (expired(e)) return true;
      if (e instanceof ApiError && e.status === 403) {
        setLoad({ status: 'forbidden' });
        return true;
      }
      return false;
    },
    [expired],
  );

  const applyView = useCallback((workflow: WorkflowView, statuses?: Status[]) => {
    setLoad((current) => ({
      status: 'loaded',
      workflow,
      statuses: statuses ?? (current.status === 'loaded' ? current.statuses : []),
    }));
    const next = baseOf(workflow);
    setWorking(next);
    setText(formatDefinition(next));
    setTextProblem(null);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [workflow, statuses] = await Promise.all([client.get(workflowId), client.statuses()]);
        if (!live) return;
        applyView(workflow, statuses);
        const names = await client.lookups().catch(() => NO_LOOKUPS);
        if (live) setLookups(names);
      } catch (e) {
        if (!live || refuse(e)) return;
        setLoad({ status: e instanceof ApiError && e.status === 404 ? 'missing' : 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, workflowId, applyView, refuse]);

  const loaded = load.status === 'loaded' ? load : null;
  const workflow = loaded?.workflow ?? null;
  const statuses = loaded?.statuses ?? [];
  const stages = useMemo(() => new Map(statuses.map((s) => [s.id, s.stage])), [statuses]);
  const names = useMemo(() => namesFor(t, statuses, working), [t, statuses, working]);
  const issues = useMemo(
    () => (working && !textProblem ? lintDefinition(working, stages) : []),
    [working, textProblem, stages],
  );
  const shapeErrors = useMemo(() => {
    if (textProblem) {
      return textProblem.kind === 'syntax'
        ? [
            textProblem.at
              ? t('workflow.lint.syntax', textProblem.at)
              : t('workflow.lint.syntaxUnknown'),
          ]
        : textProblem.problems.map((p) => shapeMessage(t, p));
    }
    return working ? checkShape(working).map((p) => shapeMessage(t, p)) : [];
  }, [textProblem, working, t]);
  const blocked = shapeErrors.length > 0 || issues.some((i) => i.severity === 'error');
  const dirty =
    workflow !== null &&
    working !== null &&
    (textProblem !== null || !sameDefinition(working, baseOf(workflow)));

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Focus follows what just changed, once it is on screen.
  useEffect(() => {
    if (!focusTarget) return;
    const target = {
      inspector: inspectorHeading,
      statuses: statusesHeading,
      transitions: transitionsHeading,
      checks: checksHeading,
      panel: panelHeading,
      name: null,
    }[focusTarget];
    target?.current?.focus();
    if (focusTarget !== 'name') setFocusTarget(null);
  }, [focusTarget]);
  useEffect(() => {
    if (panel === 'discard') discardConfirm.current?.focus();
  }, [panel]);

  // The breadcrumb ends at the workflow's name, under Workflows (AD-28).
  useAdminTrail(workflow ? [{ label: t('common.value', { value: workflow.name }) }] : null);

  // A workflow that does not exist is a not-found page (D4, AD-30): Home and Search, no header.
  if (load.status === 'missing') return <NotFoundPage title={t('notFound.workflow')} />;

  if (load.status !== 'loaded' || !workflow || !working) {
    const notes = {
      loading: (
        <p role="status" className="page-note">
          {t('admin.workflow.loading')}
        </p>
      ),
      failed: (
        <p role="alert" className="form-error">
          {t('admin.workflow.failed')}
        </p>
      ),
      forbidden: <p className="page-note">{t('admin.workflows.forbidden')}</p>,
      loaded: null,
    };
    return (
      <section className="page page-full workflow-editor" aria-labelledby={`${id}-title`}>
        <p className="workflow-back">
          <a href={routeHref('#/admin/workflows')}>{t('admin.workflow.back')}</a>
        </p>
        <PageHeader
          titleId={`${id}-title`}
          title={t('admin.workflows.title')}
          {...(load.status === 'forbidden' ? {} : { purpose: t('purpose.workflowEditor') })}
        />
        {notes[load.status]}
      </section>
    );
  }

  const change = (next: WorkflowDefinition) => {
    setWorking(next);
    setMessage('');
  };
  const select = (next: Selection) => {
    setSelection(next);
    setFocusTarget('inspector');
  };
  const context = {
    statuses,
    transitions: working.transitions.map((x) => ({ id: x.id, name: x.name })),
    lookups,
  };

  const save = async (): Promise<WorkflowView | null> => {
    setError(null);
    setMessage('');
    if (blocked) {
      setError(t('admin.workflow.fixFirst'));
      setFocusTarget('checks');
      return null;
    }
    setBusy(true);
    try {
      const view = await client.saveDraft(workflow.id, working);
      applyView(view);
      setMessage(t('admin.workflow.saved', { version: view.draft?.version ?? 0 }));
      return view;
    } catch (e) {
      if (!refuse(e)) setError(refusalMessage(t, e, names) ?? t('admin.workflow.saveFailed'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startPublish = async () => {
    setPublishError(null);
    let view: WorkflowView | null = workflow;
    if (dirty) view = await save();
    else if (blocked) {
      setError(t('admin.workflow.fixFirst'));
      setFocusTarget('checks');
      return;
    }
    if (!view?.draft) return;
    setPanel('publish');
    setImpact({ loading: true, failed: false, impact: null });
    setFocusTarget('panel');
    try {
      setImpact({ loading: false, failed: false, impact: await client.impact(view.id) });
    } catch (e) {
      if (!refuse(e)) setImpact({ loading: false, failed: true, impact: null });
    }
  };

  const publish = async (statusMapping: Record<string, number>) => {
    setBusy(true);
    setPublishError(null);
    try {
      const view = await client.publish(workflow.id, statusMapping);
      applyView(view);
      setPanel(null);
      setMessage(t('admin.workflow.publishPanel.published', { version: view.published.version }));
      publishButton.current?.focus();
    } catch (e) {
      if (!refuse(e)) {
        setPublishError(refusalMessage(t, e, names) ?? t('admin.workflow.saveFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      if (workflow.draft) {
        await client.discardDraft(workflow.id);
        applyView(await client.get(workflow.id));
      } else {
        applyView(workflow);
      }
      setPanel(null);
      setSelection(null);
      setMessage(t('admin.workflow.discarded'));
    } catch (e) {
      if (!refuse(e)) setError(refusalMessage(t, e, names) ?? t('admin.workflows.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async () => {
    if (panel === 'history') {
      setPanel(null);
      return;
    }
    setPanel('history');
    setFocusTarget('panel');
    setVersions({ loading: true, failed: false, versions: null });
    try {
      setVersions({ loading: false, failed: false, versions: await client.versions(workflow.id) });
    } catch (e) {
      if (!refuse(e)) setVersions({ loading: false, failed: true, versions: null });
    }
  };

  const restore = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      const view = await client.restore(workflow.id, version);
      applyView(view);
      setSelection(null);
      setMessage(t('admin.workflow.versions.restored', { version }));
      setVersions({ loading: false, failed: false, versions: await client.versions(workflow.id) });
    } catch (e) {
      if (!refuse(e)) {
        setError(refusalMessage(t, e, names, version) ?? t('admin.workflows.actionFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'diagram' | 'text') => {
    if (next === mode) return;
    setError(null);
    if (next === 'text') {
      setText(formatDefinition(working));
      setTextProblem(null);
      setMode('text');
      return;
    }
    if (textProblem) {
      setError(t('admin.workflow.fixTextFirst'));
      setFocusTarget('checks');
      return;
    }
    setMode('diagram');
  };

  const editText = (next: string) => {
    setText(next);
    setMessage('');
    const parsed = parseDefinitionText(next);
    if (parsed.ok) {
      setWorking(parsed.definition);
      setTextProblem(null);
    } else {
      setTextProblem(parsed);
    }
  };

  const addStatusToWorkflow = async (statusId: number) => {
    setError(null);
    let completedId: number | null = null;
    if (addingNeedsCloseReason(working, statusId, statuses)) {
      setBusy(true);
      try {
        completedId = await client.completedReason(workflow.id);
      } catch (e) {
        if (!refuse(e)) {
          setError(t('admin.workflow.status.addFailed', { name: names.status(statusId) }));
        }
        return;
      } finally {
        setBusy(false);
      }
    }
    // The request may have let an edit in, so this builds on what is there now.
    setWorking(
      (current) =>
        current &&
        addStatusFreely(
          current,
          statusId,
          statuses,
          completedId,
          transitionIdsOf(workflow.published.definition, workflow.draft?.definition),
        ),
    );
    setMessage(t('admin.workflow.status.added', { name: names.status(statusId) }));
  };

  // A default workflow's draft saved before free moving still has the seeded steps nobody chose
  // (T-234; WF-008): the editor says so and offers the free moves the published version has.
  const seeded = workflow.isDefault && workflow.draft !== null && strictSeedSteps(working) !== null;
  const freeSeed = async () => {
    setError(null);
    let completedId: number | null = null;
    if (freeingSeedNeedsCloseReason(working, statuses)) {
      setBusy(true);
      try {
        completedId = await client.completedReason(workflow.id);
      } catch (e) {
        if (!refuse(e)) setError(t('admin.workflow.seed.failed'));
        return;
      } finally {
        setBusy(false);
      }
    }
    // The request may have let an edit in, so this builds on what is there now.
    setWorking(
      (current) =>
        current &&
        freeingSeed(
          current,
          statuses,
          completedId,
          transitionIdsOf(workflow.published.definition, workflow.draft?.definition),
        ),
    );
    setSelection(null);
    setMessage(t('admin.workflow.seed.freed'));
    setFocusTarget('transitions');
  };

  const newTransition = (from?: number) => {
    const ids = statusIdsOf(working);
    const source = from ?? (selection?.kind === 'status' ? selection.id : working.initialStatusId);
    const transitionId = nextTransitionId(
      working,
      transitionIdsOf(workflow.published.definition, workflow.draft?.definition),
    );
    const created: Transition = {
      id: transitionId,
      name: t('admin.workflow.newTransition'),
      from: [source],
      to: ids.find((s) => s !== source) ?? source,
    };
    change(addTransition(working, created));
    setSelection({ kind: 'transition', id: transitionId });
    setFocusTarget('name');
  };

  const selectedTransition =
    selection?.kind === 'transition'
      ? working.transitions.find((x) => x.id === selection.id)
      : undefined;
  const selectedStatus =
    selection?.kind === 'status' && working.statuses.some((s) => s.statusId === selection.id)
      ? selection.id
      : undefined;
  const flagged = {
    statuses: new Set(issues.flatMap((i) => ('statusId' in i ? [i.statusId] : []))),
    transitions: new Set(issues.flatMap((i) => ('transitionId' in i ? [i.transitionId] : []))),
  };

  let inspector: ReactNode = null;
  if (selectedTransition) {
    inspector = (
      <TransitionInspector
        key={selectedTransition.id}
        transition={selectedTransition}
        definition={working}
        names={names}
        context={context}
        headingRef={inspectorHeading}
        focusName={focusTarget === 'name'}
        onChange={(next) => change(updateTransition(working, selectedTransition.id, () => next))}
        onRulesChange={(rules: RuleDef[]) =>
          change(withRules(working, selectedTransition.id, rules))
        }
        onDelete={() => {
          const name = names.transition(selectedTransition.id);
          change(removeTransition(working, selectedTransition.id));
          setSelection(null);
          setMessage(t('admin.workflow.transition.deleted', { name }));
          setFocusTarget('transitions');
        }}
      />
    );
  } else if (selectedStatus !== undefined) {
    inspector = (
      <StatusInspector
        key={selectedStatus}
        statusId={selectedStatus}
        stage={stages.get(selectedStatus)}
        definition={working}
        names={names}
        headingRef={inspectorHeading}
        onMakeInitial={() => {
          change(setInitialStatus(working, selectedStatus));
          setMessage(
            t('admin.workflow.status.madeInitial', { name: names.status(selectedStatus) }),
          );
        }}
        onAddTransition={() => newTransition(selectedStatus)}
        onRemove={() => {
          const name = names.status(selectedStatus);
          change(removeStatus(working, selectedStatus));
          setSelection(null);
          setMessage(t('admin.workflow.status.removed', { name }));
          setFocusTarget('statuses');
        }}
      />
    );
  }

  return (
    <section className="page page-full workflow-editor" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('common.value', { value: workflow.name })}
        titleText={workflow.name}
        purpose={t('purpose.workflowEditor')}
        about={t('admin.workflow.about')}
      />
      <p className="token-meta">
        <span>{t('admin.workflow.published', { version: workflow.published.version })}</span>
        <span>
          {workflow.draft
            ? t('admin.workflow.draft', { version: workflow.draft.version })
            : t('admin.workflow.noDraft')}
        </span>
        <span>
          {t('admin.workflow.tracks', {
            count: workflow.tracks.length,
            keys: workflow.tracks.map((x) => x.key).join(', '),
          })}
        </span>
      </p>
      <WorkflowDetails
        workflow={workflow}
        client={client}
        refuse={refuse}
        onSaved={(view) =>
          setLoad((current) =>
            current.status === 'loaded'
              ? {
                  ...current,
                  workflow: { ...current.workflow, name: view.name, description: view.description },
                }
              : current,
          )
        }
      />

      {seeded && mode === 'diagram' && (
        <div className="workflow-seed">
          <p>{t('admin.workflow.seed.note')}</p>
          <div className="form-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void freeSeed()}
            >
              {t('admin.workflow.seed.free')}
            </button>
          </div>
        </div>
      )}

      <div className="workflow-toolbar">
        <fieldset className="filter-chips">
          <legend className="visually-hidden">{t('admin.workflow.mode')}</legend>
          <button
            type="button"
            className="filter-chip"
            aria-pressed={mode === 'diagram'}
            onClick={() => switchMode('diagram')}
          >
            {t('admin.workflow.diagramMode')}
          </button>
          <button
            type="button"
            className="filter-chip"
            aria-pressed={mode === 'text'}
            onClick={() => switchMode('text')}
          >
            {t('admin.workflow.textMode')}
          </button>
        </fieldset>
        <div className="form-actions">
          <button
            type="button"
            className="button-primary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {t('admin.workflow.save')}
          </button>
          <button
            ref={publishButton}
            type="button"
            className="button-secondary"
            data-tutorial="workflow-publish"
            disabled={busy || (!dirty && !workflow.draft)}
            onClick={() => void startPublish()}
          >
            {t('admin.workflow.publish')}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || (!dirty && !workflow.draft)}
            aria-expanded={panel === 'discard'}
            onClick={() => setPanel(panel === 'discard' ? null : 'discard')}
          >
            {t('admin.workflow.discard')}
          </button>
          <button
            type="button"
            className="button-secondary"
            aria-expanded={panel === 'history'}
            onClick={() => void openHistory()}
          >
            {t('admin.workflow.history')}
          </button>
          {dirty && <span className="token-badge">{t('admin.workflow.unsaved')}</span>}
        </div>
      </div>
      <p role="status" className="form-status">
        {message}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}

      {panel === 'discard' && (
        <div className="token-confirm">
          <p id={`${id}-discard`}>{t('admin.workflow.confirmDiscard')}</p>
          <div className="token-confirm-actions">
            <button
              ref={discardConfirm}
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => void discard()}
            >
              {t('admin.workflow.confirmDiscardButton')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setPanel(null)}>
              {t('admin.workflow.cancel')}
            </button>
          </div>
        </div>
      )}
      {panel === 'publish' && workflow.draft && (
        <PublishPanel
          version={workflow.draft.version}
          impact={impact.impact}
          loading={impact.loading}
          failed={impact.failed}
          warnings={issues.filter((i) => i.severity === 'warning')}
          names={names}
          draftStatusIds={statusIdsOf(working)}
          freeMoves={
            working.transitions.length === 0 &&
            Object.keys(working.rules ?? {}).length === 0 &&
            !working.board
          }
          busy={busy}
          error={publishError}
          headingRef={panelHeading}
          onPublish={(mapping) => void publish(mapping)}
          onCancel={() => {
            setPanel(null);
            publishButton.current?.focus();
          }}
        />
      )}
      {panel === 'history' && (
        <VersionHistory
          versions={versions.versions}
          loading={versions.loading}
          failed={versions.failed}
          replacesWork={dirty || workflow.draft !== null}
          busy={busy}
          headingRef={panelHeading}
          onRestore={(version) => void restore(version)}
        />
      )}

      <LintPanel
        issues={issues}
        errors={shapeErrors}
        names={names}
        headingRef={checksHeading}
        onShow={
          mode === 'diagram'
            ? (target) => {
                if (target) select(target);
              }
            : undefined
        }
      />

      {mode === 'diagram' ? (
        <div className={`workflow-workspace${inspector ? ' workflow-workspace-split' : ''}`}>
          <div className="workflow-main">
            {!inspector && <p className="page-note">{t('admin.workflow.nothingSelected')}</p>}
            {compact && (
              <button
                type="button"
                className="button-secondary"
                aria-expanded={showDiagram}
                aria-controls={`${id}-diagram`}
                onClick={() => setShowDiagram((v) => !v)}
              >
                {t(showDiagram ? 'admin.workflow.hideDiagram' : 'admin.workflow.showDiagram')}
              </button>
            )}
            <div id={`${id}-diagram`} hidden={compact && !showDiagram}>
              {(!compact || showDiagram) && (
                <WorkflowDiagram
                  definition={working}
                  stages={stages}
                  names={names}
                  selection={selection}
                  flagged={flagged}
                  onSelect={select}
                />
              )}
            </div>
            <StructureLists
              definition={working}
              statuses={statuses}
              stages={stages}
              names={names}
              issues={issues}
              selection={selection}
              onSelect={select}
              statusesHeadingRef={statusesHeading}
              transitionsHeadingRef={transitionsHeading}
              onAddStatus={addStatusToWorkflow}
              onAddTransition={() => newTransition()}
            />
          </div>
          {inspector && <div className="workflow-inspector">{inspector}</div>}
        </div>
      ) : (
        <DefinitionText
          text={text}
          invalid={textProblem !== null}
          statuses={legendOf(statuses, statusIdsOf(working))}
          onChange={editText}
        />
      )}
    </section>
  );
}

/** The workflow's name and description, behind a disclosure. */
function WorkflowDetails({
  workflow,
  client,
  refuse,
  onSaved,
}: {
  workflow: WorkflowView;
  client: WorkflowsClient;
  refuse: (e: unknown) => boolean;
  onSaved: (view: WorkflowView) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState('');
  // The form is drawn only while the disclosure is open.
  const [open, setOpen] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone('');
    if (name.trim() === '') {
      setError(t('admin.workflows.form.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await client.update(workflow.id, { name: name.trim(), description }));
      setDone(t('admin.workflow.detailsSaved'));
    } catch (e) {
      if (refuse(e)) return;
      setError(
        e instanceof ApiError && e.code === 'name_taken'
          ? t('admin.workflows.form.nameTaken')
          : t('admin.workflows.actionFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="workflow-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="admin-disclosure">{t('admin.workflow.details')}</summary>
      {open && (
        <form className="form" onSubmit={submit} aria-labelledby={`${id}-summary`} noValidate>
          <span id={`${id}-summary`} hidden>
            {t('admin.workflow.details')}
          </span>
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
          <div className="form-field">
            <label htmlFor={`${id}-description`}>{t('admin.workflows.form.description')}</label>
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
            <button type="submit" className="button-secondary" disabled={busy}>
              {t('admin.workflow.detailsSave')}
            </button>
          </div>
          <p role="status" className="form-status">
            {done}
          </p>
        </form>
      )}
    </details>
  );
}
