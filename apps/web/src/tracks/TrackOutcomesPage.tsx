import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { typeName } from '../shell/seededNames';
import { TypeIcon } from '../shell/TicketIcons';
import { ProgressBar, percentOf } from '../tickets/tools/Progress';
import type { Transition } from '../tickets/view/client';
import { FILLABLE_FIELDS, TransitionForm } from '../tickets/view/TransitionForm';
import { refusalMessage, type TransitionRefusal } from '../workflow/refusal';
import {
  type OutcomeRights,
  type TrackClient,
  type TrackOutcome,
  type TrackOutcomes,
  trackClient,
} from './client';
import { type OutcomeEdit, type OutcomeManager, outcomeManager } from './outcomeManager';

export interface TrackOutcomesPageProps {
  trackKey: string;
  client?: TrackClient;
  /** The ticket routes the manage panel calls (T-082). */
  manager?: OutcomeManager;
}

const NOTHING: OutcomeRights = {
  create: false,
  edit: false,
  schedule: false,
  close: false,
  types: [],
};

/** What a row is doing in the manage panel: being edited, or being closed. */
type Working =
  | { kind: 'edit'; id: number }
  | { kind: 'close'; id: number; ways: Transition[]; asking: Transition | null };

/**
 * A track's outcomes and how far along each is (AGL-024): the closed tickets under it of all those
 * the person may see, as a bar and in numbers, with its status and dates. Open ones come first, in
 * their planned order; a page holds 100 and the next comes on asking. Each leads to its ticket,
 * which opens over the page.
 *
 * Every track type, Kanban included, manages its outcomes here (T-082): **Manage outcomes** opens
 * a panel to create one, and gives each row its tools to edit the summary and dates, move it up or
 * down among the open ones, and close it. They are offered as the person's roles allow, and each is
 * the ticket route the ticket page and the backlog use, so the same checks and events apply.
 */
export function TrackOutcomesPage({
  trackKey,
  client = trackClient,
  manager = outcomeManager,
}: TrackOutcomesPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [read, setRead] = useState<TrackOutcomes | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [managing, setManaging] = useState(false);
  const [working, setWorking] = useState<Working | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Asks the panel to put the focus in its new outcome's summary. */
  const [focusNew, setFocusNew] = useState(0);

  useEffect(() => {
    let live = true;
    client.outcomes(trackKey).then(
      (found) => {
        if (live) setRead(found);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  const more = async () => {
    if (!read?.next || busy) return;
    setBusy(true);
    setMoreFailed(false);
    try {
      const page = await client.outcomes(trackKey, read.next);
      setRead({ ...page, outcomes: [...read.outcomes, ...page.outcomes] });
    } catch {
      setMoreFailed(true);
    } finally {
      setBusy(false);
    }
  };

  /** Why a change did not go through, in the words of the ticket page. */
  const refusal = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        const body = error.body as { error?: string; fields?: Record<string, string> } | null;
        if (error.status === 403) return t('track.outcomes.manage.forbidden');
        if (body?.error === 'transition_refused' && (body as Partial<TransitionRefusal>).by) {
          return refusalMessage(t, body as unknown as TransitionRefusal);
        }
        if (body?.error === 'transition_refused' || body?.error === 'transition_unavailable') {
          return t('ticketView.problem.transition');
        }
        if (body?.fields) {
          return t('ticketView.problem.fields', { fields: Object.keys(body.fields).join(', ') });
        }
      }
      return t('ticketView.problem.other');
    },
    [t],
  );

  /** Runs a change, then reads the list again from the top, as the server now orders it. */
  const change = async (work: () => Promise<string>) => {
    if (saving) return false;
    setSaving(true);
    setProblem(null);
    setStatus(null);
    try {
      const done = await work();
      setRead(await client.outcomes(trackKey));
      setWorking(null);
      setStatus(done);
      return true;
    } catch (error) {
      setProblem(refusal(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const day = (date: string) =>
    intl.formatDate(new Date(`${date}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const types = read?.outcomeTypes ?? [];
  const rights = read?.manage ?? NOTHING;
  const mayManage = rights.create || rights.edit || rights.schedule || rights.close;
  const open = (read?.outcomes ?? []).filter((o) => o.status.stage !== 'closed');

  const closeWith = (outcome: TrackOutcome, way: Transition, fields?: Record<string, unknown>) =>
    change(async () => {
      await manager.transition(outcome.id, way.id, fields);
      return t('track.outcomes.manage.closed', { key: outcome.key });
    });
  const startClosing = async (outcome: TrackOutcome) => {
    setProblem(null);
    setStatus(null);
    let ways: Transition[];
    try {
      ways = (await manager.transitions(outcome.id)).filter((w) => w.to.stage === 'closed');
    } catch (error) {
      setProblem(refusal(error));
      return;
    }
    const usable = ways.filter((w) => w.layout.every((f) => FILLABLE_FIELDS.includes(f)));
    if (usable.length === 0) {
      setProblem(
        t(ways.length === 0 ? 'track.outcomes.manage.noClose' : 'track.outcomes.manage.onPage', {
          key: outcome.key,
        }),
      );
      return;
    }
    const only = usable.length === 1 ? usable[0] : undefined;
    // One way with nothing to ask closes it at once, as the ticket page's status control does.
    if (only && only.layout.length === 0) {
      await closeWith(outcome, only);
      return;
    }
    setWorking({ kind: 'close', id: outcome.id, ways: usable, asking: only ?? null });
  };

  const move = (outcome: TrackOutcome, direction: 'up' | 'down') => {
    const at = open.findIndex((o) => o.id === outcome.id);
    const next = open[direction === 'up' ? at - 1 : at + 1];
    if (!next) return;
    void change(async () => {
      await manager.rank(outcome.id, direction === 'up' ? { before: next.id } : { after: next.id });
      return t(
        direction === 'up' ? 'track.outcomes.manage.movedUp' : 'track.outcomes.manage.movedDown',
        { key: outcome.key },
      );
    });
  };

  return (
    <section aria-labelledby={`${id}-title`} className="page track-outcomes">
      <PageHeader
        titleId={`${id}-title`}
        title={t('track.outcomes.title')}
        // The track named above the section's title, as on its other pages (D26).
        eyebrow={read?.track.name ?? trackKey}
        purpose={t('track.outcomes.purpose')}
        about={t('track.outcomes.about')}
        actions={
          mayManage && (
            <button
              type="button"
              className="button-secondary"
              aria-expanded={managing}
              aria-controls={`${id}-manage`}
              onClick={() => {
                setManaging((on) => !on);
                setWorking(null);
                setProblem(null);
                setStatus(null);
              }}
            >
              {t('track.outcomes.manage.toggle')}
            </button>
          )
        }
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('track.outcomes.failed')}
        </p>
      )}
      {!read && !failed && <p className="page-note">{t('boards.loading')}</p>}
      {managing && read && (
        <ManagePanel
          id={`${id}-manage`}
          rights={rights}
          saving={saving}
          focusNew={focusNew}
          onCreate={(typeId, summary) =>
            change(async () => {
              const made = await manager.create(read.track.key, typeId, summary);
              return t('track.outcomes.manage.created', { key: made.key });
            })
          }
        />
      )}
      <p className="form-status" role="status">
        {status}
      </p>
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      {read && read.outcomes.length === 0 && (
        <EmptyState
          title={t('track.outcomes.emptyTitle')}
          action={
            rights.create ? (
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setManaging(true);
                  setFocusNew((n) => n + 1);
                }}
              >
                {t('track.outcomes.manage.new')}
              </button>
            ) : (
              types.length > 0 && (
                <a className="button-secondary" href={routeHref('#/create')}>
                  {t('track.outcomes.create')}
                </a>
              )
            )
          }
        >
          {t('track.outcomes.empty')}{' '}
          {types.length > 0
            ? t(rights.create ? 'track.outcomes.howToManage' : 'track.outcomes.howTo', {
                types: intl.formatList(
                  types.map((name) => typeName(t, name)),
                  { type: 'disjunction' },
                ),
              })
            : t('track.outcomes.howToNone')}
        </EmptyState>
      )}
      {read && read.outcomes.length > 0 && (
        <ul className="glass-card track-outcomes-list" aria-labelledby={`${id}-title`}>
          {read.outcomes.map((outcome) => {
            const at = open.findIndex((o) => o.id === outcome.id);
            const row = working?.id === outcome.id ? working : null;
            return (
              <OutcomeRow key={outcome.id} outcome={outcome} day={day}>
                {managing && (
                  <OutcomeTools
                    outcome={outcome}
                    rights={rights}
                    saving={saving}
                    first={at <= 0}
                    last={at === -1 || at === open.length - 1}
                    working={row}
                    manager={manager}
                    onEdit={() => {
                      setProblem(null);
                      setWorking({ kind: 'edit', id: outcome.id });
                    }}
                    onSave={(edit) =>
                      change(async () => {
                        await manager.edit(outcome.id, edit);
                        return t('track.outcomes.manage.saved', { key: outcome.key });
                      })
                    }
                    onMove={(direction) => move(outcome, direction)}
                    onClose={() => void startClosing(outcome)}
                    onCloseWith={(way, fields) => void closeWith(outcome, way, fields)}
                    onAsk={(way) => row?.kind === 'close' && setWorking({ ...row, asking: way })}
                    onCancel={() => setWorking(null)}
                  />
                )}
              </OutcomeRow>
            );
          })}
        </ul>
      )}
      {moreFailed && (
        <p className="form-error" role="alert">
          {t('track.outcomes.moreFailed')}
        </p>
      )}
      {read?.next && (
        <button
          type="button"
          className="button-secondary track-outcomes-more"
          aria-disabled={busy || undefined}
          onClick={() => void more()}
        >
          {t('track.outcomes.more')}
        </button>
      )}
    </section>
  );
}

/** The manage panel's head: what it is for, and a new outcome when the person may make one. */
function ManagePanel({
  id,
  rights,
  saving,
  focusNew,
  onCreate,
}: {
  id: string;
  rights: OutcomeRights;
  saving: boolean;
  /** A new number puts the focus in the summary. */
  focusNew: number;
  onCreate: (typeId: number, summary: string) => Promise<boolean>;
}) {
  const t = useT();
  const field = useId();
  const summaryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusNew > 0) summaryInput.current?.focus();
  }, [focusNew]);
  const [summary, setSummary] = useState('');
  const [typeId, setTypeId] = useState(rights.types[0]?.id ?? 0);
  const [missing, setMissing] = useState(false);
  return (
    <section id={id} className="glass-card track-outcomes-manage" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('track.outcomes.manage.title')}</h2>
      <p className="page-note">{t('track.outcomes.manage.note')}</p>
      {rights.create && (
        <form
          className="track-outcomes-new"
          aria-label={t('track.outcomes.manage.new')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (summary.trim() === '') {
              setMissing(true);
              return;
            }
            setMissing(false);
            void onCreate(typeId, summary.trim()).then((made) => {
              if (made) setSummary('');
            });
          }}
        >
          <div className="form-field">
            <label htmlFor={`${field}-summary`}>{t('track.outcomes.manage.summary')}</label>
            <input
              ref={summaryInput}
              id={`${field}-summary`}
              value={summary}
              maxLength={255}
              aria-invalid={missing || undefined}
              aria-describedby={missing ? `${field}-missing` : undefined}
              onChange={(event) => setSummary(event.target.value)}
            />
            {missing && (
              <p id={`${field}-missing`} className="form-error">
                {t('track.outcomes.manage.summaryMissing')}
              </p>
            )}
          </div>
          {rights.types.length > 1 && (
            <div className="form-field">
              <label htmlFor={`${field}-type`}>{t('track.outcomes.manage.type')}</label>
              <select
                id={`${field}-type`}
                value={typeId}
                onChange={(event) => setTypeId(Number(event.target.value))}
              >
                {rights.types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {typeName(t, type.name)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" className="button-primary" aria-disabled={saving || undefined}>
            {t('track.outcomes.manage.create')}
          </button>
        </form>
      )}
    </section>
  );
}

/** One row's tools in the manage panel: edit, move up or down, close. */
function OutcomeTools({
  outcome,
  rights,
  saving,
  first,
  last,
  working,
  manager,
  onEdit,
  onSave,
  onMove,
  onClose,
  onCloseWith,
  onAsk,
  onCancel,
}: {
  outcome: TrackOutcome;
  rights: OutcomeRights;
  saving: boolean;
  first: boolean;
  last: boolean;
  working: Working | null;
  manager: OutcomeManager;
  onEdit: () => void;
  onSave: (edit: OutcomeEdit) => Promise<boolean>;
  onMove: (direction: 'up' | 'down') => void;
  onClose: () => void;
  onCloseWith: (way: Transition, fields?: Record<string, unknown>) => void;
  onAsk: (way: Transition) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const closed = outcome.status.stage === 'closed';
  if (working?.kind === 'edit') {
    return (
      <EditOutcome
        outcome={outcome}
        rights={rights}
        saving={saving}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }
  if (working?.kind === 'close') {
    if (working.asking) {
      return (
        <div className="track-outcome-tools">
          <TransitionForm
            transition={working.asking}
            client={manager}
            onRun={(fields) => working.asking && onCloseWith(working.asking, fields)}
            onCancel={onCancel}
          />
        </div>
      );
    }
    return (
      <fieldset className="track-outcome-tools">
        <legend>{t('track.outcomes.manage.closeHow', { key: outcome.key })}</legend>
        {working.ways.map((way) => (
          <button
            key={way.id}
            type="button"
            className="button-secondary"
            onClick={() => (way.layout.length > 0 ? onAsk(way) : onCloseWith(way))}
          >
            {way.name}
          </button>
        ))}
        <button type="button" className="button-quiet" onClick={onCancel}>
          {t('dashboards.cancel')}
        </button>
      </fieldset>
    );
  }
  const busy = saving || undefined;
  return (
    <fieldset className="track-outcome-tools">
      <legend className="visually-hidden">
        {t('track.outcomes.manage.tools', { key: outcome.key })}
      </legend>
      {(rights.edit || rights.schedule) && (
        <button type="button" className="button-quiet" aria-disabled={busy} onClick={onEdit}>
          {t('track.outcomes.manage.edit')}
        </button>
      )}
      {rights.schedule && !closed && !first && (
        <button
          type="button"
          className="button-quiet"
          aria-disabled={busy}
          onClick={() => onMove('up')}
        >
          {t('track.outcomes.manage.up')}
        </button>
      )}
      {rights.schedule && !closed && !last && (
        <button
          type="button"
          className="button-quiet"
          aria-disabled={busy}
          onClick={() => onMove('down')}
        >
          {t('track.outcomes.manage.down')}
        </button>
      )}
      {rights.close && !closed && (
        <button type="button" className="button-quiet" aria-disabled={busy} onClick={onClose}>
          {t('track.outcomes.manage.close')}
        </button>
      )}
    </fieldset>
  );
}

/** An outcome's summary and dates, each as the person's rights allow. */
function EditOutcome({
  outcome,
  rights,
  saving,
  onSave,
  onCancel,
}: {
  outcome: TrackOutcome;
  rights: OutcomeRights;
  saving: boolean;
  onSave: (edit: OutcomeEdit) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useT();
  const field = useId();
  const [summary, setSummary] = useState(outcome.summary);
  const [start, setStart] = useState(outcome.startDate ?? '');
  const [due, setDue] = useState(outcome.dueDate ?? '');
  return (
    <form
      className="track-outcome-tools track-outcome-edit"
      aria-label={t('track.outcomes.manage.editOf', { key: outcome.key })}
      onSubmit={(event) => {
        event.preventDefault();
        // Only what changed, so a right the person lacks is never asked for.
        const edit: OutcomeEdit = {};
        if (rights.edit && summary.trim() !== '' && summary.trim() !== outcome.summary) {
          edit.summary = summary.trim();
        }
        if (rights.schedule && (start || null) !== outcome.startDate)
          edit.startDate = start || null;
        if (rights.schedule && (due || null) !== outcome.dueDate) edit.dueDate = due || null;
        if (Object.keys(edit).length === 0) {
          onCancel();
          return;
        }
        void onSave(edit);
      }}
    >
      {rights.edit && (
        <div className="form-field">
          <label htmlFor={`${field}-summary`}>{t('track.outcomes.manage.summary')}</label>
          <input
            id={`${field}-summary`}
            value={summary}
            maxLength={255}
            onChange={(event) => setSummary(event.target.value)}
          />
        </div>
      )}
      {rights.schedule && (
        <>
          <div className="form-field">
            <label htmlFor={`${field}-start`}>{t('track.outcomes.manage.startDate')}</label>
            <input
              id={`${field}-start`}
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${field}-due`}>{t('track.outcomes.manage.dueDate')}</label>
            <input
              id={`${field}-due`}
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
          </div>
        </>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" aria-disabled={saving || undefined}>
          {t('track.outcomes.manage.save')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('dashboards.cancel')}
        </button>
      </div>
    </form>
  );
}

function OutcomeRow({
  outcome,
  day,
  children,
}: {
  outcome: TrackOutcome;
  day: (date: string) => string;
  children?: ReactNode;
}) {
  const t = useT();
  const { closed, total } = outcome.progress;
  const percent = percentOf(closed, total);
  return (
    <li className="track-outcome" data-stage={outcome.status.stage}>
      <div className="track-outcome-head">
        <TypeIcon name={outcome.type} />
        {/* The key never breaks, and the summary wraps beside the icon, never under it (TR-16). */}
        <a href={routeHref(`#/tickets/${encodeURIComponent(outcome.key)}`)}>
          <span className="track-outcome-key">{outcome.key}</span> {outcome.summary}
        </a>
        <span className={`stage-badge stage-${outcome.status.stage}`}>{outcome.status.name}</span>
      </div>
      <div className="track-outcome-progress">
        {total > 0 ? (
          <>
            <ProgressBar
              percent={percent}
              label={t('track.outcomes.progress', { closed, total, percent })}
            />
            <span aria-hidden="true">{t('track.outcomes.count', { closed, total })}</span>
          </>
        ) : (
          <span>{t('track.outcomes.noTickets')}</span>
        )}
      </div>
      {(outcome.startDate || outcome.dueDate) && (
        <p className="track-outcome-dates">
          {outcome.startDate && t('track.outcomes.start', { date: day(outcome.startDate) })}
          {outcome.startDate && outcome.dueDate && ' · '}
          {outcome.dueDate && t('track.outcomes.due', { date: day(outcome.dueDate) })}
        </p>
      )}
      {children}
    </li>
  );
}
