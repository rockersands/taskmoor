import { useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { type PlanView, planHref } from './address';
import { ScenarioCompare } from './ScenarioCompare';
import {
  AskFirst,
  NewScenarioDialog,
  RenameScenarioDialog,
  scenarioRefusal,
} from './ScenarioDialogs';
import type { ScenarioClient, ScenarioList, ScenarioRow } from './scenarioClient';

export interface PlanScenariosPageProps {
  planId: number;
  /** The plan's scenarios, or null while they load. */
  list: ScenarioList | null;
  failed: boolean;
  client: ScenarioClient;
  view: PlanView;
  /** A scenario was made, renamed, deleted or made main: the list is read again. */
  onChanged: () => void;
  /** The sides compared, kept in the page's address. */
  onCompare: (sides: { a: string; b: string }) => void;
  /** The phone's layout whatever the width (stories, whose browser is not a phone). */
  phone?: boolean;
}

/**
 * A plan's scenarios (T-089e; PLN-003; ADR-122 stage 6): each with its draft changes (those on
 * tickets the plan does not show the reader only counted), who made it and when; Open, Rename,
 * Make main (asks first: the chosen scenario's drafts become the plan's drafts to apply, and the
 * former main stays a scenario with its own) and Delete (names how many drafts go, hidden ones
 * counted), with New scenario for the plan's editors. Scenarios are shared with everyone who sees
 * the plan. Below, two sides compared. Every dialog is a sheet on a phone.
 */
export function PlanScenariosPage({
  planId,
  list,
  failed,
  client,
  view,
  onChanged,
  onCompare,
  phone = false,
}: PlanScenariosPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [making, setMaking] = useState(false);
  const [renaming, setRenaming] = useState<ScenarioRow | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (failed && !list) {
    return (
      <p className="board-problem" role="alert">
        {t('scenario.listFailed')}
      </p>
    );
  }
  if (!list) return <p className="report-loading">{t('reports.loading')}</p>;

  const main = list.scenarios.find((s) => s.main) ?? null;
  const full = list.scenarios.length >= list.limits.scenarios;
  const made = (at: string) =>
    intl.formatDate(at, { day: 'numeric', month: 'short', year: 'numeric' });

  const promote = async (s: ScenarioRow) => {
    setProblem(null);
    const r = await client.promote(planId, s.id, s.version).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? scenarioRefusal(t, r.code) : t('scenario.refused.other'));
      return;
    }
    setStatus(t('scenario.promote.done', { name: s.name }));
    onChanged();
  };
  const remove = async (s: ScenarioRow) => {
    setProblem(null);
    const r = await client.remove(planId, s.id, s.version).catch(() => null);
    if (!r?.ok) {
      setProblem(r ? scenarioRefusal(t, r.code) : t('scenario.refused.other'));
      throw new Error('refused');
    }
    setStatus(t('scenario.delete.done', { name: s.name }));
    onChanged();
  };

  return (
    <section className="plan-scenarios" aria-labelledby={`${id}-title`}>
      <div className="plan-scenarios-head">
        <h2 id={`${id}-title`}>{t('scenario.list.title')}</h2>
        {list.editable && (
          <button
            type="button"
            className="button-primary"
            disabled={full}
            onClick={() => setMaking(true)}
          >
            {t('scenario.new')}
          </button>
        )}
      </div>
      <p className="board-hint">{t('scenario.list.intro')}</p>
      {full && list.editable && (
        <p className="board-hint">{t('scenario.list.full', { count: list.limits.scenarios })}</p>
      )}
      {!list.editable && <p className="board-hint">{t('scenario.list.readOnly')}</p>}
      <p className="board-hint scenario-status" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {list.scenarios.length === 0 ? (
        <EmptyState compact title={t('scenario.list.empty')}>
          {t('scenario.list.emptyBody')}
        </EmptyState>
      ) : (
        <ul className="scenario-list">
          {list.scenarios.map((s) => {
            const deletable = !s.main || list.scenarios.length === 1;
            return (
              <li key={s.id} className="glass-card scenario-item">
                <h3>
                  {s.name}
                  {s.main && <span className="scenario-main"> · {t('scenario.main')}</span>}
                </h3>
                <p>
                  {t('scenario.list.drafts', { count: s.drafts })}
                  {s.notShown > 0 && ` ${t('scenario.notShown', { count: s.notShown })}`}
                </p>
                <p className="scenario-meta">
                  {t('scenario.list.madeBy', { name: s.createdBy.name, when: made(s.createdAt) })}
                  {s.applying && ` · ${t('scenario.list.applying')}`}
                </p>
                <div className="scenario-item-actions">
                  <a
                    className="button-secondary"
                    href={routeHref(planHref(planId, 'timeline', { ...view, scenario: s.id }))}
                    aria-label={t('scenario.open.label', { name: s.name })}
                  >
                    {t('scenario.open')}
                  </a>
                  <a
                    className="button-secondary"
                    href={routeHref(planHref(planId, 'changes', { ...view, scenario: s.id }))}
                    aria-label={t('scenario.changes.label', { name: s.name })}
                  >
                    {t('scenario.changes.link')}
                  </a>
                  {list.editable && (
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('scenario.rename.label', { name: s.name })}
                      onClick={() => setRenaming(s)}
                    >
                      {t('scenario.rename')}
                    </button>
                  )}
                  {list.editable && !s.main && (
                    <AskFirst
                      look="secondary"
                      label={t('scenario.makeMain')}
                      name={t('scenario.promote', { name: s.name })}
                      question={t('scenario.promote.ask', {
                        name: s.name,
                        count: s.drafts,
                        main: main?.name ?? '',
                        mainCount: main?.drafts ?? 0,
                      })}
                      confirmLabel={t('scenario.promote', { name: s.name })}
                      disabled={s.applying || (main?.applying ?? false)}
                      onConfirm={() => promote(s)}
                    />
                  )}
                  {list.editable && deletable && (
                    <DangerAction
                      label={t('scenario.delete')}
                      name={t('scenario.delete.label', { name: s.name })}
                      outcome={
                        s.notShown > 0
                          ? t('scenario.delete.askHidden', {
                              name: s.name,
                              count: s.drafts,
                              hidden: s.notShown,
                            })
                          : t('scenario.delete.ask', { name: s.name, count: s.drafts })
                      }
                      confirmLabel={t('scenario.delete.label', { name: s.name })}
                      disabled={s.applying}
                      onConfirm={() => remove(s)}
                    />
                  )}
                </div>
                {list.editable && s.main && !deletable && (
                  <p className="board-hint">{t('scenario.delete.mainKept')}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.scenarios.length > 0 ? (
        <ScenarioCompare
          planId={planId}
          client={client}
          scenarios={list.scenarios}
          filters={view.filters}
          a={view.compare?.a}
          b={view.compare?.b}
          onChange={onCompare}
          phone={phone}
        />
      ) : null}
      {making && (
        <NewScenarioDialog
          scenarios={list.scenarios}
          onCreate={(name, from) => client.create(planId, name, from)}
          onMade={(scenario, notShown) => {
            setMaking(false);
            setStatus(
              notShown > 0
                ? t('scenario.new.doneLeft', { name: scenario.name, count: notShown })
                : t('scenario.new.done', { name: scenario.name }),
            );
            onChanged();
          }}
          onClose={() => setMaking(false)}
        />
      )}
      {renaming && (
        <RenameScenarioDialog
          scenario={renaming}
          onRename={(name) => client.rename(planId, renaming.id, name, renaming.version)}
          onDone={(s) => {
            setRenaming(null);
            setStatus(t('scenario.rename.done', { name: s.name }));
            onChanged();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </section>
  );
}
