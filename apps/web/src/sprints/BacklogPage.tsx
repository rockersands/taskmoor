import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import {
  type Backlog,
  type BacklogTicket,
  type CompleteTarget,
  estimateText,
  type SprintClient,
  type SprintSection,
  sprintClient,
  type Totals,
} from './client';

export interface BacklogPageProps {
  boardId: number;
  client?: SprintClient;
  /** Today, for the default end date of a sprint being started (two weeks later). */
  now?: () => Date;
}

const TWO_WEEKS = 14 * 24 * 3600 * 1000;

/**
 * A Scrum board's backlog (M1-044; AGL-008, AGL-010, AGL-011): the active and future sprints as
 * sections, then the backlog, each with its tickets in rank order and the totals by the board's
 * estimation statistic. Sprints are created, started and completed here; tickets move between
 * sections with a menu (drag and drop is M1-046). Every section has a link to its report once
 * started.
 */
export function BacklogPage({
  boardId,
  client = sprintClient,
  now = () => new Date(),
}: BacklogPageProps) {
  const t = useT();
  const id = useId();
  const [data, setData] = useState<Backlog | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    client.backlog(boardId).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, boardId]);
  useEffect(load, [load]);

  const run = (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setProblem(null);
    work().then(
      () => {
        setBusy(false);
        load();
      },
      () => {
        setBusy(false);
        setProblem(failure);
      },
    );
  };

  const statistic = data?.settings.estimation.statistic ?? 'originalEstimate';
  const totalsText = (totals: Totals) =>
    totals.remaining === undefined
      ? t('sprints.totals', {
          count: totals.tickets,
          estimate: estimateText(t, totals.estimate, statistic),
        })
      : t('sprints.totalsRemaining', {
          count: totals.tickets,
          estimate: estimateText(t, totals.estimate, statistic),
          remaining: estimateText(t, totals.remaining, 'originalEstimate'),
        });

  const moveTicket = (ticket: BacklogTicket, from: number | null, to: string) => {
    if (to === '') return;
    if (to === 'backlog') {
      if (from === null) return;
      run(() => client.removeTickets(from, [ticket.id]), t('sprints.move.failed'));
    } else {
      run(() => client.addTickets(Number(to), [ticket.id]), t('sprints.move.failed'));
    }
  };

  const ticketList = (tickets: BacklogTicket[], from: number | null, sections: SprintSection[]) =>
    tickets.length === 0 ? (
      <p className="sprint-empty">{t('sprints.section.empty')}</p>
    ) : (
      <ul className="sprint-tickets">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="sprint-ticket" data-done={ticket.done || undefined}>
            <a href={`#/tickets/${encodeURIComponent(ticket.key)}`} className="sprint-ticket-key">
              {ticket.key}
            </a>
            <span className="sprint-ticket-summary">{ticket.summary}</span>
            <span className="sprint-ticket-status">{ticket.status.name}</span>
            <span className="sprint-ticket-estimate">
              {estimateText(t, ticket.estimate, statistic)}
            </span>
            <label className="sprint-ticket-move">
              <span className="visually-hidden">
                {t('sprints.move.label', { key: ticket.key })}
              </span>
              <select
                value=""
                disabled={busy}
                onChange={(event) => moveTicket(ticket, from, event.target.value)}
              >
                <option value="">{t('sprints.move.placeholder')}</option>
                {sections
                  .filter((s) => s.id !== from)
                  .map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                {from !== null && <option value="backlog">{t('sprints.backlog.title')}</option>}
              </select>
            </label>
          </li>
        ))}
      </ul>
    );

  return (
    <section className="backlog-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {t('sprints.backlog.pageTitle')}
        </h1>
        <a href={`#/boards/${boardId}`}>{t('sprints.backlog.toBoard')}</a>
      </div>
      {failed && (
        <p className="board-problem" role="alert">
          {t('sprints.backlog.failed')}
        </p>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {data && (
        <>
          {data.mayManage && (
            <div className="form-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => run(() => client.create(boardId), t('sprints.create.failed'))}
              >
                {t('sprints.create.submit')}
              </button>
            </div>
          )}
          {data.sprints.map((section) => (
            <SprintPanel
              key={section.id}
              section={section}
              sections={data.sprints}
              manage={data.mayManage}
              busy={busy}
              totals={totalsText(section.totals)}
              onStart={() =>
                run(async () => {
                  const end = new Date(now().getTime() + TWO_WEEKS).toISOString();
                  const outcome = await client.start(section.id, end);
                  if (!outcome.ok) throw new Error(outcome.code);
                }, t('sprints.start.failed'))
              }
              onComplete={(target) =>
                run(() => client.complete(section.id, target), t('sprints.complete.failed'))
              }
            >
              {ticketList(section.tickets, section.id, data.sprints)}
            </SprintPanel>
          ))}
          <section className="sprint-section" aria-labelledby={`${id}-backlog`}>
            <div className="sprint-section-header">
              <h2 id={`${id}-backlog`}>{t('sprints.backlog.title')}</h2>
              <span className="board-meta">{totalsText(data.backlog.totals)}</span>
            </div>
            {ticketList(data.backlog.tickets, null, data.sprints)}
          </section>
          {data.truncated && <p className="board-hint">{t('sprints.backlog.truncated')}</p>}
        </>
      )}
    </section>
  );
}

interface SprintPanelProps {
  section: SprintSection;
  sections: SprintSection[];
  manage: boolean;
  busy: boolean;
  totals: string;
  onStart: () => void;
  onComplete: (target: CompleteTarget) => void;
  children: React.ReactNode;
}

function SprintPanel({
  section,
  sections,
  manage,
  busy,
  totals,
  onStart,
  onComplete,
  children,
}: SprintPanelProps) {
  const t = useT();
  const id = useId();
  const [target, setTarget] = useState('backlog');
  const futures = sections.filter((s) => s.state === 'future' && s.id !== section.id);
  const chosen = (): CompleteTarget =>
    target === 'backlog'
      ? { type: 'backlog' }
      : target === 'new'
        ? { type: 'new' }
        : { type: 'sprint', sprintId: Number(target) };
  return (
    <section className="sprint-section" aria-labelledby={`${id}-name`}>
      <div className="sprint-section-header">
        <h2 id={`${id}-name`}>{section.name}</h2>
        <span className="sprint-state">
          {t(section.state === 'active' ? 'sprints.state.active' : 'sprints.state.future')}
        </span>
        <span className="board-meta">{totals}</span>
        {section.state === 'active' && (
          <a href={`#/boards/${section.boardId}/sprints/${section.id}/report`}>
            {t('sprints.report.link')}
          </a>
        )}
      </div>
      {section.goal && <p className="board-hint">{section.goal}</p>}
      {manage && section.state === 'future' && (
        <div className="form-actions">
          <button type="button" className="button-primary" disabled={busy} onClick={onStart}>
            {t('sprints.start.submit')}
          </button>
        </div>
      )}
      {manage && section.state === 'active' && (
        <div className="sprint-complete">
          <label htmlFor={`${id}-target`} className="form-label">
            {t('sprints.complete.target')}
          </label>
          <select
            id={`${id}-target`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="backlog">{t('sprints.backlog.title')}</option>
            {futures.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
            <option value="new">{t('sprints.complete.newSprint')}</option>
          </select>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => onComplete(chosen())}
          >
            {t('sprints.complete.submit')}
          </button>
        </div>
      )}
      {children}
    </section>
  );
}
