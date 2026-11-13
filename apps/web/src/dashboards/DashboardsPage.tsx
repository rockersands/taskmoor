import { type FormEvent, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type DashboardClient, type DashboardSummary, dashboardClient } from './client';

export interface DashboardsPageProps {
  client?: DashboardClient;
}

/**
 * The dashboards a person sees (M1-064; RPT-004): their own, those shared with them and the
 * default; a new one by name; and a wallboard turning through the chosen ones full screen.
 */
export function DashboardsPage({ client = dashboardClient }: DashboardsPageProps) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const me = session.status === 'signed-in' ? session.user.id : null;
  const [list, setList] = useState<DashboardSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const [seconds, setSeconds] = useState('60');

  useEffect(() => {
    client.list().then(setList, () => setFailed(true));
  }, [client]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const made = await client.create(name.trim());
    navigate(`#/dashboards/${made.id}`);
  };
  // Typed freely; kept between ten seconds and an hour when used.
  const turn = Math.min(3600, Math.max(10, Number(seconds) || 60));
  const mine = (list ?? []).filter((d) => d.owner.id === me);
  const others = (list ?? []).filter((d) => d.owner.id !== me);
  const row = (d: DashboardSummary) => (
    <li key={d.id} className="dashboard-row">
      <a href={routeHref(`#/dashboards/${d.id}`)}>{d.name}</a>
      <span className="board-meta">
        {t('dashboards.meta', { owner: d.owner.name })}
        {d.isDefault && ` ${t('dashboards.isDefault')}`}
      </span>
      {/* The box says what it does, in words a sighted reader sees too (PL-14). */}
      <label className="reports-check dashboard-wallboard-pick">
        <input
          type="checkbox"
          checked={chosen.includes(d.id)}
          onChange={(e) =>
            setChosen((c) => (e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id)))
          }
          aria-label={t('dashboards.chooseForWallboard', { name: d.name })}
        />
        <span aria-hidden="true">{t('dashboards.onWallboard')}</span>
      </label>
    </li>
  );

  return (
    <section className="page dashboards-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('nav.dashboards')}
        purpose={t('purpose.dashboards')}
      />
      <form
        className="glass-card reports-controls"
        data-tutorial="dashboard-new"
        onSubmit={(e) => void create(e)}
      >
        <div className="form-field">
          <label htmlFor={`${id}-name`}>{t('dashboards.newName')}</label>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="button-primary">
          {t('dashboards.create')}
        </button>
      </form>
      {failed && (
        <p className="board-problem" role="alert">
          {t('dashboards.listFailed')}
        </p>
      )}
      {list && list.length === 0 && (
        <EmptyState title={t('empty.dashboards.title')}>{t('empty.dashboards.body')}</EmptyState>
      )}
      {mine.length > 0 && (
        <section className="glass-card" aria-labelledby={`${id}-mine`}>
          <h2 id={`${id}-mine`}>{t('dashboards.mine')}</h2>
          <ul className="dashboard-list">{mine.map(row)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="glass-card" aria-labelledby={`${id}-others`}>
          <h2 id={`${id}-others`}>{t('dashboards.others')}</h2>
          <ul className="dashboard-list">{others.map(row)}</ul>
        </section>
      )}
      {list && list.length > 0 && (
        <section
          className="glass-card reports-controls dashboard-wallboard"
          aria-labelledby={`${id}-wallboard`}
        >
          <h2 id={`${id}-wallboard`}>{t('dashboards.wallboardTitle')}</h2>
          <div className="form-field">
            <label htmlFor={`${id}-seconds`}>{t('dashboards.wallboardSeconds')}</label>
            <input
              id={`${id}-seconds`}
              type="number"
              inputMode="numeric"
              min={10}
              max={3600}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </div>
          {chosen.length > 0 ? (
            <a
              className="button-primary"
              href={routeHref(
                `#/dashboards/${chosen[0]}/wallboard?rotate=${chosen.join(',')}&seconds=${turn}`,
              )}
            >
              {t('dashboards.startWallboard', { count: chosen.length })}
            </a>
          ) : (
            <p className="report-note">{t('dashboards.chooseHint')}</p>
          )}
        </section>
      )}
    </section>
  );
}
