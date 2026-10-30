import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { type BoardClient, type BoardSummary, boardClient } from './client';

export interface BoardsPageProps {
  client?: BoardClient;
  /** Where a new board opens; the page sets the hash by default. */
  onCreated?: (board: BoardSummary) => void;
}

const openBoard = (board: BoardSummary) => {
  navigate(`#/boards/${board.id}`);
};

/**
 * The boards a person sees (M1-043), each a link to its page, and a form that makes a board
 * from a query (kept by its maker until saved searches bring sharing, M1-063). Columns, lanes,
 * board filters and card rules start from the defaults and change through the API for now.
 */
export function BoardsPage({ client = boardClient, onCreated = openBoard }: BoardsPageProps) {
  const t = useT();
  const id = useId();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'kanban' | 'scrum'>('kanban');
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.list().then(setBoards, () => setFailed(true));
  }, [client]);

  return (
    <section className="boards-page" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="page-title">
        {t('boards.list.title')}
      </h1>
      {failed && (
        <p className="page-note" role="alert">
          {t('boards.list.failed')}
        </p>
      )}
      {boards && boards.length === 0 && <p className="page-note">{t('boards.list.empty')}</p>}
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
        className="boards-create"
        aria-labelledby={`${id}-create`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !query.trim()) return;
          setBusy(true);
          setProblem(null);
          client.create({ name: name.trim(), kind, query: query.trim() }).then(
            (made) => {
              setBusy(false);
              onCreated(made);
            },
            () => {
              setBusy(false);
              setProblem(t('boards.create.failed'));
            },
          );
        }}
      >
        <h2 id={`${id}-create`}>{t('boards.create.title')}</h2>
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
        <div className="form-field">
          <label htmlFor={`${id}-query`} className="form-label">
            {t('boards.create.query')}
          </label>
          <input
            id={`${id}-query`}
            type="text"
            required
            aria-describedby={`${id}-query-hint`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <p id={`${id}-query-hint`} className="form-hint">
            {t('boards.create.queryHint')}
          </p>
        </div>
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
