import { type FormEvent, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { Widget, WidgetKind } from './client';

/** The settings each kind asks for, in order (the server's `dashboards/model.ts`). */
type Setting =
  | 'text'
  | 'links'
  | 'query'
  | 'limit'
  | 'days'
  | 'period'
  | 'cumulative'
  | 'field'
  | 'x'
  | 'y'
  | 'sort'
  | 'board';

export const SETTINGS: Readonly<Record<WidgetKind, readonly Setting[]>> = {
  introduction: ['text'],
  'quick-links': ['links'],
  'search-results': ['query', 'limit'],
  'assigned-to-me': ['limit'],
  'followed-tickets': ['limit'],
  'created-vs-closed': ['query', 'days', 'period', 'cumulative'],
  'recently-created': ['query', 'days', 'period'],
  'average-age': ['query', 'days', 'period'],
  'time-to-close': ['query', 'days', 'period'],
  pie: ['query', 'field'],
  'ticket-statistics': ['query', 'field', 'sort'],
  'two-dimensional': ['query', 'x', 'y'],
  'sprint-burndown': ['board'],
  'sprint-health': ['board'],
  'days-remaining': ['board'],
  'average-time-in-status': ['query', 'days'],
  'track-summary': [],
};

/** Fields a widget can group by (the server's axes); custom fields as `cf[<id>]`. */
const AXES = [
  'status',
  'priority',
  'type',
  'track',
  'assignee',
  'requester',
  'creator',
  'closeReason',
  'labels',
  'targetRelease',
  'foundInRelease',
  'area',
];

/** A new widget's settings: what the server fills in, so the form starts from them. */
export function defaultConfig(kind: WidgetKind, boardId: number | null): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const s of SETTINGS[kind]) {
    if (s === 'text') config.text = '';
    if (s === 'links') config.links = [];
    if (s === 'query') config.query = '';
    if (s === 'limit') config.limit = 10;
    if (s === 'days') config.days = 30;
    if (s === 'period') config.period = 'day';
    if (s === 'cumulative') config.cumulative = false;
    if (s === 'field') config.field = 'status';
    if (s === 'x') config.x = 'status';
    if (s === 'y') config.y = 'priority';
    if (s === 'sort') config.sort = 'natural';
    if (s === 'board' && boardId !== null) config.boardId = boardId;
  }
  return config;
}

export interface WidgetSettingsProps {
  widget: Widget;
  boards: { id: number; name: string; kind: 'scrum' | 'kanban' }[];
  onSave: (title: string, config: Record<string, unknown>) => void;
  onCancel: () => void;
  /** Asks the server whether a query can be read; saved as written without it. */
  checkQuery?: (query: string) => Promise<boolean>;
  /** What an empty query means where the widget lives; every ticket the viewer sees otherwise. */
  queryHint?: string;
}

/** A widget's title and settings, one form per kind (M1-064; RPT-005). */
export function WidgetSettings({
  widget,
  boards,
  onSave,
  onCancel,
  checkQuery,
  queryHint,
}: WidgetSettingsProps) {
  const t = useT();
  const id = useId();
  const [title, setTitle] = useState(widget.title);
  const [config, setConfig] = useState<Record<string, unknown>>({ ...widget.config });
  const set = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const links = (config.links as { label: string; url: string }[] | undefined) ?? [];
  const scrum = boards.filter((b) => b.kind === 'scrum');
  const [badQuery, setBadQuery] = useState(false);
  const needsBoard = SETTINGS[widget.kind].includes('board') && config.boardId === undefined;

  const field = (key: Setting) => {
    const fid = `${id}-${key}`;
    switch (key) {
      case 'text':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>{t('dashboards.setting.text')}</label>
            <textarea
              id={fid}
              rows={4}
              value={String(config.text ?? '')}
              onChange={(e) => set('text', e.target.value)}
            />
          </div>
        );
      case 'links':
        return (
          <fieldset className="reports-choices widget-links-editor" key={key}>
            <legend>{t('dashboards.setting.links')}</legend>
            {links.map((l, i) => (
              // Links have no ids of their own; their place is who they are while editing.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <div className="widget-link-row" key={i}>
                <div className="form-field">
                  <label htmlFor={`${fid}-${i}-label`}>{t('dashboards.setting.linkLabel')}</label>
                  <input
                    id={`${fid}-${i}-label`}
                    value={l.label}
                    onChange={(e) =>
                      set(
                        'links',
                        links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={`${fid}-${i}-url`}>{t('dashboards.setting.linkUrl')}</label>
                  <input
                    id={`${fid}-${i}-url`}
                    value={l.url}
                    onChange={(e) =>
                      set(
                        'links',
                        links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() =>
                    set(
                      'links',
                      links.filter((_, j) => j !== i),
                    )
                  }
                >
                  {t('dashboards.setting.linkRemove', { label: l.label || String(i + 1) })}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button-secondary"
              onClick={() => set('links', [...links, { label: '', url: '' }])}
            >
              {t('dashboards.setting.linkAdd')}
            </button>
          </fieldset>
        );
      case 'query':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>{t('dashboards.setting.query')}</label>
            <textarea
              id={fid}
              rows={2}
              value={String(config.query ?? '')}
              placeholder={queryHint ?? t('dashboards.setting.queryHint')}
              aria-invalid={badQuery}
              aria-describedby={badQuery ? `${fid}-problem` : undefined}
              onChange={(e) => {
                setBadQuery(false);
                set('query', e.target.value);
              }}
            />
            {badQuery && (
              <p id={`${fid}-problem`} className="form-error" role="alert">
                {t('dashboards.setting.queryInvalid')}
              </p>
            )}
          </div>
        );
      case 'limit':
      case 'days':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>
              {t(key === 'limit' ? 'dashboards.setting.limit' : 'dashboards.setting.days')}
            </label>
            <input
              id={fid}
              type="number"
              inputMode="numeric"
              min={1}
              max={key === 'limit' ? 50 : 731}
              value={Number(config[key] ?? 1)}
              onChange={(e) => set(key, Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        );
      case 'period':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>{t('dashboards.setting.period')}</label>
            <select
              id={fid}
              value={String(config.period ?? 'day')}
              onChange={(e) => set('period', e.target.value)}
            >
              <option value="day">{t('dashboards.period.day')}</option>
              <option value="week">{t('dashboards.period.week')}</option>
              <option value="month">{t('dashboards.period.month')}</option>
            </select>
          </div>
        );
      case 'cumulative':
        return (
          <label className="reports-check" key={key}>
            <input
              type="checkbox"
              checked={Boolean(config.cumulative)}
              onChange={(e) => set('cumulative', e.target.checked)}
            />
            {t('dashboards.setting.cumulative')}
          </label>
        );
      case 'field':
      case 'x':
      case 'y':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>
              {t(
                key === 'field'
                  ? 'dashboards.setting.field'
                  : key === 'x'
                    ? 'dashboards.setting.x'
                    : 'dashboards.setting.y',
              )}
            </label>
            <input
              id={fid}
              list={`${id}-axes`}
              value={String(config[key] ?? '')}
              onChange={(e) => set(key, e.target.value.trim())}
            />
          </div>
        );
      case 'sort':
        return (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>{t('dashboards.setting.sort')}</label>
            <select
              id={fid}
              value={String(config.sort ?? 'natural')}
              onChange={(e) => set('sort', e.target.value)}
            >
              <option value="natural">{t('dashboards.sort.natural')}</option>
              <option value="total">{t('dashboards.sort.total')}</option>
            </select>
          </div>
        );
      case 'board':
        return scrum.length === 0 ? (
          <p className="report-empty" key={key}>
            {t('dashboards.setting.noBoards')}
          </p>
        ) : (
          <div className="form-field" key={key}>
            <label htmlFor={fid}>{t('dashboards.setting.board')}</label>
            <select
              id={fid}
              value={String(config.boardId ?? '')}
              onChange={(e) => set('boardId', Number(e.target.value))}
            >
              {config.boardId === undefined && (
                <option value="">{t('dashboards.setting.chooseBoard')}</option>
              )}
              {scrum.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        );
    }
  };

  return (
    <form
      className="widget-settings"
      aria-label={t('dashboards.settingsOf', { kind: t(`dashboards.kind.${widget.kind}`) })}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const query = String(config.query ?? '').trim();
        // A query the server cannot read would leave the widget failing on the dashboard.
        if (query && checkQuery) {
          void checkQuery(query).then(
            (ok) => {
              if (ok) onSave(title.trim(), config);
              else setBadQuery(true);
            },
            () => onSave(title.trim(), config),
          );
          return;
        }
        onSave(title.trim(), config);
      }}
    >
      <datalist id={`${id}-axes`}>
        {AXES.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <div className="form-field">
        <label htmlFor={`${id}-title`}>{t('dashboards.setting.title')}</label>
        <input
          id={`${id}-title`}
          value={title}
          placeholder={t(`dashboards.kind.${widget.kind}`)}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {SETTINGS[widget.kind].map(field)}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={needsBoard}>
          {t('dashboards.setting.apply')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('dashboards.cancel')}
        </button>
      </div>
    </form>
  );
}
