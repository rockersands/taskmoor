import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { type PlanView, planHref } from './address';
import { trackKeyOf, useChangeWords } from './changeWords';
import { AskFirst, scenarioRefusal } from './ScenarioDialogs';
import type {
  ApplyResult,
  ChangeList,
  PlanChange,
  ScenarioClient,
  ScenarioList,
  ScenarioRow,
} from './scenarioClient';

export interface PlanChangesPageProps {
  planId: number;
  /** The scenario the address names, or null for Live. */
  scenario: ScenarioRow | null;
  list: ScenarioList | null;
  client: ScenarioClient;
  view: PlanView;
  /** Drafts were applied, discarded or kept, or a scenario made main: the counts are read again. */
  onChanged: () => void;
  /** The phone's layout whatever the width (stories, whose browser is not a phone). */
  phone?: boolean;
}

/** What an apply has done so far, and what it said of each refused ticket. */
interface Applied {
  applied: number;
  refused: ApplyResult['refused'];
  total: number;
  done: boolean;
}

/**
 * A scenario's change list (T-089e; PLN-002; ADR-122 stage 6): each ticket with drafts the plan
 * shows the reader, its drafted fields with their values now and drafted ("Due: 3 Dec → 10 Dec"),
 * its state in words, who drafted it and when; drafts on tickets the plan does not show the reader
 * are only counted. The plan's editors choose tickets and apply them (the main scenario only;
 * another one offers to become main), keep a draft that changed since it was drafted, or discard.
 * Applying asks first, runs 100 tickets at a time and says how far it has got; its result is
 * announced, focus moves to its heading, and refused tickets stay chosen with their reasons. On a
 * desktop it is a table; on a phone each ticket is a card with a finger-sized check box, and an
 * action bar stays at the bottom.
 */
export function PlanChangesPage({
  planId,
  scenario,
  list,
  client,
  view,
  onChanged,
  phone = false,
}: PlanChangesPageProps) {
  const t = useT();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY) || phone;
  const [data, setData] = useState<ChangeList | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [onlyMine, setOnlyMine] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [applying, setApplying] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const words = useChangeWords(data);
  const sid = scenario?.id;
  const editable = list?.editable ?? false;

  const latest = useRef(0);
  const load = useCallback(() => {
    if (sid === undefined) return;
    const asked = ++latest.current;
    client.changes(planId, sid).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => asked === latest.current && setFailed(true),
    );
  }, [client, planId, sid]);
  useEffect(load, [load]);

  useEffect(() => {
    if (applying?.done) resultHeading.current?.focus();
  }, [applying?.done]);

  if (!scenario) {
    return (
      <EmptyState title={t('scenario.changes.noneChosen')}>
        {t('scenario.changes.chooseOne')}{' '}
        <a href={routeHref(planHref(planId, 'scenarios', view))}>
          {t('scenario.changes.toScenarios')}
        </a>
      </EmptyState>
    );
  }
  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('scenario.changes.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  const rows = onlyMine ? data.changes.filter((c) => c.mayApply) : data.changes;
  const picked = data.changes.filter((c) => chosen.has(c.ticketId));
  const count = picked.length;
  const running = applying !== null && !applying.done;
  const limit = list?.limits.perApply ?? 100;
  const toggle = (ticketId: number) =>
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });

  const more = async () => {
    if (data.next === null) return;
    const page = await client.changes(planId, scenario.id, { cursor: data.next }).catch(() => null);
    if (!page) {
      setProblem(t('scenario.changes.failed'));
      return;
    }
    setData({ ...page, changes: [...data.changes, ...page.changes] });
  };

  /** Applies batches until done; one refusal never stops the others (PLN-002 (3)). */
  const apply = async (which: 'chosen' | 'all') => {
    setProblem(null);
    const ids = picked.map((c) => c.ticketId);
    const total = which === 'chosen' ? ids.length : data.drafts - data.counts.refused;
    let progress: Applied = { applied: 0, refused: [], total, done: false };
    setApplying(progress);
    setStatus(t('scenario.apply.progress', { done: 0, total }));
    const step = (r: ApplyResult) => {
      progress = {
        ...progress,
        applied: progress.applied + r.applied.length,
        refused: [...progress.refused, ...r.refused],
      };
      setApplying(progress);
      setStatus(
        t('scenario.apply.progress', {
          done: progress.applied + progress.refused.length,
          total,
        }),
      );
    };
    let stopped: string | null = null;
    if (which === 'chosen') {
      for (let at = 0; at < ids.length && !stopped; at += limit) {
        const r = await client
          .apply(planId, scenario.id, { tickets: ids.slice(at, at + limit) })
          .catch(() => null);
        if (!r) stopped = 'unreachable';
        else if (!r.ok) stopped = r.code;
        else step(r.value);
      }
    } else {
      let after: number | undefined;
      do {
        const r = await client
          .apply(planId, scenario.id, after === undefined ? { all: true } : { all: true, after })
          .catch(() => null);
        if (!r) stopped = 'unreachable';
        else if (!r.ok) stopped = r.code;
        else {
          step(r.value);
          after = r.value.next ?? undefined;
        }
      } while (after !== undefined && !stopped);
    }
    progress = { ...progress, done: true };
    setApplying(progress);
    if (stopped) setProblem(applyStopped(stopped));
    setStatus(
      t('scenario.apply.result', { applied: progress.applied, refused: progress.refused.length }),
    );
    // Refused tickets stay chosen, with their reasons; the rest left the list.
    setChosen(new Set(progress.refused.filter((r) => r.key !== null).map((r) => r.ticketId)));
    load();
    onChanged();
  };

  const applyStopped = (code: string) =>
    code === 'apply_in_progress'
      ? t('scenario.apply.inProgress')
      : code === 'not_main'
        ? t('scenario.apply.notMain')
        : t('scenario.apply.stopped');

  const discard = async (which: 'chosen' | 'all') => {
    setProblem(null);
    setBusy(true);
    const r = await client
      .discard(
        planId,
        scenario.id,
        which === 'all' ? { all: true } : { tickets: picked.map((c) => c.ticketId) },
      )
      .catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      setProblem(r ? scenarioRefusal(t, r.code) : t('scenario.refused.other'));
      throw new Error('refused');
    }
    setStatus(t('scenario.discard.done', { count: r.value.discarded, scenario: scenario.name }));
    setChosen(new Set());
    load();
    onChanged();
  };

  /** Drafts the same values again, kept: the value now becomes the value when drafted. */
  const keep = async (c: PlanChange) => {
    setProblem(null);
    const change = {
      ticketId: c.ticketId,
      ...Object.fromEntries(
        c.fields
          .filter((f) => f.teamFieldId === null)
          .map((f) => [f.field, f.draft === null ? null : String(f.draft)]),
      ),
      ...(c.fields.some((f) => f.teamFieldId !== null)
        ? {
            fields: Object.fromEntries(
              c.fields
                .filter((f) => f.teamFieldId !== null)
                .map((f) => [String(f.teamFieldId), f.draft === null ? null : Number(f.draft)]),
            ),
          }
        : {}),
    };
    const r = await client.draft(planId, scenario.id, [change], { keep: true }).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? scenarioRefusal(t, r.code) : t('scenario.refused.other'));
      return;
    }
    setStatus(t('scenario.keep.done', { key: c.key }));
    load();
    onChanged();
  };

  const promote = async () => {
    setProblem(null);
    const r = await client.promote(planId, scenario.id, scenario.version).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? scenarioRefusal(t, r.code) : t('scenario.refused.other'));
      return;
    }
    setStatus(t('scenario.promote.done', { name: scenario.name }));
    onChanged();
  };

  const main = list?.scenarios.find((s) => s.main) ?? null;
  const chooseBox = (c: PlanChange) => (
    <input
      id={`${id}-c${c.ticketId}`}
      type="checkbox"
      className="scenario-check"
      checked={chosen.has(c.ticketId)}
      disabled={running}
      aria-label={t('scenario.changes.select', { key: c.key })}
      onChange={() => toggle(c.ticketId)}
    />
  );
  const stateView = (c: PlanChange) => (
    <>
      <span className={`scenario-state is-${c.state}${c.mayApply ? '' : ' is-blocked'}`}>
        {words.state(c)}
      </span>
      {c.origin === 'scheduler' && (
        <span className="scenario-meta">{t('scenario.state.scheduler')}</span>
      )}
      {editable && c.state === 'changed' && (
        <button
          type="button"
          className="button-secondary scenario-keep"
          aria-label={t('scenario.keep.label', { key: c.key })}
          disabled={running}
          onClick={() => void keep(c)}
        >
          {t('scenario.keep')}
        </button>
      )}
    </>
  );
  const ticketLink = (c: PlanChange) => (
    <a href={routeHref(`#/tickets/${encodeURIComponent(c.key)}`)}>
      <span className="scenario-key">{c.key}</span> {c.summary}
    </a>
  );
  const byline = (c: PlanChange) =>
    t('scenario.changes.by', { name: c.updatedBy.name, when: words.when(c.updatedAt) });

  const applyActions =
    editable &&
    (scenario.main ? (
      <>
        <AskFirst
          label={t('scenario.apply.chosen', { count })}
          question={t('scenario.apply.ask', { count })}
          confirmLabel={t('scenario.apply.chosen', { count })}
          disabled={count === 0 || running || busy}
          onConfirm={() => apply('chosen')}
        />
        {!compact && (
          <AskFirst
            look="secondary"
            label={t('scenario.apply.all')}
            question={t('scenario.apply.askAll', { count: data.drafts - data.counts.refused })}
            confirmLabel={t('scenario.apply.all')}
            disabled={data.drafts - data.counts.refused === 0 || running || busy}
            onConfirm={() => apply('all')}
          />
        )}
      </>
    ) : (
      <AskFirst
        label={t('scenario.promote', { name: scenario.name })}
        question={t('scenario.promote.ask', {
          name: scenario.name,
          count: scenario.drafts,
          main: main?.name ?? '',
          mainCount: main?.drafts ?? 0,
        })}
        confirmLabel={t('scenario.promote', { name: scenario.name })}
        disabled={running || busy}
        onConfirm={promote}
      />
    ));
  const discardActions = editable && (
    <>
      <DangerAction
        label={t('scenario.discard.chosen', { count })}
        outcome={t('scenario.discard.ask', { count, scenario: scenario.name })}
        confirmLabel={t('scenario.discard.chosen', { count })}
        disabled={count === 0 || running}
        busy={busy}
        onConfirm={() => discard('chosen')}
      />
      {!compact && (
        <DangerAction
          label={t('scenario.discard.all')}
          outcome={t('scenario.discard.askAll', {
            count: data.drafts,
            scenario: scenario.name,
            hidden: data.notShown,
          })}
          confirmLabel={t('scenario.discard.all')}
          disabled={data.drafts === 0 || running}
          busy={busy}
          onConfirm={() => discard('all')}
        />
      )}
    </>
  );

  return (
    <section className="plan-changes" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {t(scenario.main ? 'scenario.changes.titleMain' : 'scenario.changes.title', {
          name: scenario.name,
        })}
      </h2>
      <p className="board-hint">
        {data.drafts > 0 &&
          t('scenario.changes.counts', {
            count: data.drafts,
            ready: data.counts.ready + data.counts.already,
            changed: data.counts.changed,
            refused: data.counts.refused,
          })}
        {!scenario.main && ` ${t('scenario.changes.notMain')}`}
        {!editable && ` ${t('scenario.changes.readOnly')}`}
      </p>
      <p className="board-hint scenario-status" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {applying?.done && (
        <section className="glass-card scenario-result" aria-labelledby={`${id}-result`}>
          <h3 id={`${id}-result`} ref={resultHeading} tabIndex={-1}>
            {t('scenario.apply.result', {
              applied: applying.applied,
              refused: applying.refused.length,
            })}
          </h3>
          {applying.refused.length > 0 && (
            <ul>
              {applying.refused.map((r) => (
                <li key={r.ticketId}>
                  {r.key
                    ? t('scenario.apply.refusedRow', {
                        key: r.key,
                        reason: words.refusal(r, r.key),
                      })
                    : words.refusal(r, null)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {data.changes.length > 0 && (
        <div className="scenario-tools">
          {editable && (
            <label className="scenario-only">
              <input
                type="checkbox"
                className="scenario-check"
                checked={onlyMine}
                onChange={(event) => setOnlyMine(event.target.checked)}
              />
              {t('scenario.changes.onlyMine')}
            </label>
          )}
          {editable && (
            <button
              type="button"
              className="button-secondary"
              disabled={running}
              onClick={() =>
                setChosen(
                  rows.every((c) => chosen.has(c.ticketId))
                    ? new Set()
                    : new Set(rows.map((c) => c.ticketId)),
                )
              }
            >
              {rows.length > 0 && rows.every((c) => chosen.has(c.ticketId))
                ? t('scenario.changes.selectNone')
                : t('scenario.changes.selectAll', { count: rows.length })}
            </button>
          )}
          {!compact && applyActions}
          {!compact && discardActions}
        </div>
      )}
      {data.changes.length === 0 ? (
        <EmptyState compact title={t('scenario.changes.empty')}>
          {t('scenario.changes.emptyBody')}
        </EmptyState>
      ) : compact ? (
        <ul className="scenario-cards" aria-label={t('scenario.changes.list')}>
          {rows.map((c) => (
            <li key={c.ticketId} className={`glass-card scenario-card is-${c.state}`}>
              {editable && (
                <label className="scenario-card-check" htmlFor={`${id}-c${c.ticketId}`}>
                  {chooseBox(c)}
                  <span className="visually-hidden">
                    {t('scenario.changes.select', { key: c.key })}
                  </span>
                </label>
              )}
              <div className="scenario-card-body">
                <p className="scenario-card-title">{ticketLink(c)}</p>
                <ul className="scenario-lines">
                  {c.fields.map((f) => (
                    <li key={f.field}>{words.line(f)}</li>
                  ))}
                </ul>
                <p className="scenario-card-state">{stateView(c)}</p>
                <p className="scenario-meta">{byline(c)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="glass-card glass-scroller scenario-table-scroll">
          <table className="scenario-table">
            <caption className="visually-hidden">{t('scenario.changes.list')}</caption>
            <thead>
              <tr>
                {editable && (
                  <th scope="col">
                    <span className="visually-hidden">{t('scenario.changes.choose')}</span>
                  </th>
                )}
                <th scope="col">{t('scenario.changes.ticket')}</th>
                <th scope="col">{t('scenario.changes.track')}</th>
                <th scope="col">{t('scenario.changes.change')}</th>
                <th scope="col">{t('scenario.changes.state')}</th>
                <th scope="col">{t('scenario.changes.drafted')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.ticketId} className={`is-${c.state}`}>
                  {editable && <td>{chooseBox(c)}</td>}
                  <th scope="row">{ticketLink(c)}</th>
                  <td>{trackKeyOf(c.key)}</td>
                  <td>
                    <ul className="scenario-lines">
                      {c.fields.map((f) => (
                        <li key={f.field}>{words.line(f)}</li>
                      ))}
                    </ul>
                  </td>
                  <td>{stateView(c)}</td>
                  <td>{byline(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.next !== null && (
        <button type="button" className="button-secondary" onClick={() => void more()}>
          {t('scenario.changes.more')}
        </button>
      )}
      {data.notShown > 0 && (
        <p className="board-hint">{t('scenario.changes.notShown', { count: data.notShown })}</p>
      )}
      {compact && editable && data.changes.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: a bar of the page's actions, not a form
        <div
          className="scenario-action-bar"
          role="group"
          aria-label={t('scenario.changes.actions')}
        >
          {applyActions}
          {discardActions}
        </div>
      )}
    </section>
  );
}
