import { type ReactNode, useEffect, useState } from 'react';
import { boardClient } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import { replaceRoute, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { TrackLayout, type TrackSection, trackHref } from './TrackLayout';

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

/** A Kanban board has no backlog: says so, and where to change it. */
export function KanbanHasNoBacklog({ boardId }: { boardId: number }) {
  const t = useT();
  return (
    <EmptyState
      title={t('track.backlog.kanbanTitle')}
      action={
        <a className="button-quiet" href={routeHref(`#/boards/${boardId}/settings`)}>
          {t('track.backlog.kanbanAction')}
        </a>
      }
    >
      {t('track.backlog.kanban')}
    </EmptyState>
  );
}

export { trackHref };
