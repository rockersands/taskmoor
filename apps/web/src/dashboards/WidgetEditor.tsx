import type { CSSProperties, ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { COLUMNS, LAYOUTS, type Layout, type Widget, type WidgetKind } from './client';
import { SETTINGS, WidgetSettings } from './WidgetSettings';
import { widgetTitle } from './WidgetView';

export type BoardChoice = { id: number; name: string; kind: 'scrum' | 'kanban' };

/** A widget moved within its column, or to the next column; the list as it was otherwise. */
export function moveWidget(
  list: Widget[],
  columns: number,
  widgetId: string,
  by: { column?: number; place?: number },
): Widget[] {
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
}

/** Widgets after a change of layout: none left beyond its last column. */
export const fitWidgets = (list: Widget[], layout: Layout): Widget[] =>
  list.map((w) => ({ ...w, column: Math.min(w.column, COLUMNS[layout] - 1) }));

export interface WidgetEditorFieldsProps {
  idPrefix: string;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  adding: WidgetKind;
  onAdding: (kind: WidgetKind) => void;
  kinds: readonly WidgetKind[];
  boards: readonly BoardChoice[];
  onAdd: () => void;
}

/** The fields shared by a dashboard's editor and a track's Summary: the layout, what to add. */
export function WidgetEditorFields({
  idPrefix,
  layout,
  onLayout,
  adding,
  onAdding,
  kinds,
  boards,
  onAdd,
}: WidgetEditorFieldsProps) {
  const t = useT();
  return (
    <>
      <div className="form-field">
        <label htmlFor={`${idPrefix}-layout`}>{t('dashboards.layout')}</label>
        <select
          id={`${idPrefix}-layout`}
          value={layout}
          onChange={(e) => onLayout(e.target.value as Layout)}
        >
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {t(`dashboards.layout.${l}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${idPrefix}-kind`}>{t('dashboards.addKind')}</label>
        <select
          id={`${idPrefix}-kind`}
          value={adding}
          onChange={(e) => onAdding(e.target.value as WidgetKind)}
        >
          {kinds.map((k) => {
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
      <button type="button" className="button-secondary" onClick={onAdd}>
        {t('dashboards.add')}
      </button>
    </>
  );
}

export interface WidgetGridProps {
  layout: Layout;
  widgets: Widget[];
  editing: boolean;
  /** The widget whose settings are open while editing. */
  settingsOf: string | null;
  onSettingsOf: (id: string | null) => void;
  /** Changes the widgets being edited. */
  onChange: (change: (list: Widget[]) => Widget[]) => void;
  boards: BoardChoice[];
  checkQuery: (query: string) => Promise<boolean>;
  /** Says what an empty query means here. */
  queryHint?: string;
  /** A widget's content when its settings are not open. */
  renderWidget: (widget: Widget) => ReactNode;
}

/**
 * Widgets in the layout's columns (M1-064; RPT-004, RPT-006). While editing, each has buttons to
 * open its settings, move it and remove it.
 */
export function WidgetGrid({
  layout,
  widgets,
  editing,
  settingsOf,
  onSettingsOf,
  onChange,
  boards,
  checkQuery,
  queryHint,
  renderWidget,
}: WidgetGridProps) {
  const t = useT();
  const columns = COLUMNS[layout];
  const grid = { '--dashboard-columns': columns } as CSSProperties;
  const move = (widgetId: string, by: { column?: number; place?: number }) =>
    onChange((list) => moveWidget(list, columns, widgetId, by));
  return (
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
                    {SETTINGS[w.kind].length > 0 ? (
                      <button
                        aria-label={t('dashboards.tool.settings', { name: widgetTitle(t, w) })}
                        type="button"
                        onClick={() => onSettingsOf(w.id)}
                      >
                        {t('dashboards.toolShort.settings')}
                      </button>
                    ) : null}
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
                      onClick={() => onChange((list) => list.filter((x) => x.id !== w.id))}
                    >
                      {t('dashboards.toolShort.remove')}
                    </button>
                  </div>
                )}
                {editing && settingsOf === w.id ? (
                  <WidgetSettings
                    widget={w}
                    boards={boards}
                    {...(queryHint ? { queryHint } : {})}
                    onSave={(title, config) => {
                      onChange((list) =>
                        list.map((x) => (x.id === w.id ? { ...x, title, config } : x)),
                      );
                      onSettingsOf(null);
                    }}
                    onCancel={() => onSettingsOf(null)}
                    checkQuery={checkQuery}
                  />
                ) : (
                  renderWidget(w)
                )}
              </article>
            ))}
        </div>
      ))}
    </div>
  );
}
