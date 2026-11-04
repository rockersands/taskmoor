import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import { GripIcon } from '../shell/MoveMenu';
import { playMotion } from '../shell/motion';
import { followPointerDrag } from '../shell/pointerDrag';
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

/**
 * A widget dropped in a column, before another widget or at the column's end (T-162). A column
 * shows its widgets in the list's order, so only that order and the widget's column change.
 */
export function placeWidget(
  list: Widget[],
  widgetId: string,
  column: number,
  before: string | null,
): Widget[] {
  const moving = list.find((w) => w.id === widgetId);
  if (!moving || before === widgetId) return list;
  const rest = list.filter((w) => w.id !== widgetId);
  let at = before === null ? -1 : rest.findIndex((w) => w.id === before);
  if (at < 0) {
    // At the end of the column: just after its last widget, or at the end of all of them.
    const last = rest.findLastIndex((w) => w.column === column);
    at = last < 0 ? rest.length : last + 1;
  }
  return [...rest.slice(0, at), { ...moving, column }, ...rest.slice(at)];
}

/** Where a widget is: its column from 1, its place in it from 1, and how many the column holds. */
export function widgetPlace(list: Widget[], widgetId: string) {
  const widget = list.find((w) => w.id === widgetId);
  if (!widget) return null;
  const column = list.filter((w) => w.column === widget.column);
  return {
    column: widget.column + 1,
    place: column.findIndex((w) => w.id === widgetId) + 1,
    count: column.length,
  };
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

/** A move a widget's buttons make, and the button that keeps the keyboard after it. */
type Tool = 'up' | 'down' | 'left' | 'right';
const STEPS: Record<Tool, { column?: number; place?: number }> = {
  up: { place: -1 },
  down: { place: 1 },
  left: { column: -1 },
  right: { column: 1 },
};
const KEYS: Record<string, Tool> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Where a dragged widget would land: a column, before a widget or at its end. */
interface Spot {
  column: number;
  before: string | null;
}

/**
 * Widgets in the layout's columns (M1-064; RPT-004, RPT-006). While editing, each has buttons to
 * open its settings, move it and remove it, and moves by drag (T-162; ADR-114, section 12): by its
 * grip with a mouse or a finger, or by its title with a mouse, to a place in any column. The
 * column and the place are marked while it travels, Escape cancels, and every move, by drag, by a
 * button or by Alt and an arrow key on its buttons, is announced. Nothing is saved until the
 * dashboard is: the server checks the layout then.
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
  const grid = useRef<HTMLDivElement>(null);
  const columns = COLUMNS[layout];
  const style = { '--dashboard-columns': columns } as CSSProperties;
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Spot | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState('');
  /** After a move: the widget that settles in, and the button that gets the keyboard back. */
  const after = useRef<{ widget: string; tool: Tool | null } | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const nameOf = (widgetId: string) => {
    const w = widgets.find((x) => x.id === widgetId);
    return w ? widgetTitle(t, w) : '';
  };

  useEffect(() => {
    const moved = after.current;
    if (!moved) return;
    after.current = null;
    const card = grid.current?.querySelector<HTMLElement>(`[data-widget-id="${moved.widget}"]`);
    if (!card) return;
    if (moved.tool) card.querySelector<HTMLElement>(`[data-tool="${moved.tool}"]`)?.focus();
    else playMotion(card, 'motion-drop');
    const where = widgetPlace(widgets, moved.widget);
    if (where) setSaid(t('dashboards.moved', { name: nameOf(moved.widget), ...where }));
  });

  /**
   * Changes the list and, if anything moved, says where the widget is now. What is shown is each
   * column's widgets in order: a change to the list that leaves those as they were moves nothing.
   */
  const apply = (widgetId: string, change: (list: Widget[]) => Widget[], tool: Tool | null) => {
    const shown = (list: Widget[]) =>
      Array.from({ length: columns }, (_, c) =>
        list
          .filter((w) => w.column === c)
          .map((w) => w.id)
          .join(),
      ).join('|');
    if (shown(change(widgets)) === shown(widgets)) {
      setSaid(t('dashboards.stayed', { name: nameOf(widgetId) }));
      return;
    }
    after.current = { widget: widgetId, tool };
    onChange(change);
  };
  const step = (widgetId: string, tool: Tool) =>
    apply(widgetId, (list) => moveWidget(list, columns, widgetId, STEPS[tool]), tool);

  /** What is under the pointer, as a place in a column (T-162). */
  function spotAt(x: number, y: number): Spot | null {
    const element = document.elementFromPoint?.(x, y);
    const holder = element?.closest<HTMLElement>('[data-drop-column]');
    if (!element || !holder) return null;
    const column = Number(holder.dataset.dropColumn);
    const card = element.closest<HTMLElement>('[data-widget-id]');
    if (!card || !holder.contains(card)) return { column, before: null };
    const target = card.dataset.widgetId ?? '';
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return { column, before: target };
    // Below a card's middle: before the widget after it, the dragged one included, so a drop on
    // the lower half of its own card, or of the card above it, leaves it where it is.
    const inColumn = widgets.filter((w) => w.column === column);
    const next = inColumn[inColumn.findIndex((w) => w.id === target) + 1];
    return { column, before: next?.id ?? null };
  }
  const live = useRef({ spotAt, apply });
  live.current = { spotAt, apply };

  function beginDrag(event: ReactPointerEvent, widget: Widget) {
    if (stopDrag.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const name = widgetTitle(t, widget);
    stopDrag.current = followPointerDrag(event, {
      start: (x, y) => {
        setDragging(widget.id);
        setGhost({ x, y });
        setSaid(t('dashboards.drag.start', { name }));
      },
      move: (x, y) => {
        setGhost({ x, y });
        const spot = live.current.spotAt(x, y);
        setOver((current) =>
          current?.column === spot?.column && current?.before === spot?.before ? current : spot,
        );
      },
      drop: (x, y) => {
        const spot = live.current.spotAt(x, y);
        setDragging(null);
        setOver(null);
        setGhost(null);
        if (!spot) {
          setSaid(t('dashboards.stayed', { name }));
          return;
        }
        live.current.apply(
          widget.id,
          (list) => placeWidget(list, widget.id, spot.column, spot.before),
          null,
        );
      },
      cancel: () => {
        setDragging(null);
        setOver(null);
        setGhost(null);
        setSaid(t('dashboards.stayed', { name }));
      },
      end: () => {
        stopDrag.current = null;
      },
    });
  }

  /** Alt and an arrow key on a widget's buttons: the same move as the button of that arrow. */
  const onToolsKey = (event: KeyboardEvent, widget: Widget) => {
    const tool = KEYS[event.key];
    if (!event.altKey || !tool) return;
    event.preventDefault();
    if ((tool === 'left' || tool === 'right') && columns === 1) return;
    step(widget.id, tool);
  };

  const toolButton = (w: Widget, tool: Tool) => (
    <button
      aria-label={t(`dashboards.tool.${tool}`, { name: widgetTitle(t, w) })}
      type="button"
      data-tool={tool}
      onClick={() => step(w.id, tool)}
      onKeyDown={(event) => onToolsKey(event, w)}
    >
      {t(`dashboards.toolShort.${tool}`)}
    </button>
  );

  return (
    <>
      {editing && (
        <p className="report-note">
          {t(columns > 1 ? 'dashboards.drag.hint' : 'dashboards.drag.hintOne')}
        </p>
      )}
      <div
        ref={grid}
        className={`dashboard-grid layout-${layout}${editing ? ' is-editing' : ''}`}
        style={style}
      >
        {Array.from({ length: columns }, (_, column) => {
          const held = widgets.filter((w) => w.column === column);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
              key={column}
              className={`dashboard-column${over?.column === column ? ' is-drop-target' : ''}`}
              data-drop-column={editing ? column : undefined}
            >
              {editing && held.length === 0 && (
                <p className="dashboard-column-empty">
                  {t('dashboards.column.empty', { column: column + 1 })}
                </p>
              )}
              {held.map((w) => (
                <article
                  key={w.id}
                  className={`dashboard-widget${dragging === w.id ? ' is-dragging' : ''}${
                    over?.column === column && over.before === w.id ? ' is-drop-before' : ''
                  }`}
                  aria-label={widgetTitle(t, w)}
                  data-widget-id={w.id}
                >
                  <div className="dashboard-widget-head">
                    {editing && (
                      // A pointer's handle: the buttons below are the keyboard's way.
                      <span
                        className="dashboard-widget-grip"
                        aria-hidden="true"
                        onPointerDown={(event) => beginDrag(event, w)}
                      >
                        <GripIcon />
                      </span>
                    )}
                    <h2
                      className="dashboard-widget-title"
                      onPointerDown={(event) => {
                        if (editing && event.pointerType === 'mouse') beginDrag(event, w);
                      }}
                    >
                      {widgetTitle(t, w)}
                    </h2>
                  </div>
                  {editing && (
                    <div className="dashboard-widget-tools">
                      {SETTINGS[w.kind].length > 0 ? (
                        <button
                          aria-label={t('dashboards.tool.settings', { name: widgetTitle(t, w) })}
                          type="button"
                          onClick={() => onSettingsOf(w.id)}
                          onKeyDown={(event) => onToolsKey(event, w)}
                        >
                          {t('dashboards.toolShort.settings')}
                        </button>
                      ) : null}
                      {toolButton(w, 'up')}
                      {toolButton(w, 'down')}
                      {columns > 1 && (
                        <>
                          {toolButton(w, 'left')}
                          {toolButton(w, 'right')}
                        </>
                      )}
                      <button
                        aria-label={t('dashboards.tool.remove', { name: widgetTitle(t, w) })}
                        type="button"
                        onClick={() => onChange((list) => list.filter((x) => x.id !== w.id))}
                        onKeyDown={(event) => onToolsKey(event, w)}
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
          );
        })}
      </div>
      {editing && (
        <div className="visually-hidden" aria-live="polite">
          {said}
        </div>
      )}
      {dragging && ghost && (
        <div
          className="drag-ghost"
          aria-hidden="true"
          style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
        >
          {nameOf(dragging)}
        </div>
      )}
    </>
  );
}
