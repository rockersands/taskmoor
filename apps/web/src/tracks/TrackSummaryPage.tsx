import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  dashboardClient,
  type Layout,
  WIDGET_KINDS,
  type Widget,
  type WidgetKind,
} from '../dashboards/client';
import {
  type BoardChoice,
  fitWidgets,
  WidgetEditorFields,
  WidgetGrid,
} from '../dashboards/WidgetEditor';
import { defaultConfig, SETTINGS } from '../dashboards/WidgetSettings';
import { WidgetView } from '../dashboards/WidgetView';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, onRouteChange, replaceRoute, routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type TrackClient, type TrackSummaryLayout, trackClient } from './client';
import { TrackNumbers } from './TrackNumbers';
import { useTrackSections } from './trackSections';

export interface TrackSummaryPageProps {
  trackKey: string;
  client?: TrackClient;
  /** Checks a widget's query before it is kept; the search's check. */
  checkQuery?: (query: string) => Promise<boolean>;
}

/** The viewer's own filter in a Summary's address (T-075a), or '' for none. */
export function filterOfRoute(route: string): string {
  const at = route.indexOf('?');
  return (new URLSearchParams(at < 0 ? '' : route.slice(at + 1)).get('filter') ?? '').trim();
}

/** The route with this filter in it ('' takes it out), keeping what else it says. */
export function routeWithFilter(route: string, filter: string): string {
  const at = route.indexOf('?');
  const path = at < 0 ? route : route.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : route.slice(at + 1));
  if (filter.trim()) params.set('filter', filter.trim());
  else params.delete('filter');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** What "My tickets" fills in. */
const MINE = 'assignee = currentUser()';

/** Today's numbers as the one widget a first customization starts from. */
const NUMBERS: Widget = {
  id: 'new-numbers',
  kind: 'track-summary',
  column: 0,
  title: '',
  config: {},
};

/**
 * A track's Summary (M1-064; RPT-006; ADR-116): its numbers until someone customizes it, then the
 * widgets its owner and administrators chose, which everyone else who sees the track reads as they
 * are, each through their own permission filter. "Back to the default" removes the customization
 * for everyone, so it asks first and says so (D13, T-273); after it, focus goes to the heading.
 *
 * Everyone who reads it may also filter it for themselves (T-075a; RPT-006 "view and filter"): a
 * condition in the query language that every number and widget must also meet. It lives in the
 * page's address (`?filter=`), so it is the viewer's own, survives a reload and can be bookmarked,
 * and it is never saved: the layout everyone shares stays as its owner set it. Sprint widgets read
 * a sprint, not a query, and are not narrowed. Customizing shows the widgets unfiltered.
 */
export function TrackSummaryPage({
  trackKey,
  client = trackClient,
  checkQuery = dashboardClient.checkQuery,
}: TrackSummaryPageProps) {
  const t = useT();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // After going back to the default its button is gone, so focus goes to the page's heading.
  const [focusHeading, setFocusHeading] = useState(false);
  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    setFocusHeading(false);
  }, [focusHeading]);
  const sections = useTrackSections();
  const [read, setRead] = useState<TrackSummaryLayout | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<{ layout: Layout; widgets: Widget[] } | null>(null);
  const [settingsOf, setSettingsOf] = useState<string | null>(null);
  const [adding, setAdding] = useState<WidgetKind>('search-results');
  const [boards, setBoards] = useState<BoardChoice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The address holds the filter; replacing it tells no one, so the page keeps it as well.
  const [filter, setFilter] = useState(() => filterOfRoute(currentRoute()));
  useEffect(() => onRouteChange(() => setFilter(filterOfRoute(currentRoute()))), []);
  // While customizing, the widgets show as everyone will see them.
  const shown = draft ? '' : filter;
  const widgetClient = useMemo(
    () => ({
      widget: (_: number, id: string) => client.summaryWidget(trackKey, id, shown || undefined),
    }),
    [client, trackKey, shown],
  );

  useEffect(() => {
    let live = true;
    client.summaryLayout(trackKey).then(
      (found) => live && setRead(found),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  if (failed) {
    return (
      <section className="page track-summary" aria-labelledby={titleId}>
        <PageHeader
          titleId={titleId}
          title={t('track.section.summary')}
          purpose={t('summary.purpose')}
        />
        <p className="board-problem" role="alert">
          {t('summary.notFound')}
        </p>
      </section>
    );
  }
  if (!read) return <p className="report-loading">{t('reports.loading')}</p>;

  const { custom } = read;
  // A Kanban track has no sprints: their widgets stay in the editor, to take away, and show nowhere.
  const needsSprints = (w: Widget) => SETTINGS[w.kind].includes('board');
  const widgets =
    draft?.widgets ??
    (custom?.widgets ?? []).filter((w) => !(sections?.sprints === false && needsSprints(w)));
  const layout = draft?.layout ?? custom?.layout ?? 'one';
  const kinds: WidgetKind[] = [
    ...WIDGET_KINDS,
    ...(widgets.some((w) => w.kind === 'track-summary') ? [] : ['track-summary' as const]),
  ].filter((k) => !SETTINGS[k].includes('board') || boards.some((b) => b.kind === 'scrum'));

  const customize = () => {
    setDraft(
      custom
        ? { layout: custom.layout, widgets: custom.widgets }
        : { layout: 'one', widgets: [NUMBERS] },
    );
    setStatus(null);
    setProblem(null);
    // Sprint widgets read the track's one board, when it is a Scrum board.
    client.board(trackKey).then(
      (b) => setBoards([{ id: b.id, name: b.name, kind: b.kind }]),
      () => setBoards([]),
    );
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
    if (adding !== 'track-summary') setSettingsOf(made.id);
    setAdding('search-results');
  };
  const save = async () => {
    if (!draft) return;
    const outcome = await client.saveSummaryLayout(trackKey, {
      layout: draft.layout,
      // New widgets get their ids from the server.
      widgets: draft.widgets.map((w) => {
        const { id, ...rest } = w;
        return id.startsWith('new-') ? rest : w;
      }),
      ...(custom ? { version: custom.version } : {}),
    });
    if (outcome.ok) {
      setRead(outcome.read);
      setDraft(null);
      setSettingsOf(null);
      setProblem(null);
      setStatus(t('dashboards.saved'));
      setRefresh((n) => n + 1);
    } else {
      setProblem(
        t(
          outcome.error === 'version_conflict'
            ? 'summary.conflict'
            : outcome.error === 'forbidden'
              ? 'summary.forbidden'
              : 'dashboards.invalid',
        ),
      );
    }
  };
  // Asked and answered by DangerAction; a refusal keeps its question open, saying why here.
  const backToDefault = async () => {
    setProblem(null);
    try {
      await client.resetSummaryLayout(trackKey);
    } catch (error) {
      setProblem(t('summary.forbidden'));
      throw error;
    }
    setRead((r) => r && { ...r, custom: null });
    setDraft(null);
    setSettingsOf(null);
    setStatus(t('summary.backToDefaultDone'));
    setFocusHeading(true);
  };

  const showWidgets = draft !== null || custom !== null;
  const sprintWidgets = showWidgets && widgets.some(needsSprints);

  return (
    <section className="page track-summary" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        titleRef={heading}
        // Titled by its section, the track named above it, like the track's other pages (D26).
        title={t('track.section.summary')}
        eyebrow={read.track.name}
        purpose={t('summary.purpose')}
        about={t('summary.about')}
        actions={
          !draft && (
            <>
              <a
                className="button-quiet"
                href={routeHref(`#/tracks/${encodeURIComponent(read.track.key)}/templates`)}
              >
                {t('summary.templates')}
              </a>
              <a
                className="button-quiet"
                href={routeHref(`#/tracks/${encodeURIComponent(read.track.key)}/areas`)}
              >
                {t('areas.title')}
              </a>
              {read.mayCustomize && (
                <button type="button" className="button-primary" onClick={customize}>
                  {t('summary.customize')}
                </button>
              )}
              {read.mayCustomize && custom && (
                <DangerAction
                  label={t('summary.backToDefault')}
                  outcome={t('summary.resetOutcome', { track: read.track.name })}
                  confirmLabel={t('summary.resetOf', { track: read.track.name })}
                  onConfirm={backToDefault}
                />
              )}
            </>
          )
        }
      />
      {draft && (
        <div className="reports-controls dashboard-editor">
          <WidgetEditorFields
            idPrefix={titleId}
            layout={draft.layout}
            onLayout={(next) =>
              setDraft({ layout: next, widgets: fitWidgets(draft.widgets, next) })
            }
            adding={adding}
            onAdding={setAdding}
            kinds={kinds}
            boards={boards}
            onAdd={add}
          />
          <button type="button" className="button-primary" onClick={() => void save()}>
            {t('summary.save')}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setDraft(null);
              setSettingsOf(null);
              setProblem(null);
            }}
          >
            {t('dashboards.cancel')}
          </button>
        </div>
      )}
      {!draft && (
        <SummaryFilter
          applied={filter}
          checkQuery={checkQuery}
          sprintWidgets={sprintWidgets}
          onApply={(next) => {
            setFilter(next);
            replaceRoute(routeWithFilter(currentRoute(), next));
          }}
        />
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
      {!showWidgets ? (
        <TrackNumbers trackKey={trackKey} client={client} filter={shown} />
      ) : widgets.length === 0 ? (
        <EmptyState title={t('summary.emptyTitle')}>
          {t(read.mayCustomize ? 'summary.emptyEditable' : 'summary.empty')}
        </EmptyState>
      ) : (
        <WidgetGrid
          layout={layout}
          widgets={widgets}
          editing={draft !== null}
          settingsOf={settingsOf}
          onSettingsOf={setSettingsOf}
          onChange={changeWidgets}
          boards={boards}
          checkQuery={checkQuery}
          queryHint={t('summary.queryHint')}
          renderWidget={(w) =>
            w.kind === 'track-summary' ? (
              <TrackNumbers key={refresh} trackKey={trackKey} client={client} filter={shown} />
            ) : draft && w.id.startsWith('new-') ? (
              <p className="report-note">{t('summary.unsaved')}</p>
            ) : (
              <WidgetView
                // A new key reads the data again after a save.
                key={`${w.id}-${refresh}`}
                dashboardId={read.track.id}
                widget={w}
                client={widgetClient}
              />
            )
          }
        />
      )}
    </section>
  );
}

/**
 * The viewer's own filter on the Summary (T-075a): a query-language condition, checked like a
 * search before it applies, with "My tickets" at hand. It says plainly that only they see it.
 */
function SummaryFilter({
  applied,
  checkQuery,
  sprintWidgets,
  onApply,
}: {
  applied: string;
  checkQuery: (query: string) => Promise<boolean>;
  /** Whether the Summary shows sprint widgets, which a filter does not narrow. */
  sprintWidgets: boolean;
  onApply: (filter: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(applied);
  const [bad, setBad] = useState(false);
  // The address is the truth: Back, a bookmark or Clear set what the field shows.
  useEffect(() => {
    setText(applied);
    setBad(false);
  }, [applied]);

  const apply = async (next: string) => {
    const wanted = next.trim();
    if (wanted && !(await checkQuery(wanted).catch(() => false))) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(wanted);
    onApply(wanted);
  };

  return (
    <form
      className="summary-filter"
      aria-label={t('summary.filter.label')}
      onSubmit={(event) => {
        event.preventDefault();
        void apply(text);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-filter`}>{t('summary.filter.field')}</label>
        <input
          id={`${id}-filter`}
          value={text}
          spellCheck={false}
          autoComplete="off"
          maxLength={2000}
          placeholder={t('summary.filter.placeholder')}
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-note`}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="summary-filter-actions">
        <button type="submit" className="button-secondary">
          {t('summary.filter.apply')}
        </button>
        <button type="button" className="button-quiet" onClick={() => void apply(MINE)}>
          {t('summary.filter.mine')}
        </button>
        {applied && (
          <button type="button" className="button-quiet" onClick={() => void apply('')}>
            {t('summary.filter.clear')}
          </button>
        )}
      </div>
      <p id={`${id}-note`} className="page-note summary-filter-note">
        {t('summary.filter.note')}
      </p>
      {bad && (
        <p className="form-error" role="alert">
          {t('summary.filter.bad')}
        </p>
      )}
      {applied && (
        <p className="report-note summary-filter-on">
          {t('summary.filter.on', { filter: applied })}
          {sprintWidgets && ` ${t('summary.filter.sprints')}`}
        </p>
      )}
    </form>
  );
}
