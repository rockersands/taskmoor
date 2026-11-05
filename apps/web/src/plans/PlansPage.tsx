import { type FormEvent, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type PlanClient,
  type PlanRow,
  type PlanSourceInput,
  planClient,
  type SourceOptions,
} from './client';
import { SourcePicker } from './SourcePicker';

export interface PlansPageProps {
  client?: PlanClient;
}

/**
 * Multi-track (T-088; PLN-001; ADR-122): the plans a person sees, their own and those shared with
 * them, and a new one from a name and its tracks and saved searches. A plan gives no access:
 * everyone sees in it only what they may see anyway.
 */
export function PlansPage({ client = planClient }: PlansPageProps) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const me = session.status === 'signed-in' ? session.user.id : null;
  const [list, setList] = useState<PlanRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [sources, setSources] = useState<PlanSourceInput[]>([]);
  const [options, setOptions] = useState<SourceOptions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.list().then(setList, () => setFailed(true));
  }, [client]);
  const [optionsFailed, setOptionsFailed] = useState(false);
  useEffect(() => {
    if (!creating || options) return;
    client.sourceOptions().then(setOptions, () => setOptionsFailed(true));
  }, [client, creating, options]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setProblem(null);
    const saved = await client.create({ name: name.trim(), sources });
    setBusy(false);
    if (saved.ok) {
      navigate(`#/plans/${saved.plan.id}`);
      return;
    }
    setProblem(
      Object.values(saved.fields).includes('not_found')
        ? t('plans.create.sourceGone')
        : t('plans.create.failed'),
    );
  };

  const mine = (list ?? []).filter((p) => p.owner.id === me);
  const others = (list ?? []).filter((p) => p.owner.id !== me);
  const row = (p: PlanRow) => (
    <li key={p.id} className="dashboard-row">
      <a href={routeHref(`#/plans/${p.id}`)}>{p.name}</a>
      <span className="board-meta">
        {t('plans.rowMeta', { owner: p.owner.name, count: p.sourceCount })}
      </span>
    </li>
  );

  return (
    <section className="page plans-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('nav.plans')}
        purpose={t('purpose.plans')}
        about={t('plans.intro')}
        actions={
          <>
            <a className="button-quiet" href={routeHref('#/cross-track-releases')}>
              {t('crossTrack.title')}
            </a>
            {!creating && (
              <button type="button" className="button-primary" onClick={() => setCreating(true)}>
                {t('plans.new')}
              </button>
            )}
          </>
        }
      />
      {creating && (
        <form
          className="glass-card plan-create"
          aria-label={t('plans.new')}
          onSubmit={(event) => void create(event)}
        >
          <div className="form-field">
            <label htmlFor={`${id}-name`}>{t('plans.name')}</label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={255}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {optionsFailed ? (
            <p className="board-problem" role="alert">
              {t('plans.sources.failed')}
            </p>
          ) : (
            <SourcePicker options={options} value={sources} onChange={setSources} />
          )}
          {problem && (
            <p className="board-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy || !name.trim()}>
              {t('plans.create')}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setCreating(false);
                setProblem(null);
              }}
            >
              {t('plans.cancel')}
            </button>
          </div>
        </form>
      )}
      {failed && (
        <p className="board-problem" role="alert">
          {t('plans.listFailed')}
        </p>
      )}
      {list && list.length === 0 && (
        <EmptyState title={t('plans.none')}>{t('empty.plans.body')}</EmptyState>
      )}
      {mine.length > 0 && (
        <section className="glass-card" aria-labelledby={`${id}-mine`}>
          <h2 id={`${id}-mine`}>{t('plans.mine')}</h2>
          <ul className="dashboard-list">{mine.map(row)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="glass-card" aria-labelledby={`${id}-others`}>
          <h2 id={`${id}-others`}>{t('plans.others')}</h2>
          <ul className="dashboard-list">{others.map(row)}</ul>
        </section>
      )}
    </section>
  );
}
