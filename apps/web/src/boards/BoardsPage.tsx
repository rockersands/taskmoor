import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { valueWord } from '../search/basic';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type BoardClient, type BoardSummary, type BoardTrack, boardClient } from './client';

export interface BoardsPageProps {
  client?: BoardClient;
  /** Where a new board opens; the page sets the hash by default. */
  onCreated?: (board: BoardSummary) => void;
}

const openBoard = (board: BoardSummary) => {
  navigate(`#/boards/${board.id}`);
};

/** The query that shows one track's tickets. */
const trackQuery = (key: string) => `track = ${valueWord(key)}`;

/**
 * The boards a person sees (M1-043), each a link to its page, and a form that makes a board. The
 * form asks which track the board is for; the query behind that choice stays out of the way
 * until a person asks for it under "advanced" (ADR-114). A board is kept by its maker until
 * saved searches bring sharing (M1-063).
 */
export function BoardsPage({ client = boardClient, onCreated = openBoard }: BoardsPageProps) {
  const t = useT();
  const id = useId();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tracks, setTracks] = useState<BoardTrack[] | null>(null);
  const [tracksFailed, setTracksFailed] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'kanban' | 'scrum'>('kanban');
  const [trackKey, setTrackKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trackField = useRef<HTMLSelectElement>(null);
  const queryField = useRef<HTMLInputElement>(null);
  const switched = useRef(false);

  useEffect(() => {
    client.list().then(setBoards, () => setFailed(true));
    client.tracks().then(setTracks, () => setTracksFailed(true));
  }, [client]);

  // The field that replaced the one a person was on takes their place.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    (advanced ? queryField.current : trackField.current)?.focus();
  }, [advanced]);

  const showQuery = advanced || tracksFailed;
  const source = showQuery ? query.trim() : trackKey && trackQuery(trackKey);
  const example = trackQuery(tracks?.[0]?.key ?? 'ABC');

  const switchTo = (toAdvanced: boolean) => {
    switched.current = true;
    if (toAdvanced && !query.trim() && trackKey) setQuery(trackQuery(trackKey));
    setAdvanced(toAdvanced);
  };

  return (
    <section className="boards-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('boards.list.title')}
        purpose={t('purpose.boards')}
      />
      {failed && (
        <p className="page-note" role="alert">
          {t('boards.list.failed')}
        </p>
      )}
      {boards && boards.length === 0 && (
        <EmptyState title={t('boards.list.emptyTitle')}>{t('boards.list.empty')}</EmptyState>
      )}
      {boards && boards.length > 0 && (
        <ul className="boards-list">
          {boards.map((board) => (
            <li key={board.id} className="boards-item">
              <a href={routeHref(`#/boards/${board.id}`)}>{board.name}</a>
              <span className="boards-item-meta">
                {t('boards.meta', {
                  kind: t(board.kind === 'scrum' ? 'boards.kind.scrum' : 'boards.kind.kanban'),
                  location:
                    board.location.type === 'track'
                      ? t('boards.location.track', { track: board.location.track.name ?? '' })
                      : t('boards.location.user', { name: board.location.user.name ?? '' }),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="boards-create glass-card"
        aria-labelledby={`${id}-create`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !source) return;
          setBusy(true);
          setProblem(null);
          client.create({ name: name.trim(), kind, query: source }).then(
            (made) => {
              setBusy(false);
              onCreated(made);
            },
            () => {
              setBusy(false);
              setProblem(t(showQuery ? 'boards.create.failed' : 'boards.create.failedTrack'));
            },
          );
        }}
      >
        <h2 id={`${id}-create`} className="boards-create-title">
          {t('boards.create.title')}
        </h2>
        <div className="form-field">
          <label htmlFor={`${id}-name`} className="form-label">
            {t('boards.create.name')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-kind`} className="form-label">
            {t('boards.create.kind')}
          </label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value === 'scrum' ? 'scrum' : 'kanban')}
          >
            <option value="kanban">{t('boards.kind.kanban')}</option>
            <option value="scrum">{t('boards.kind.scrum')}</option>
          </select>
        </div>
        {showQuery ? (
          <div className="form-field">
            <label htmlFor={`${id}-query`} className="form-label">
              {t('boards.create.query')}
            </label>
            <input
              id={`${id}-query`}
              ref={queryField}
              type="text"
              required
              aria-describedby={`${id}-query-hint`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <p id={`${id}-query-hint`} className="form-hint">
              {t('boards.create.queryHint', { example })}
            </p>
            {tracksFailed && (
              <p className="form-hint" role="status">
                {t('boards.create.tracksFailed')}
              </p>
            )}
          </div>
        ) : (
          <div className="form-field">
            <label htmlFor={`${id}-track`} className="form-label">
              {t('boards.create.track')}
            </label>
            <select
              id={`${id}-track`}
              ref={trackField}
              required
              aria-describedby={`${id}-track-hint`}
              disabled={tracks === null}
              value={trackKey}
              onChange={(event) => setTrackKey(event.target.value)}
            >
              <option value="">{t('boards.create.trackChoose')}</option>
              {tracks?.map((track) => (
                <option key={track.key} value={track.key}>
                  {t('boards.create.trackOption', { name: track.name, key: track.key })}
                </option>
              ))}
            </select>
            <p id={`${id}-track-hint`} className="form-hint">
              {t(tracks?.length === 0 ? 'boards.create.noTracks' : 'boards.create.trackHint')}
            </p>
          </div>
        )}
        {!tracksFailed && (
          <button
            type="button"
            className="boards-create-switch"
            onClick={() => switchTo(!advanced)}
          >
            {t(advanced ? 'boards.create.useTrack' : 'boards.create.useQuery')}
          </button>
        )}
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('boards.create.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}
