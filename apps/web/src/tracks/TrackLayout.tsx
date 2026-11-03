import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useMotionOnChange } from '../shell/motion';
import { type TrackClient, trackClient } from './client';
import { TrackSectionsContext, useLoadedTrackSections } from './trackSections';

/** A track's sections, in the order of their tab bar (ADR-116). */
export const TRACK_SECTIONS = [
  { id: 'summary', path: '', labelId: 'track.section.summary' },
  { id: 'board', path: '/board', labelId: 'track.section.board' },
  { id: 'backlog', path: '/backlog', labelId: 'track.section.backlog' },
  { id: 'list', path: '/list', labelId: 'track.section.list' },
  { id: 'calendar', path: '/calendar', labelId: 'track.section.calendar' },
  { id: 'timeline', path: '/timeline', labelId: 'track.section.timeline' },
  { id: 'releases', path: '/releases', labelId: 'track.section.releases' },
  { id: 'files', path: '/files', labelId: 'track.section.files' },
  { id: 'statistics', path: '/statistics', labelId: 'track.section.statistics' },
] as const satisfies readonly { id: string; path: string; labelId: MessageId }[];

export type TrackSection = (typeof TRACK_SECTIONS)[number]['id'];

export const trackHref = (key: string, section: TrackSection = 'summary') =>
  `#/tracks/${encodeURIComponent(key)}${TRACK_SECTIONS.find((s) => s.id === section)?.path ?? ''}`;

interface TrackLayoutProps {
  trackKey: string;
  section: TrackSection;
  children: ReactNode;
  client?: TrackClient;
}

/**
 * One place per track (the user's decision, ADR-116): every page of a track shares this tab bar.
 * On a phone the bar scrolls inside itself, so the page never scrolls sideways. A Backlog tab shows
 * only on a track that has a backlog: never on a Kanban one, not even greyed out.
 */
export function TrackLayout({
  trackKey,
  section,
  children,
  client = trackClient,
}: TrackLayoutProps) {
  const t = useT();
  const sections = useLoadedTrackSections(trackKey, client, section);
  const tabs = TRACK_SECTIONS.filter((s) => s.id !== 'backlog' || sections?.backlog === true);
  const body = useMotionOnChange<HTMLDivElement>('motion-rise', `${trackKey}/${section}`);
  return (
    <TrackSectionsContext.Provider value={sections}>
      <nav className="track-tabs" aria-label={t('track.sections', { key: trackKey })}>
        <ul>
          {tabs.map((s) => (
            <li key={s.id}>
              <a
                href={routeHref(trackHref(trackKey, s.id))}
                aria-current={s.id === section ? 'page' : undefined}
              >
                {t(s.labelId)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div ref={body}>{children}</div>
    </TrackSectionsContext.Provider>
  );
}
