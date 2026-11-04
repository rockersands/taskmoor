import { useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { SavedSearch, SavedSearchClient, SavedSearchShare } from './savedClient';

export interface SavedSearchBarProps {
  client: SavedSearchClient;
  /** The query on the page now, saved as it is. */
  query: string;
  /** The result columns on the page now, saved with it. */
  columns: string[];
  /** The saved search the page shows, if any. */
  opened: SavedSearch | null;
  onOpen: (search: SavedSearch) => void;
  /** After a save: the saved search as it is now. */
  onSaved: (search: SavedSearch) => void;
}

type Panel = 'none' | 'saveAs' | 'share' | 'subscribe';
type Visibility = 'private' | 'any_user' | 'public';
type Message = { kind: 'status' | 'alert'; text: string } | null;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAYS = Array.from({ length: 28 }, (_, d) => d + 1);

/** The page's choice of visibility for a saved search's shares. */
function visibilityOf(shares: readonly SavedSearchShare[]): Visibility | 'custom' {
  if (shares.length === 0) return 'private';
  if (shares.length === 1 && shares[0]?.scope === 'any_user') return 'any_user';
  if (shares.length === 1 && shares[0]?.scope === 'public') return 'public';
  return 'custom';
}

/**
 * Saved searches on the search page (M1-063; QRY-011, QRY-012): open one the person may see,
 * save the query (and its columns) as a new one or into the one open, share it with everyone
 * signed in or with anyone, star it and subscribe to its results by email.
 */
export function SavedSearchBar({
  client,
  query,
  columns,
  opened,
  onOpen,
  onSaved,
}: SavedSearchBarProps) {
  const t = useT();
  const id = useId();
  const [list, setList] = useState<SavedSearch[]>([]);
  const [chosen, setChosen] = useState('');
  const [panel, setPanel] = useState<Panel>('none');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [schedule, setSchedule] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [hour, setHour] = useState(8);
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [onlyIfResults, setOnlyIfResults] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    client.list().then(
      (found) => setList(found),
      () => setList([]),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per client
  useEffect(() => {
    void reload();
  }, [client]);

  const failure = (error: unknown) => {
    const body = error instanceof ApiError ? (error.body as Record<string, unknown> | null) : null;
    if (body?.fields && (body.fields as Record<string, string>).name === 'taken') {
      return t('saved.nameTaken');
    }
    if (body?.error === 'board_outside_track') {
      const boards = (body.boards as { name: string; trackKey: string }[] | undefined) ?? [];
      return t('saved.boardOutsideTrack', {
        board: boards[0]?.name ?? '',
        track: boards[0]?.trackKey ?? '',
      });
    }
    if (body?.error === 'forbidden') return t('saved.forbidden');
    if (typeof body?.message === 'string') return body.message;
    return t('saved.failed');
  };

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      setMessage({ kind: 'status', text });
      setPanel('none');
      void reload();
    } catch (error) {
      setMessage({ kind: 'alert', text: failure(error) });
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    const found = list.find((s) => String(s.id) === chosen);
    if (!found) return;
    setMessage(null);
    setPanel('none');
    onOpen(found);
  };
  const toggle = (next: Panel) => {
    setMessage(null);
    if (next === 'share' && opened) {
      const current = visibilityOf(opened.shares);
      setVisibility(current === 'custom' ? 'private' : current);
    }
    if (next === 'saveAs') setName(opened ? t('saved.copyName', { name: opened.name }) : '');
    setPanel(panel === next ? 'none' : next);
  };

  const saveAs = () =>
    act(async () => {
      const saved = await client.create({ name: name.trim(), query, columns });
      onSaved(saved);
      return t('saved.created', { name: saved.name });
    });
  const save = () =>
    act(async () => {
      if (!opened) return '';
      const saved = await client.update(opened.id, { query, columns });
      onSaved(saved);
      return t('saved.updated', { name: saved.name });
    });
  const share = () =>
    act(async () => {
      if (!opened) return '';
      const shares: SavedSearchShare[] = visibility === 'private' ? [] : [{ scope: visibility }];
      const saved = await client.update(opened.id, { shares });
      onSaved(saved);
      return t(`saved.shared.${visibility}`, { name: saved.name });
    });
  const star = () =>
    act(async () => {
      if (!opened) return '';
      await client.star(opened.id, !opened.starred);
      onSaved({ ...opened, starred: !opened.starred });
      return t(opened.starred ? 'saved.unstarred' : 'saved.starred', { name: opened.name });
    });
  const subscribe = () =>
    act(async () => {
      if (!opened) return '';
      const sub = await client.subscribe(opened.id, {
        schedule,
        hour,
        ...(schedule === 'weekly' ? { weekday } : {}),
        ...(schedule === 'monthly' ? { dayOfMonth: day } : {}),
        onlyIfResults,
      });
      return t('saved.subscribed', {
        name: opened.name,
        when: new Date(sub.nextRunAt).toLocaleString(),
      });
    });

  const titleId = `${id}-title`;
  return (
    <section className="saved-searches" aria-labelledby={titleId}>
      <h2 id={titleId} className="saved-title">
        {opened ? t('saved.opened', { name: opened.name }) : t('saved.title')}
      </h2>
      <div className="saved-open">
        <label htmlFor={`${id}-list`} className="form-label">
          {t('saved.list')}
        </label>
        <select id={`${id}-list`} value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">{t('saved.choose')}</option>
          {list.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.editable ? s.name : t('saved.ofOwner', { name: s.name, owner: s.owner.name })}
            </option>
          ))}
        </select>
        <button type="button" className="button-secondary" disabled={!chosen} onClick={open}>
          {t('saved.open')}
        </button>
      </div>
      <div className="saved-actions" data-tutorial="search-save">
        {opened?.editable && (
          <button type="button" className="button-secondary" disabled={busy} onClick={save}>
            {t('saved.save')}
          </button>
        )}
        <button
          type="button"
          className="button-secondary"
          aria-expanded={panel === 'saveAs'}
          onClick={() => toggle('saveAs')}
        >
          {t('saved.saveAs')}
        </button>
        {opened?.editable && (
          <button
            type="button"
            className="button-secondary"
            aria-expanded={panel === 'share'}
            onClick={() => toggle('share')}
          >
            {t('saved.share')}
          </button>
        )}
        {opened && (
          <button
            type="button"
            className="button-secondary"
            aria-expanded={panel === 'subscribe'}
            onClick={() => toggle('subscribe')}
          >
            {t('saved.subscribe')}
          </button>
        )}
        {opened && (
          <button
            type="button"
            className="button-secondary"
            aria-pressed={opened.starred}
            disabled={busy}
            onClick={star}
          >
            {t('saved.star')}
          </button>
        )}
      </div>
      {opened?.importProblem && (
        <p role="note" className="page-note">
          {t('saved.importProblem', { problem: opened.importProblem })}
        </p>
      )}
      {panel === 'saveAs' && (
        <form
          className="saved-panel"
          aria-label={t('saved.saveAs')}
          onSubmit={(event) => {
            event.preventDefault();
            void saveAs();
          }}
        >
          <div className="form-field">
            <label htmlFor={`${id}-name`} className="form-label">
              {t('saved.name')}
            </label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={255}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy || !name.trim()}>
              {t('saved.saveNew')}
            </button>
          </div>
        </form>
      )}
      {panel === 'share' && opened && (
        <form
          className="saved-panel"
          aria-label={t('saved.share')}
          onSubmit={(event) => {
            event.preventDefault();
            void share();
          }}
        >
          <fieldset className="saved-choices">
            <legend>{t('saved.visibility')}</legend>
            {(['private', 'any_user', 'public'] as const).map((v) => (
              <div key={v} className="form-field form-field-inline">
                <input
                  id={`${id}-vis-${v}`}
                  type="radio"
                  name={`${id}-visibility`}
                  checked={visibility === v}
                  onChange={() => setVisibility(v)}
                />
                <label htmlFor={`${id}-vis-${v}`}>{t(`saved.visibility.${v}`)}</label>
              </div>
            ))}
          </fieldset>
          {visibilityOf(opened.shares) === 'custom' && (
            <p className="page-note">{t('saved.customShares')}</p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('saved.shareSave')}
            </button>
          </div>
        </form>
      )}
      {panel === 'subscribe' && opened && (
        <form
          className="saved-panel"
          aria-label={t('saved.subscribe')}
          onSubmit={(event) => {
            event.preventDefault();
            void subscribe();
          }}
        >
          <div className="form-field">
            <label htmlFor={`${id}-schedule`} className="form-label">
              {t('saved.schedule')}
            </label>
            <select
              id={`${id}-schedule`}
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as typeof schedule)}
            >
              {(['daily', 'weekly', 'monthly'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`saved.schedule.${s}`)}
                </option>
              ))}
            </select>
          </div>
          {schedule === 'weekly' && (
            <div className="form-field">
              <label htmlFor={`${id}-weekday`} className="form-label">
                {t('saved.weekday')}
              </label>
              <select
                id={`${id}-weekday`}
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {WEEKDAYS.map((w) => (
                  <option key={w} value={w}>
                    {t(`saved.weekday.${w}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {schedule === 'monthly' && (
            <div className="form-field">
              <label htmlFor={`${id}-day`} className="form-label">
                {t('saved.day')}
              </label>
              <select id={`${id}-day`} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-field">
            <label htmlFor={`${id}-hour`} className="form-label">
              {t('saved.hour')}
            </label>
            <select
              id={`${id}-hour`}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {t('saved.hourValue', { hour: String(h).padStart(2, '0') })}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-only`}
              type="checkbox"
              checked={onlyIfResults}
              onChange={(e) => setOnlyIfResults(e.target.checked)}
            />
            <label htmlFor={`${id}-only`}>{t('saved.onlyIfResults')}</label>
          </div>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('saved.subscribeSave')}
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role={message.kind} className={message.kind === 'alert' ? 'form-error' : 'page-note'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
