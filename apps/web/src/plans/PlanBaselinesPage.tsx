import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { redirectRoute, routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import { type PlanView, planHref } from './address';
import { BaselineCompare } from './BaselineCompare';
import type { BaselineClient, BaselineList, BaselineRow, CaptureOutcome } from './baselineClient';
import type { Outcome } from './scenarioClient';

export interface PlanBaselinesPageProps {
  planId: number;
  planName: string;
  client: BaselineClient;
  /** The page's view: its filters, the open scenario and the baseline compared. */
  view: PlanView;
  /** The scenario open on the page, whose days a capture takes; Live without one. */
  scenario: { id: number; name: string } | null;
  /** Today: the capture's name is prefilled with it. */
  now?: () => Date;
}

/** The words of a refused baseline write. */
const REFUSED: Record<string, MessageId> = {
  too_many_baselines: 'baselines.refused.tooMany',
  plan_too_large: 'baselines.refused.tooLarge',
  version_conflict: 'baselines.refused.conflict',
  forbidden: 'baselines.refused.forbidden',
  not_found: 'baselines.refused.gone',
  invalid_fields: 'baselines.refused.gone',
};

/**
 * A plan's baselines (T-089a; PLN-011; ADR-122 stage 9): each with where its days came from
 * ("From Live" or "From Faster"), how many tickets it holds, and who captured it when; Compare
 * opens it against the days now below the list, kept in the page's address. The plan's editors
 * get Capture baseline… (a dialog with the name prefilled and the source said: Live, or the
 * scenario open on the page), Rename and Delete; at the limit the button is off, with the reason
 * in words. Everyone who sees the plan reads them. Every dialog is a sheet on a phone.
 */
export function PlanBaselinesPage({
  planId,
  planName,
  client,
  view,
  scenario,
  now = () => new Date(),
}: PlanBaselinesPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [list, setList] = useState<BaselineList | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [renaming, setRenaming] = useState<BaselineRow | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Deleted: its row goes once the list is read again, so the list's heading takes focus then.
  const focusHeading = useRef(false);
  const changed = () => setVersion((v) => v + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after each change, by `version`
  useEffect(() => {
    let live = true;
    client.list(planId).then(
      (l) => {
        if (!live) return;
        setList(l);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, planId, version]);
  useEffect(() => {
    if (!list || !focusHeading.current) return;
    focusHeading.current = false;
    heading.current?.focus();
  }, [list]);

  if (failed && !list) {
    return (
      <p className="board-problem" role="alert">
        {t('baselines.listFailed')}
      </p>
    );
  }
  if (!list) return <p className="report-loading">{t('reports.loading')}</p>;

  const full = list.baselines.length >= list.limits.baselines;
  const made = (at: string) =>
    intl.formatDate(at, { day: 'numeric', month: 'short', year: 'numeric' });
  const refusal = (r: { code: string; limit?: number }) =>
    t(REFUSED[r.code] ?? 'baselines.refused.other', {
      count: r.limit ?? (r.code === 'plan_too_large' ? list.limits.tickets : list.limits.baselines),
    });
  const opened =
    view.baseline === undefined
      ? null
      : (list.baselines.find((b) => b.id === view.baseline) ?? null);
  const hrefWith = (baseline: number | undefined) =>
    planHref(planId, 'baselines', { ...view, baseline });

  const remove = async (b: BaselineRow) => {
    setProblem(null);
    const r = await client.remove(planId, b.id, b.version).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? refusal(r) : t('baselines.refused.other'));
      if (r?.code === 'version_conflict') changed();
      throw new Error('refused');
    }
    setStatus(t('baselines.delete.done', { name: b.name }));
    focusHeading.current = true;
    if (view.baseline === b.id) redirectRoute(hrefWith(undefined));
    changed();
  };

  return (
    <section className="plan-scenarios" aria-labelledby={`${id}-title`}>
      <div className="plan-scenarios-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {t('baselines.title')}
        </h2>
        {list.editable && (
          <div className="scenario-item-actions">
            <button
              type="button"
              className="button-primary"
              disabled={full}
              aria-describedby={full ? `${id}-full` : undefined}
              onClick={() => setCapturing(true)}
            >
              {t('baselines.capture')}
            </button>
          </div>
        )}
      </div>
      <p className="board-hint">{t('baselines.intro')}</p>
      {full && list.editable && (
        <p id={`${id}-full`} className="board-hint">
          {t('baselines.full', { count: list.limits.baselines })}
        </p>
      )}
      {!list.editable && <p className="board-hint">{t('baselines.readOnly')}</p>}
      <p className="board-hint scenario-status" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {list.baselines.length === 0 ? (
        <EmptyState compact title={t('baselines.empty')}>
          {t('baselines.emptyBody')}
        </EmptyState>
      ) : (
        <ul className="scenario-list">
          {list.baselines.map((b) => (
            <li key={b.id} className="glass-card scenario-item">
              <h3>{b.name}</h3>
              <p>
                {b.source === 'live'
                  ? t('baselines.fromLive')
                  : t('baselines.fromScenario', { name: b.scenarioName ?? '' })}
                {' · '}
                {t('baselines.tickets', { count: b.tickets })}
              </p>
              <p className="scenario-meta">
                {t('baselines.madeBy', { name: b.createdBy.name, when: made(b.createdAt) })}
              </p>
              <div className="scenario-item-actions">
                <a
                  className="button-secondary"
                  href={routeHref(hrefWith(b.id))}
                  aria-current={view.baseline === b.id ? 'true' : undefined}
                  aria-label={t('baselines.open.label', { name: b.name })}
                >
                  {t('baselines.open')}
                </a>
                {list.editable && (
                  <button
                    type="button"
                    className="button-secondary"
                    aria-label={t('baselines.rename.label', { name: b.name })}
                    onClick={() => setRenaming(b)}
                  >
                    {t('baselines.rename')}
                  </button>
                )}
                {list.editable && (
                  <DangerAction
                    label={t('baselines.delete')}
                    name={t('baselines.delete.label', { name: b.name })}
                    outcome={t('baselines.delete.ask', { name: b.name })}
                    confirmLabel={t('baselines.delete.label', { name: b.name })}
                    onConfirm={() => remove(b)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {view.baseline !== undefined && !opened && (
        <p className="board-hint">{t('baselines.refused.gone')}</p>
      )}
      {opened && (
        <BaselineCompare
          key={opened.id}
          planId={planId}
          planName={planName}
          client={client}
          baseline={opened}
          filters={view.filters}
          scenario={view.scenario}
          closeHref={hrefWith(undefined)}
          now={now}
        />
      )}
      {capturing && (
        <CaptureBaselineDialog
          defaultName={t('baselines.capture.default', {
            day: intl.formatDate(now(), { day: 'numeric', month: 'short' }),
          })}
          scenario={scenario}
          onCapture={(name) => client.capture(planId, name, scenario?.id)}
          refusal={refusal}
          onDone={(b) => {
            setCapturing(false);
            setStatus(t('baselines.capture.done', { name: b.name, count: b.tickets }));
            changed();
          }}
          onClose={() => setCapturing(false)}
        />
      )}
      {renaming && (
        <RenameBaselineDialog
          baseline={renaming}
          onRename={(name) => client.rename(planId, renaming.id, name, renaming.version)}
          refusal={refusal}
          onDone={(b) => {
            setRenaming(null);
            setStatus(t('baselines.rename.done', { name: b.name }));
            changed();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </section>
  );
}

interface NameDialogProps {
  title: string;
  intro?: string;
  initial: string;
  saveLabel: string;
  onSave: (name: string) => Promise<CaptureOutcome | Outcome<BaselineRow>>;
  refusal: (r: { code: string; limit?: number }) => string;
  onDone: (baseline: BaselineRow) => void;
  onClose: () => void;
}

/** A dialog that asks for a baseline's name; a refusal is said in its place. */
function NameDialog({
  title,
  intro,
  initial,
  saveLabel,
  onSave,
  refusal,
  onDone,
  onClose,
}: NameDialogProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setMissing(true);
      setProblem(t('baselines.nameRequired'));
      return;
    }
    setBusy(true);
    setMissing(false);
    setProblem(null);
    const done = await onSave(trimmed).catch(() => null);
    setBusy(false);
    if (!done) setProblem(t('baselines.refused.other'));
    else if (!done.ok) setProblem(refusal(done));
    else onDone(done.value);
  };
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('baselines.cancel')}
      focusFirstField
      className="scenario-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        {intro && <p className="board-hint">{intro}</p>}
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('baselines.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            aria-invalid={missing || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {saveLabel}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('baselines.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Capture baseline: the name prefilled with today, and where its days come from, in words. */
function CaptureBaselineDialog({
  defaultName,
  scenario,
  onCapture,
  refusal,
  onDone,
  onClose,
}: {
  defaultName: string;
  scenario: { id: number; name: string } | null;
  onCapture: (name: string) => Promise<CaptureOutcome>;
  refusal: (r: { code: string; limit?: number }) => string;
  onDone: (baseline: BaselineRow) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <NameDialog
      title={t('baselines.capture.title')}
      intro={`${t('baselines.capture.intro')} ${
        scenario
          ? t('baselines.capture.sourceScenario', { name: scenario.name })
          : t('baselines.capture.sourceLive')
      }`}
      initial={defaultName}
      saveLabel={t('baselines.capture.save')}
      onSave={onCapture}
      refusal={refusal}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

/** Renaming a baseline; a name changed by someone meanwhile is refused and said. */
function RenameBaselineDialog({
  baseline,
  onRename,
  refusal,
  onDone,
  onClose,
}: {
  baseline: BaselineRow;
  onRename: (name: string) => Promise<Outcome<BaselineRow>>;
  refusal: (r: { code: string; limit?: number }) => string;
  onDone: (baseline: BaselineRow) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <NameDialog
      title={t('baselines.rename.title', { name: baseline.name })}
      initial={baseline.name}
      saveLabel={t('baselines.rename.save')}
      onSave={onRename}
      refusal={refusal}
      onDone={onDone}
      onClose={onClose}
    />
  );
}
