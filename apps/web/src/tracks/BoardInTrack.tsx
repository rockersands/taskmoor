import { type ReactNode, useEffect, useState } from 'react';
import { type Board, boardClient } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import { replaceRoute, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { BacklogPage } from '../sprints/BacklogPage';
import { TrackLayout, type TrackSection, trackHref } from './TrackLayout';
import { useTrackSections } from './trackSections';

/** A route that moved: goes on without leaving the old address in the history. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => replaceRoute(to), [to]);
  return null;
}

/**
 * A page addressed by its board (settings, reports, a sprint's report) keeps its track's tab bar.
 * A board an upgrade left outside a track has no sections to show.
 */
export function BoardInTrack({
  boardId,
  section,
  children,
}: {
  boardId: number;
  section: TrackSection;
  children: ReactNode;
}) {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    boardClient.board(boardId).then(
      (board) => {
        if (live && board.location.type === 'track') setKey(board.location.track.key);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [boardId]);
  return key ? (
    <TrackLayout trackKey={key} section={section}>
      {children}
    </TrackLayout>
  ) : (
    children
  );
}

/**
 * A report addressed by its board goes to its track's Statistics, so the track's tabs stay in
 * place (ADR-116). A board an upgrade left outside a track keeps the page at its own address.
 */
export function StatisticsOfBoard({
  boardId,
  path,
  children,
}: {
  boardId: number;
  /** The report's path under the Statistics section, with its slash. */
  path: string;
  children: ReactNode;
}) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    boardClient.board(boardId).then(
      (board) => {
        if (live) setKey(board.location.type === 'track' ? board.location.track.key : null);
      },
      () => {
        if (live) setKey(null);
      },
    );
    return () => {
      live = false;
    };
  }, [boardId]);
  if (key === undefined) return null;
  return key ? <Redirect to={`#/tracks/${encodeURIComponent(key)}/statistics${path}`} /> : children;
}

/** The address of a backlog on a track with none: says so plainly, and leads to the board. */
export function NoBacklog({ board }: { board: Board }) {
  const t = useT();
  return (
    <EmptyState
      title={t('track.backlog.noneTitle')}
      action={
        <>
          <a
            className="button-primary"
            href={routeHref(
              board.location.type === 'track' && board.location.track.key
                ? trackHref(board.location.track.key, 'board')
                : `#/boards/${board.id}`,
            )}
          >
            {t('track.backlog.openBoard')}
          </a>
          {board.mayConfigure && (
            <a className="button-quiet" href={routeHref(`#/boards/${board.id}/settings`)}>
              {t('track.backlog.kanbanAction')}
            </a>
          )}
        </>
      }
    >
      {t('track.backlog.none')}
    </EmptyState>
  );
}

/** The backlog of a track's one board, or what to do on a track that has none (ADR-116). */
export function BacklogOfTrack({ board }: { board: Board }) {
  const sections = useTrackSections();
  return board.kind === 'scrum' && sections?.backlog !== false ? (
    <BacklogPage key={board.id} boardId={board.id} />
  ) : (
    <NoBacklog board={board} />
  );
}

/** The same at a board's own address. The backlog page says so itself if the board cannot be read. */
export function BacklogOfBoard({ boardId }: { boardId: number }) {
  const [board, setBoard] = useState<Board | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    boardClient.board(boardId).then(
      (read) => {
        if (live) setBoard(read);
      },
      () => {
        if (live) setBoard(null);
      },
    );
    return () => {
      live = false;
    };
  }, [boardId]);
  if (board === undefined) return null;
  return board ? <BacklogOfTrack board={board} /> : <BacklogPage boardId={boardId} />;
}

export { trackHref };
