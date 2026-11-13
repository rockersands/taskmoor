import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useEffect,
  useId,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { HelpTip } from '../shell/HelpTip';
import { BoardsIcon, PlusIcon, SearchIcon, TourIcon } from '../shell/icons';
import { PageHeader } from '../shell/PageHeader';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import { useTicketChangeCount } from '../tickets/view/ticketChanges';
import { recentTracks } from '../tracks/recentTracks';
import { NEW_TRACK_ROUTE } from '../tracks/TracksPage';
import { newTrackModes } from '../tracks/trackAccess';
import { type HomeClient, type HomeTicket, type HomeTrack, homeClient, homeTracks } from './client';

export interface HomePageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: HomeClient;
  tracks?: () => Promise<HomeTrack[]>;
  /** Shown under the header, before the tracks: the tutorial's first-run offer (ADR-115). */
  intro?: ReactNode;
}

type Loaded<T> = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; items: T[] };

const SECTIONS: {
  id: keyof HomeClient;
  title: MessageId;
  help: MessageId;
  empty: MessageId;
  emptyHint: MessageId;
}[] = [
  {
    id: 'assigned',
    title: 'home.assigned',
    help: 'home.assignedHelp',
    empty: 'home.assignedEmpty',
    emptyHint: 'home.assignedEmptyHint',
  },
  {
    id: 'recent',
    title: 'home.recent',
    help: 'home.recentHelp',
    empty: 'home.recentEmpty',
    emptyHint: 'home.recentEmptyHint',
  },
  {
    id: 'followed',
    title: 'home.followed',
    help: 'home.followedHelp',
    empty: 'home.followedEmpty',
    emptyHint: 'home.followedEmptyHint',
  },
];

const STARTS: {
  href: string;
  title: MessageId;
  hint: MessageId;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { href: '#/create', title: 'home.start.create', hint: 'home.start.createHint', icon: PlusIcon },
  { href: '#/tracks', title: 'home.start.board', hint: 'home.start.boardHint', icon: BoardsIcon },
  {
    href: '#/search',
    title: 'home.start.search',
    hint: 'home.start.searchHint',
    icon: SearchIcon,
  },
  {
    href: '#/settings/tutorials',
    title: 'home.start.learn',
    hint: 'home.start.learnHint',
    icon: TourIcon,
  },
];

/**
 * Home (M1-052; AGL-018, AGL-019; ADR-046, ADR-114): the tracks the person belongs to, ways to
 * start, the open tickets assigned to them, the ones they opened lately and the ones they follow.
 * Each list loads on its own, so one that fails leaves the others; an empty one says how it fills.
 */
export function HomePage({ client = homeClient, tracks = homeTracks, intro }: HomePageProps) {
  const t = useT();
  const titleId = useId();
  const startId = useId();
  const { session } = useSession();
  const name = session.status === 'signed-in' ? session.user.name : '';
  const [lists, setLists] = useState<Record<keyof HomeClient, Loaded<HomeTicket>>>({
    assigned: { status: 'loading' },
    recent: { status: 'loading' },
    followed: { status: 'loading' },
  });
  const [trackList, setTrackList] = useState<Loaded<HomeTrack>>({ status: 'loading' });
  const changes = useTicketChangeCount();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after an edit in the pop-up
  useEffect(() => {
    let live = true;
    for (const { id } of SECTIONS) {
      client[id]().then(
        (items) => live && setLists((l) => ({ ...l, [id]: { status: 'loaded', items } })),
        () => live && setLists((l) => ({ ...l, [id]: { status: 'failed' } })),
      );
    }
    tracks().then(
      (items) => live && setTrackList({ status: 'loaded', items }),
      () => live && setTrackList({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [client, tracks, changes]);

  return (
    <section aria-labelledby={titleId} className="page home-page">
      <PageHeader
        titleId={titleId}
        title={t('home.title')}
        eyebrow={name ? t('home.greeting', { name }) : undefined}
        purpose={t('purpose.home')}
        about={t('about.home')}
      />

      {intro}

      <HomeTracks list={trackList} />

      <section aria-labelledby={startId} className="home-start">
        <h2 id={startId} className="section-title">
          {t('home.start')}
        </h2>
        <ul className="home-start-list">
          {STARTS.map(({ href, title, hint, icon: Icon }) => (
            <li key={href}>
              <a className="start-tile glass-card" href={routeHref(href)}>
                <span className="start-tile-icon">
                  <Icon />
                </span>
                <span className="start-tile-title">{t(title)}</span>
                <span className="start-tile-hint">{t(hint)}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div className="home-lists">
        {SECTIONS.map((section) => (
          <HomeList
            key={section.id}
            title={t(section.title)}
            help={t(section.help)}
            empty={t(section.empty)}
            emptyHint={t(section.emptyHint)}
            list={lists[section.id]}
          />
        ))}
      </div>
    </section>
  );
}

function ListStatus({ list }: { list: Loaded<unknown> }) {
  const t = useT();
  if (list.status === 'loading') return <p className="page-note">{t('home.loading')}</p>;
  // Not an alert: a list that could not be read is no reason to interrupt.
  if (list.status === 'failed') return <p className="form-error">{t('home.failed')}</p>;
  return null;
}

function HomeList({
  title,
  help,
  empty,
  emptyHint,
  list,
}: {
  title: string;
  help: string;
  empty: string;
  emptyHint: string;
  list: Loaded<HomeTicket>;
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="home-list glass-card">
      <div className="panel-head">
        <h2 id={headingId} className="panel-title">
          {title}
        </h2>
        <HelpTip name={title}>{help}</HelpTip>
        {list.status === 'loaded' && list.items.length > 0 && (
          <span className="panel-count">{t('home.count', { count: list.items.length })}</span>
        )}
      </div>
      <ListStatus list={list} />
      {list.status === 'loaded' && list.items.length === 0 && (
        <EmptyState
          title={empty}
          action={
            <a className="button-quiet" href={routeHref('#/search')}>
              {t('home.findTicket')}
            </a>
          }
        >
          {emptyHint}
        </EmptyState>
      )}
      {list.status === 'loaded' && list.items.length > 0 && (
        <ul className="home-tickets">
          {list.items.map((ticket) => (
            <li key={ticket.id} className="home-ticket">
              <a
                href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)}
                className="home-ticket-link"
              >
                <span className="home-ticket-key">{ticket.key}</span>{' '}
                <span className="home-ticket-summary">{ticket.summary}</span>
              </a>
              <span className="ticket-icons">
                {ticket.ticketType && (
                  <TypeIcon name={ticket.ticketType.name} icon={ticket.ticketType.icon} />
                )}
                {ticket.priority && (
                  <PriorityIcon name={ticket.priority.name} level={ticket.priority.level} />
                )}
              </span>
              <span className="home-ticket-status" data-stage={ticket.status.stage}>
                {ticket.status.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How many tracks the Home page shows before leading to the directory. */
const TRACKS_SHOWN = 6;

function HomeTracks({ list }: { list: Loaded<HomeTrack> }) {
  const t = useT();
  const headingId = useId();
  const title = t('home.tracks');
  const { session } = useSession();
  const mayCreate = newTrackModes(session.status === 'signed-in' ? session.user : null).length > 0;
  const items = list.status === 'loaded' ? list.items : [];
  // The server answers only the tracks the person belongs to and may see (T-194): those opened
  // lately, asked for by key, and the first page. The latest opened in this browser first, then
  // by name.
  const recent = recentTracks();
  const rank = (key: string) => {
    const at = recent.indexOf(key);
    return at === -1 ? recent.length : at;
  };
  const shown = [...items]
    .sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name))
    .slice(0, TRACKS_SHOWN);
  return (
    <section aria-labelledby={headingId} className="home-tracks">
      <div className="panel-head">
        <h2 id={headingId} className="section-title">
          {title}
        </h2>
        <HelpTip name={title}>{t('home.tracksHelp')}</HelpTip>
        {items.length > TRACKS_SHOWN && (
          <a className="panel-count home-tracks-all" href={routeHref('#/tracks')}>
            {t('home.tracksAll')}
          </a>
        )}
      </div>
      <ListStatus list={list} />
      {list.status === 'loaded' && list.items.length === 0 && (
        <EmptyState
          title={t('home.tracksEmpty')}
          action={
            <>
              <a className="button-quiet" href={routeHref('#/tracks')}>
                {t('home.tracksBrowse')}
              </a>
              {mayCreate && (
                <a className="button-primary" href={routeHref(NEW_TRACK_ROUTE)}>
                  {t('tracks.new')}
                </a>
              )}
            </>
          }
        >
          {t('home.tracksEmptyHint')}
        </EmptyState>
      )}
      {list.status === 'loaded' && list.items.length > 0 && (
        <ul className="home-track-list">
          {shown.map((track) => (
            <li key={track.id}>
              <a
                className="track-tile glass-card"
                href={routeHref(`#/tracks/${encodeURIComponent(track.key)}`)}
              >
                {/* The whole key, never its first letters (PL-29); a long one in smaller type. */}
                <span
                  className="track-tile-badge"
                  data-long={track.key.length > 3 || undefined}
                  aria-hidden="true"
                >
                  {track.key}
                </span>
                <span className="track-tile-name">{track.name}</span>
                <span className="track-tile-key">{t('home.trackKey', { key: track.key })}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
