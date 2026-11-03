import { useEffect, useRef, useState } from 'react';
import { boardClient } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { type TrackClient, type TrackListItem, trackClient } from './client';
import { trackHref } from './TrackLayout';

const RECENT = 'taskmoor.recentTracks';
/** The list stays short: the current track, then the latest opened, then the rest by name. */
const SHOWN = 8;

function recent(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RECENT) ?? '[]');
    return Array.isArray(saved) ? saved.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  try {
    window.localStorage.setItem(
      RECENT,
      JSON.stringify([key, ...recent().filter((k) => k !== key)].slice(0, SHOWN)),
    );
  } catch {
    // Not kept in this browser: the list then falls back to names.
  }
}

/** Which track a route is inside of, when the route itself says. */
export function trackKeyOfRoute(hash: string): string | null {
  const inTrack = /^#\/tracks\/([A-Za-z][A-Za-z0-9_]{0,29})(?:[/?]|$)/.exec(hash)?.[1];
  if (inTrack) return inTrack;
  // A ticket's key starts with its track's.
  const ticket = /^#\/tickets\/([A-Za-z][A-Za-z0-9_]{0,29})-\d+(?:[/?]|$)/.exec(hash)?.[1];
  return ticket ?? null;
}

interface TrackNavListProps {
  hash: string;
  onNavigate?: () => void;
  client?: TrackClient;
  /** A board's track, for a route that names only the board. */
  boardTrack?: (boardId: number) => Promise<string | null>;
}

const boardTrackKey = async (boardId: number) => {
  const board = await boardClient.board(boardId);
  return board.location.type === 'track' ? board.location.track.key : null;
};

/**
 * The tracks under "Tracks" in the sidebar (ADR-116), there while the person is inside a track or
 * the directory. A site with many tracks shows the current one and the latest opened, with a link
 * to all of them; the list scrolls by itself and never pushes the sidebar away.
 */
export function TrackNavList({
  hash,
  onNavigate,
  client = trackClient,
  boardTrack = boardTrackKey,
}: TrackNavListProps) {
  const t = useT();
  const [tracks, setTracks] = useState<TrackListItem[] | null>(null);
  const [ofBoard, setOfBoard] = useState<string | null>(null);

  useEffect(() => {
    client.list().then(setTracks, () => setTracks([]));
  }, [client]);

  const boardId = /^#\/boards\/(\d{1,10})(?:[/?]|$)/.exec(hash)?.[1];
  useEffect(() => {
    if (!boardId) {
      setOfBoard(null);
      return;
    }
    let live = true;
    boardTrack(Number(boardId)).then(
      (key) => {
        if (live) setOfBoard(key);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [boardId, boardTrack]);

  const routed = trackKeyOfRoute(hash) ?? ofBoard;
  // A track made a moment ago: read the list again once, so it shows here at once.
  const askedAbout = useRef<string | null>(null);
  useEffect(() => {
    if (!tracks || !routed || askedAbout.current === routed) return;
    if (tracks.some((track) => track.key.toLowerCase() === routed.toLowerCase())) return;
    askedAbout.current = routed;
    client.list().then(setTracks, () => {});
  }, [tracks, routed, client]);
  const current =
    tracks?.find((track) => track.key.toLowerCase() === routed?.toLowerCase())?.key ?? null;
  useEffect(() => {
    if (current) remember(current);
  }, [current]);

  if (!tracks || tracks.length === 0) return null;
  const order = [current, ...recent()].filter((k): k is string => Boolean(k));
  const rank = (key: string) => {
    const at = order.indexOf(key);
    return at === -1 ? order.length : at;
  };
  const sorted = [...tracks].sort(
    (a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name),
  );
  const shown = sorted.slice(0, SHOWN);
  return (
    <>
      <ul className="nav-sublist">
        {shown.map((track) => (
          <li key={track.key}>
            <a
              className="nav-sublink"
              href={routeHref(trackHref(track.key))}
              aria-current={track.key === current ? 'page' : undefined}
              onClick={onNavigate}
            >
              {track.name}
            </a>
          </li>
        ))}
      </ul>
      {tracks.length > SHOWN && (
        <a
          className="nav-sublink nav-sublink-all"
          href={routeHref('#/tracks')}
          onClick={onNavigate}
        >
          {t('tracks.all', { count: tracks.length })}
        </a>
      )}
    </>
  );
}
