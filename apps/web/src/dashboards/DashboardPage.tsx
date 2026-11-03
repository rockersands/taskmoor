import { type CSSProperties, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import {
  COLUMNS,
  type Dashboard,
  type DashboardClient,
  type DashboardShare,
  dashboardClient,
  LAYOUTS,
  type Layout,
  WIDGET_KINDS,
  type Widget,
  type WidgetKind,
} from './client';
import { defaultConfig, SETTINGS, WidgetSettings } from './WidgetSettings';
import { WidgetView, widgetTitle } from './WidgetView';

type Visibility = 'private' | 'any_user' | 'public' | 'custom';

/** The page's choice of who sees a dashboard (other shares are kept as they are). */
function visibilityOf(shares: readonly DashboardShare[]): Visibility {
  if (shares.length === 0) return 'private';
  if (shares.length === 1 && shares[0]?.scope === 'any_user') return 'any_user';
  if (shares.length === 1 && shares[0]?.scope === 'public') return 'public';
  return 'custom';
}

/** The dashboard after `current` in a wallboard's rotation, around to the first. */
export function nextInRotation(rotation: readonly number[], current: number): number | null {
  if (rotation.length === 0) return null;
  const at = rotation.indexOf(current);
  return rotation[(at + 1) % rotation.length] ?? null;
}

/** Widgets are read again this often on a wallboard. */
const WALLBOARD_REFRESH_MS = 5 * 60_000;

export interface DashboardPageProps {
  id: number;
  client?: DashboardClient;
  /** Wallboard mode (RPT-004 (2)): no controls, data read again, the next dashboard in turn. */
  wallboard?: { rotation: number[]; seconds: number } | null;
}

/**
 * A dashboard (M1-064; RPT-004, RPT-005): its widgets in the layout's columns, each read as the
 * viewer. Its owner edits it here: the name, the layout, widgets added, set up, moved and
 * removed, saved together with the version they were read at; and who sees it. Anyone who sees
 * it copies it; site administrators make it everyone's home. A wallboard shows it full screen
 * without controls and turns to the next dashboard of the rotation.
 */
export function DashboardPage({
  id,
  client = dashboardClient,
  wallboard = null,
}: DashboardPageProps) {
  const t = useT();
  const titleId = useId();
  const { session } = useSession();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<{ name: string; layout: Layout; widgets: Widget[] } | null>(
    null,
  );
  const [settingsOf, setSettingsOf] = useState<string | null>(null);
  const [adding, setAdding] = useState<WidgetKind>('search-results');
  const [boards, setBoards] = useState<{ id: number; name: string; kind: 'scrum' | 'kanban' }[]>(
    [],
  );
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    client.get(id).then(
      (d) => live && setDashboard(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, id]);

  // A wallboard reads its widgets again now and then, and turns to the next dashboard.
  useEffect(() => {
    if (!wallboard) return;
    const refreshing = window.setInterval(() => setRefresh((n) => n + 1), WALLBOARD_REFRESH_MS);
    const next = nextInRotation(wallboard.rotation, id);
    const turning =
      next !== null && next !== id
        ? window.setTimeout(() => {
            navigate(
              `#/dashboards/${next}/wallboard?rotate=${wallboard.rotation.join(',')}&seconds=${wallboard.seconds}`,
            );
          }, wallboard.seconds * 1000)
        : undefined;
    return () => {
      window.clearInterval(refreshing);
      if (turning !== undefined) window.clearTimeout(turning);
    };
  }, [wallboard, id]);

  if (failed) {
    return (
      <section className="dashboard-page">
        <p className="board-problem" role="alert">
          {t('dashboards.notFound')}
        </p>
      </section>
    );
  }
  if (!dashboard) return <p className="report-empty">{t('reports.loading')}</p>;

  const editing = draft !== null;
  const layout = draft?.layout ?? dashboard.layout;
  const widgets = draft?.widgets ?? dashboard.widgets;
  const columns = COLUMNS[layout];

  const startEditing = () => {
    setDraft({ name: dashboard.name, layout: dashboard.layout, widgets: dashboard.widgets });
    setProblem(null);
    setStatus(null);
    client.boards().then(setBoards, () => setBoards([]));
  };
  const changeWidgets = (change: (list: Widget[]) => Widget[]) =>
    setDraft((d) => (d ? { ...d, widgets: change(d.widgets) } : d));
  const move = (widgetId: string, by: { column?: number; place?: number }) =>
    changeWidgets((list) => {
      const at = list.findIndex((w) => w.id === widgetId);
      const w = list[at];
      if (!w) return list;
      if (by.column !== undefined) {
        const column = Math.min(columns - 1, Math.max(0, w.column + by.column));
        return list.map((x) => (x.id === widgetId ? { ...x, column } : x));
      }
      // Up or down among the widgets of its column.
      const same = list.filter((x) => x.column === w.column);
      const pos = same.findIndex((x) => x.id === widgetId) + (by.place ?? 0);
      const other = same[pos];
      if (!other) return list;
      const otherAt = list.findIndex((x) => x.id === other.id);
      const out = [...list];
      out[at] = other;
      out[otherAt] = w;
      return out;
    });
  const add = () => {
    const made: Widget = {
      id: `new-${Date.now().toString(36)}`,
      kind: adding,
      column: 0,
      title: '',
      config: defaultConfig(adding, boards.find((b) => b.kind === 'scrum')?.id ?? null),
    };
    changeWidgets((list) => [made, ...list]);
    setSettingsOf(made.id);
  };
  const save = async () => {
    if (!draft) return;
    const outcome = await client.update(dashboard.id, {
      name: draft.name.trim() || dashboard.name,
      layout: draft.layout,
      // New widgets get their ids from the server.
      widgets: draft.widgets.map((w) => {
        const { id: wid, ...rest } = w;
        return wid.startsWith('new-') ? rest : w;
      }),
      version: dashboard.version,
    });
    if (outcome.ok) {
      setDashboard(outcome.dashboard);
      setDraft(null);
      setSettingsOf(null);
      setStatus(t('dashboards.saved'));
      setRefresh((n) => n + 1);
    } else {
      setProblem(
        outcome.error === 'version_conflict' ? t('dashboards.conflict') : t('dashboards.invalid'),
      );
    }
  };
  const share = async (visibility: Visibility) => {
    if (visibility === 'custom') return;
    const shares: DashboardShare[] = visibility === 'private' ? [] : [{ scope: visibility }];
    const outcome = await client.update(dashboard.id, { shares, version: dashboard.version });
    if (outcome.ok) {
      setDashboard(outcome.dashboard);
      setStatus(t(`dashboards.shared.${visibility}`));
    } else {
      setProblem(t('dashboards.conflict'));
    }
  };
  const copy = async () => {
    const made = await client.copy(dashboard.id);
    navigate(`#/dashboards/${made.id}`);
  };
  const makeDefault = async () => {
    await client.setDefault(dashboard.id);
    setDashboard({ ...dashboard, isDefault: true });
    setStatus(t('dashboards.madeDefault'));
  };
  const remove = async () => {
    if (!window.confirm(t('dashboards.confirmDelete', { name: dashboard.name }))) return;
    await client.remove(dashboard.id);
    navigate('#/dashboards');
  };

  const grid = { '--dashboard-columns': columns } as CSSProperties;
  const visibility = visibilityOf(dashboard.shares);

  return (
    <section
      className={wallboard ? 'dashboard-page is-wallboard' : 'dashboard-page'}
      aria-labelledby={titleId}
    >
      <div className="board-header">
        <h1 id={titleId} className="page-title">
          {dashboard.name}
        </h1>
        {wallboard && (
          <div className="dashboard-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => void document.documentElement.requestFullscreen?.()}
            >
              {t('dashboards.fullScreen')}
            </button>
            <a className="board-settings-link" href={routeHref(`#/dashboards/${dashboard.id}`)}>
              {t('dashboards.leaveWallboard')}
            </a>
          </div>
        )}
        {!wallboard && (
          <p className="board-meta">
            {t('dashboards.meta', { owner: dashboard.owner.name })}
            {dashboard.isDefault && ` ${t('dashboards.isDefault')}`}
          </p>
        )}
      </div>
      {!wallboard && (
        <div className="dashboard-actions">
          {dashboard.editable && !editing && (
            <button type="button" className="button-primary" onClick={startEditing}>
              {t('dashboards.edit')}
            </button>
          )}
          {!editing && (
            <>
              <button type="button" className="button-secondary" onClick={() => void copy()}>
                {t('dashboards.copy')}
              </button>
              <a
                className="board-settings-link"
                href={routeHref(
                  `#/dashboards/${dashboard.id}/wallboard?rotate=${dashboard.id}&seconds=60`,
                )}
              >
                {t('dashboards.wallboard')}
              </a>
            </>
          )}
          {admin && !dashboard.isDefault && !editing && (
            <button type="button" className="button-secondary" onClick={() => void makeDefault()}>
              {t('dashboards.makeDefault')}
            </button>
          )}
          {dashboard.editable && !editing && (
            <div className="form-field dashboard-visibility">
              <label htmlFor={`${titleId}-visibility`}>{t('dashboards.visibility')}</label>
              <select
                id={`${titleId}-visibility`}
                value={visibility}
                onChange={(e) => void share(e.target.value as Visibility)}
              >
                <option value="private">{t('dashboards.visibility.private')}</option>
                <option value="any_user">{t('dashboards.visibility.any_user')}</option>
                <option value="public">{t('dashboards.visibility.public')}</option>
                {visibility === 'custom' && (
                  <option value="custom">{t('dashboards.visibility.custom')}</option>
                )}
              </select>
            </div>
          )}
        </div>
      )}
      {editing && draft && (
        <div className="reports-controls dashboard-editor">
          <div className="form-field">
            <label htmlFor={`${titleId}-name`}>{t('dashboards.name')}</label>
            <input
              id={`${titleId}-name`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${titleId}-layout`}>{t('dashboards.layout')}</label>
            <select
              id={`${titleId}-layout`}
              value={draft.layout}
              onChange={(e) => {
                const next = e.target.value as Layout;
                const last = COLUMNS[next] - 1;
                setDraft({
                  ...draft,
                  layout: next,
                  widgets: draft.widgets.map((w) => ({ ...w, column: Math.min(w.column, last) })),
                });
              }}
            >
              {LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {t(`dashboards.layout.${l}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${titleId}-kind`}>{t('dashboards.addKind')}</label>
            <select
              id={`${titleId}-kind`}
              value={adding}
              onChange={(e) => setAdding(e.target.value as WidgetKind)}
            >
              {WIDGET_KINDS.map((k) => {
                // A sprint widget reads a Scrum board: with none, it could not be saved.
                const blocked =
                  SETTINGS[k].includes('board') && !boards.some((b) => b.kind === 'scrum');
                const name = t(`dashboards.kind.${k}`);
                return (
                  <option key={k} value={k} disabled={blocked}>
                    {blocked ? t('dashboards.setting.needsScrumBoard', { name }) : name}
                  </option>
                );
              })}
            </select>
          </div>
          <button type="button" className="button-secondary" onClick={add}>
            {t('dashboards.add')}
          </button>
          <button type="button" className="button-primary" onClick={() => void save()}>
            {t('dashboards.save')}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setDraft(null);
              setSettingsOf(null);
            }}
          >
            {t('dashboards.cancel')}
          </button>
          <button type="button" className="button-danger" onClick={() => void remove()}>
            {t('dashboards.delete')}
          </button>
        </div>
      )}
      {status && (
        <p className="report-note" role="status">
          {status}
        </p>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {widgets.length === 0 ? (
        <p className="report-empty">
          {dashboard.editable ? t('dashboards.emptyEditable') : t('dashboards.empty')}
        </p>
      ) : (
        <div className={`dashboard-grid layout-${layout}`} style={grid}>
          {Array.from({ length: columns }, (_, column) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
            <div key={column} className="dashboard-column">
              {widgets
                .filter((w) => w.column === column)
                .map((w) => (
                  <article key={w.id} className="dashboard-widget" aria-label={widgetTitle(t, w)}>
                    <h2 className="dashboard-widget-title">{widgetTitle(t, w)}</h2>
                    {editing && (
                      <div className="dashboard-widget-tools">
                        <button
                          aria-label={t('dashboards.tool.settings', { name: widgetTitle(t, w) })}
                          type="button"
                          onClick={() => setSettingsOf(w.id)}
                        >
                          {t('dashboards.toolShort.settings')}
                        </button>
                        <button
                          aria-label={t('dashboards.tool.up', { name: widgetTitle(t, w) })}
                          type="button"
                          onClick={() => move(w.id, { place: -1 })}
                        >
                          {t('dashboards.toolShort.up')}
                        </button>
                        <button
                          aria-label={t('dashboards.tool.down', { name: widgetTitle(t, w) })}
                          type="button"
                          onClick={() => move(w.id, { place: 1 })}
                        >
                          {t('dashboards.toolShort.down')}
                        </button>
                        {columns > 1 && (
                          <>
                            <button
                              aria-label={t('dashboards.tool.left', { name: widgetTitle(t, w) })}
                              type="button"
                              onClick={() => move(w.id, { column: -1 })}
                            >
                              {t('dashboards.toolShort.left')}
                            </button>
                            <button
                              aria-label={t('dashboards.tool.right', { name: widgetTitle(t, w) })}
                              type="button"
                              onClick={() => move(w.id, { column: 1 })}
                            >
                              {t('dashboards.toolShort.right')}
                            </button>
                          </>
                        )}
                        <button
                          aria-label={t('dashboards.tool.remove', { name: widgetTitle(t, w) })}
                          type="button"
                          onClick={() => changeWidgets((list) => list.filter((x) => x.id !== w.id))}
                        >
                          {t('dashboards.toolShort.remove')}
                        </button>
                      </div>
                    )}
                    {editing && settingsOf === w.id ? (
                      <WidgetSettings
                        widget={w}
                        boards={boards}
                        onSave={(title, config) => {
                          changeWidgets((list) =>
                            list.map((x) => (x.id === w.id ? { ...x, title, config } : x)),
                          );
                          setSettingsOf(null);
                        }}
                        onCancel={() => setSettingsOf(null)}
                        checkQuery={(q) => client.checkQuery(q)}
                      />
                    ) : editing && w.id.startsWith('new-') ? (
                      <p className="report-empty">{t('dashboards.unsaved')}</p>
                    ) : (
                      <WidgetView
                        // A new key reads the data again: after a save, and on a wallboard.
                        key={`${w.id}-${refresh}`}
                        dashboardId={dashboard.id}
                        widget={w}
                        client={client}
                      />
                    )}
                  </article>
                ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
