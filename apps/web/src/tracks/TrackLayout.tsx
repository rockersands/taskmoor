import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useMoreSides } from '../shell/moreSides';
import { useMotionOnChange } from '../shell/motion';
import { NotFoundPage } from '../shell/NotFoundPage';
import { type TrackClient, trackClient } from './client';
import { rememberTrack } from './recentTracks';
import { TrackSectionsContext, useLoadedTrackSections } from './trackSections';

/** A track's sections, in the order of their tab bar (ADR-116). */
export const TRACK_SECTIONS = [
  { id: 'summary', path: '', labelId: 'track.section.summary' },
  { id: 'board', path: '/board', labelId: 'track.section.board' },
  { id: 'backlog', path: '/backlog', labelId: 'track.section.backlog' },
  { id: 'list', path: '/list', labelId: 'track.section.list' },
  { id: 'calendar', path: '/calendar', labelId: 'track.section.calendar' },
  { id: 'timeline', path: '/timeline', labelId: 'track.section.timeline' },
  { id: 'outcomes', path: '/outcomes', labelId: 'track.section.outcomes' },
  { id: 'releases', path: '/releases', labelId: 'track.section.releases' },
  { id: 'files', path: '/files', labelId: 'track.section.files' },
  { id: 'statistics', path: '/statistics', labelId: 'track.section.statistics' },
] as const satisfies readonly { id: string; path: string; labelId: MessageId }[];

export type TrackSection = (typeof TRACK_SECTIONS)[number]['id'];

export const trackHref = (key: string, section: TrackSection = 'summary') =>
  `#/tracks/${encodeURIComponent(key)}${TRACK_SECTIONS.find((s) => s.id === section)?.path ?? ''}`;

interface TrackLayoutProps {
  trackKey: string;
  /** The tab to mark; null on a page of the track that belongs to no tab. */
  section: TrackSection | null;
  /**
   * The page is not the section itself but lies within it, as the track's Ticket templates lie
   * within its Summary, which leads there (TR-27): the tab is marked as where the person is
   * (`aria-current="true"`), not as this page.
   */
  within?: boolean;
  children: ReactNode;
  client?: TrackClient;
  /**
   * The page has been read already and stands without its track: a board its administrator may
   * see though not the track (D4). When the track is not there for the reader, the page shows
   * without the tab bar instead of "Track not found".
   */
  pageStands?: boolean;
}

/**
 * One place per track (the user's decision, ADR-116): every page of a track shares this tab bar.
 * On a phone the bar scrolls inside itself, so the page never scrolls sideways: the current tab is
 * brought into view and a fade at either end says more tabs are there (the page-review fault
 * TR-4). A Backlog tab shows only on a track that has a backlog: never on a Kanban one, not even
 * greyed out. A track that does not exist, or that the reader may not see, has no tabs: the page
 * says so and leads on (D4, AC-8); a page that stands without it, such as a board its
 * administrator may see, shows without the tabs.
 */
export function TrackLayout({
  trackKey,
  section,
  children,
  client = trackClient,
  pageStands = false,
  within = false,
}: TrackLayoutProps) {
  const t = useT();
  const loaded = useLoadedTrackSections(trackKey, client, section ?? 'other');
  const missing = loaded === 'missing';
  const sections = missing ? null : loaded;
  useEffect(() => {
    if (!missing) rememberTrack(trackKey);
  }, [trackKey, missing]);
  const tabs = TRACK_SECTIONS.filter((s) => s.id !== 'backlog' || sections?.backlog === true);
  const body = useMotionOnChange<HTMLDivElement>('motion-rise', `${trackKey}/${section}`);
  const bar = useRef<HTMLElement>(null);
  const hasBacklog = sections?.backlog === true;
  const more = useMoreSides(bar, `${section}/${hasBacklog}/${missing}`);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tabs move when Backlog comes or goes
  useLayoutEffect(() => {
    const scroller = bar.current;
    const current = scroller?.querySelector<HTMLElement>('[aria-current]');
    if (!scroller || !current) return;
    // Only the bar scrolls, never the page: the current tab to its middle, a neighbour each side.
    const tab = current.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const by = tab.left + tab.width / 2 - (view.left + view.width / 2);
    if (Math.abs(by) > 1) scroller.scrollLeft += by;
  }, [section, hasBacklog, missing]);

  if (missing && !pageStands) {
    return (
      <NotFoundPage title={t('notFound.track')}>
        {t('track.notFound', { key: trackKey })}
      </NotFoundPage>
    );
  }
  return (
    <TrackSectionsContext.Provider value={sections}>
      {/* A page that stands without its track keeps its place in the tree, so it does not start again. */}
      {!missing && (
        <nav
          ref={bar}
          className="track-tabs"
          data-more={more}
          aria-label={t('track.sections', { key: trackKey })}
        >
          <ul>
            {tabs.map((s) => (
              <li key={s.id}>
                <a
                  href={routeHref(trackHref(trackKey, s.id))}
                  data-tutorial={`track-tab-${s.id}`}
                  aria-current={s.id === section ? (within ? 'true' : 'page') : undefined}
                >
                  {t(s.labelId)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div ref={body}>{children}</div>
    </TrackSectionsContext.Provider>
  );
}
