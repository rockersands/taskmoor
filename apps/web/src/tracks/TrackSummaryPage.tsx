import { useEffect, useId, useMemo, useState } from 'react';
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
import { defaultConfig } from '../dashboards/WidgetSettings';
import { WidgetView } from '../dashboards/WidgetView';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type TrackClient, type TrackSummaryLayout, trackClient } from './client';
import { TrackNumbers } from './TrackNumbers';

export interface TrackSummaryPageProps {
  trackKey: string;
  client?: TrackClient;
  /** Checks a widget's query before it is kept; the search's check. */
  checkQuery?: (query: string) => Promise<boolean>;
}

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
 * are, each through their own permission filter. "Back to the default" removes the customization.
 */
export function TrackSummaryPage({
  trackKey,
  client = trackClient,
  checkQuery = dashboardClient.checkQuery,
}: TrackSummaryPageProps) {
  const t = useT();
  const titleId = useId();
  const [read, setRead] = useState<TrackSummaryLayout | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<{ layout: Layout; widgets: Widget[] } | null>(null);
  const [settingsOf, setSettingsOf] = useState<string | null>(null);
  const [adding, setAdding] = useState<WidgetKind>('search-results');
  const [boards, setBoards] = useState<BoardChoice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const widgetClient = useMemo(
    () => ({ widget: (_: number, id: string) => client.summaryWidget(trackKey, id) }),
    [client, trackKey],
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
      <section className="track-summary">
        <p className="board-problem" role="alert">
          {t('summary.notFound')}
        </p>
      </section>
    );
  }
  if (!read) return <p className="report-empty">{t('reports.loading')}</p>;

  const { custom } = read;
  const widgets = draft?.widgets ?? custom?.widgets ?? [];
  const layout = draft?.layout ?? custom?.layout ?? 'one';
  const kinds: WidgetKind[] = [
    ...WIDGET_KINDS,
    ...(widgets.some((w) => w.kind === 'track-summary') ? [] : ['track-summary' as const]),
  ];

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
  const backToDefault = async () => {
    if (!window.confirm(t('summary.confirmDefault'))) return;
    try {
      await client.resetSummaryLayout(trackKey);
      setRead({ ...read, custom: null });
      setDraft(null);
      setSettingsOf(null);
      setProblem(null);
      setStatus(t('summary.backToDefaultDone'));
    } catch {
      setProblem(t('summary.forbidden'));
    }
  };

  const showWidgets = draft !== null || custom !== null;

  return (
    <section className="track-summary" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={t('summary.title', { name: read.track.name, key: read.track.key })}
        purpose={t('summary.purpose')}
        about={t('summary.about')}
        actions={
          read.mayCustomize && !draft ? (
            <>
              <button type="button" className="button-primary" onClick={customize}>
                {t('summary.customize')}
              </button>
              {custom && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void backToDefault()}
                >
                  {t('summary.backToDefault')}
                </button>
              )}
            </>
          ) : undefined
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
        <TrackNumbers trackKey={trackKey} client={client} />
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
              <TrackNumbers key={refresh} trackKey={trackKey} client={client} />
            ) : draft && w.id.startsWith('new-') ? (
              <p className="report-empty">{t('summary.unsaved')}</p>
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
