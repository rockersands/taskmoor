import { useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { navigate, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import {
  type Dashboard,
  type DashboardClient,
  type DashboardShare,
  dashboardClient,
  type Layout,
  WIDGET_KINDS,
  type Widget,
  type WidgetKind,
} from './client';
import { fitWidgets, WidgetEditorFields, WidgetGrid } from './WidgetEditor';
import { defaultConfig } from './WidgetSettings';
import { WidgetView } from './WidgetView';

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
  const [failed, setFailed] = useState<'missing' | 'failed' | null>(null);
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
      (error: unknown) =>
        live &&
        setFailed(
          error instanceof ApiError && (error.status === 404 || error.status === 403)
            ? 'missing'
            : 'failed',
        ),
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

  if (failed === 'missing') {
    // Not there, or not shared with this person: the shared not-found page, with a way on (D4).
    return <NotFoundPage title={t('notFound.dashboard')}>{t('dashboards.notFound')}</NotFoundPage>;
  }
  if (failed) {
    // Any other failure keeps the page's header, with the alert under it (UI-T22).
    return (
      <section className="page dashboard-page" aria-labelledby={titleId}>
        <PageHeader
          titleId={titleId}
          title={t('dashboards.title')}
          purpose={t('purpose.dashboard')}
        />
        <p className="board-problem" role="alert">
          {t('dashboards.failed')}
        </p>
      </section>
    );
  }
  if (!dashboard) return <p className="report-loading">{t('reports.loading')}</p>;

  const editing = draft !== null;
  const layout = draft?.layout ?? dashboard.layout;
  const widgets = draft?.widgets ?? dashboard.widgets;

  const startEditing = () => {
    setDraft({ name: dashboard.name, layout: dashboard.layout, widgets: dashboard.widgets });
    setProblem(null);
    setStatus(null);
    client.boards().then(setBoards, () => setBoards([]));
  };
  const changeWidgets = (change: (list: Widget[]) => Widget[]) =>
    setDraft((d) => (d ? { ...d, widgets: change(d.widgets) } : d));
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
  // Everyone signed in sees everyone's home whatever its shares, so one that only its owner saw
  // is shared with everyone signed in too: the choice of who sees it then says what is true.
  const makeDefault = async () => {
    setProblem(null);
    await client.setDefault(dashboard.id);
    let next: Dashboard = { ...dashboard, isDefault: true };
    let said: MessageId = 'dashboards.madeDefault';
    if (dashboard.editable && visibilityOf(dashboard.shares) === 'private') {
      const outcome = await client.update(dashboard.id, {
        shares: [{ scope: 'any_user' }],
        version: dashboard.version,
      });
      if (outcome.ok) {
        next = { ...outcome.dashboard, isDefault: true };
        said = 'dashboards.madeDefaultShared';
      } else {
        // It is everyone's home, but its sharing did not change: say so rather than let 'Who sees
        // it' disagree in silence.
        setProblem(t('dashboards.conflict'));
      }
    }
    setDashboard(next);
    setStatus(t(said));
  };
  // Asked first (D13); a refusal keeps the question open, the reason under it.
  const remove = async () => {
    setProblem(null);
    try {
      await client.remove(dashboard.id);
    } catch (error) {
      // Everyone's home dashboard stays until another one takes its place: trying again cannot help.
      setProblem(
        t(
          error instanceof ApiError && error.code === 'is_default'
            ? 'dashboards.deleteDefault'
            : 'dashboards.deleteFailed',
        ),
      );
      throw error;
    }
    navigate('#/dashboards');
  };

  const visibility = visibilityOf(dashboard.shares);

  return (
    <section
      className={wallboard ? 'page page-full dashboard-page is-wallboard' : 'page dashboard-page'}
      aria-labelledby={titleId}
    >
      <PageHeader
        titleId={titleId}
        title={dashboard.name}
        // A wallboard is read from across a room: its title and its widgets, nothing about itself.
        purpose={wallboard ? undefined : t('purpose.dashboard')}
        about={wallboard ? undefined : t('about.dashboard')}
        eyebrow={
          wallboard
            ? undefined
            : `${t('dashboards.meta', { owner: dashboard.owner.name })}${
                dashboard.isDefault ? ` ${t('dashboards.isDefault')}` : ''
              }`
        }
        actions={
          wallboard ? (
            // Read from across a room, the wallboard shows no controls (D31): the way out and full
            // screen stay hidden until a pointer or the keyboard reaches them.
            <div className="wallboard-exits">
              <button
                type="button"
                className="button-secondary"
                onClick={() => void document.documentElement.requestFullscreen?.()}
              >
                {t('dashboards.fullScreen')}
              </button>
              <a className="button-quiet" href={routeHref(`#/dashboards/${dashboard.id}`)}>
                {t('dashboards.leaveWallboard')}
              </a>
            </div>
          ) : editing ? undefined : (
            <>
              {dashboard.editable && (
                <button
                  type="button"
                  className="button-primary"
                  data-tutorial="dashboard-edit"
                  onClick={startEditing}
                >
                  {t('dashboards.edit')}
                </button>
              )}
              <button type="button" className="button-secondary" onClick={() => void copy()}>
                {t('dashboards.copy')}
              </button>
              <a
                className="button-quiet"
                href={routeHref(
                  `#/dashboards/${dashboard.id}/wallboard?rotate=${dashboard.id}&seconds=60`,
                )}
              >
                {t('dashboards.wallboard')}
              </a>
              {admin && !dashboard.isDefault && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void makeDefault()}
                >
                  {/* Beside 'Who sees it: Only me' it says it shares the dashboard too. */}
                  {t(
                    dashboard.editable && visibility === 'private'
                      ? 'dashboards.makeDefaultAndShare'
                      : 'dashboards.makeDefault',
                  )}
                </button>
              )}
              {dashboard.editable && (
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
            </>
          )
        }
      />
      {editing && draft && (
        <div
          className="glass-card reports-controls dashboard-editor"
          data-tutorial="dashboard-editor"
        >
          <div className="form-field">
            <label htmlFor={`${titleId}-name`}>{t('dashboards.name')}</label>
            <input
              id={`${titleId}-name`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <WidgetEditorFields
            idPrefix={titleId}
            layout={draft.layout}
            onLayout={(next) =>
              setDraft({ ...draft, layout: next, widgets: fitWidgets(draft.widgets, next) })
            }
            adding={adding}
            onAdding={setAdding}
            kinds={WIDGET_KINDS}
            boards={boards}
            onAdd={add}
          />
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
          {dashboard.isDefault ? (
            <p className="report-note">{t('dashboards.deleteDefault')}</p>
          ) : (
            <DangerAction
              label={t('dashboards.delete')}
              outcome={t('dashboards.confirmDelete', { name: dashboard.name })}
              confirmLabel={t('dashboards.deleteOf', { name: dashboard.name })}
              onConfirm={remove}
            />
          )}
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
        <EmptyState title={t('empty.dashboard.title')}>
          {t(dashboard.editable ? 'empty.dashboard.bodyEditable' : 'empty.dashboard.body')}
        </EmptyState>
      ) : (
        <WidgetGrid
          layout={layout}
          widgets={widgets}
          editing={editing}
          settingsOf={settingsOf}
          onSettingsOf={setSettingsOf}
          onChange={changeWidgets}
          boards={boards}
          checkQuery={(q) => client.checkQuery(q)}
          renderWidget={(w) =>
            editing && w.id.startsWith('new-') ? (
              <p className="report-empty">{t('dashboards.unsaved')}</p>
            ) : (
              <WidgetView
                // A new key reads the data again: after a save, and on a wallboard.
                key={`${w.id}-${refresh}`}
                dashboardId={dashboard.id}
                widget={w}
                client={client}
              />
            )
          }
        />
      )}
    </section>
  );
}
