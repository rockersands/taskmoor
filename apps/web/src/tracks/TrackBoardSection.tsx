import { type ReactNode, useEffect, useState } from 'react';
import type { Board } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import { type TrackClient, trackClient } from './client';

interface TrackBoardSectionProps {
  trackKey: string;
  client?: TrackClient;
  /** What the section shows once the track's one board is known. */
  children: (board: Board) => ReactNode;
}

/**
 * Finds the track's one board (ADR-116), made the first time anyone opens it, for the sections that
 * read it: the board itself, the backlog and the statistics.
 */
export function TrackBoardSection({
  trackKey,
  client = trackClient,
  children,
}: TrackBoardSectionProps) {
  const t = useT();
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setBoard(null);
    setFailed(false);
    client.board(trackKey).then(
      (found) => {
        if (live) setBoard(found);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  if (failed) {
    return (
      <p className="form-error" role="alert">
        {t('track.boardFailed')}
      </p>
    );
  }
  if (!board) return <p className="page-note">{t('boards.loading')}</p>;
  return <>{children(board)}</>;
}
