import { type ComponentType, type SVGProps, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { HelpTip } from '../shell/HelpTip';
import {
  BoardsIcon,
  InboxIcon,
  PlusIcon,
  SearchIcon,
  TicketIcon,
  TourIcon,
  TracksIcon,
} from '../shell/icons';
import { PageHeader } from '../shell/PageHeader';
import { type HomeClient, type HomeTicket, type HomeTrack, homeClient, homeTracks } from './client';

export interface HomePageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: HomeClient;
  tracks?: () => Promise<HomeTrack[]>;
}

type Loaded<T> = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; items: T[] };

const SECTIONS: {
  id: keyof HomeClient;
  title: MessageId;
  help: MessageId;
  empty: MessageId;
  emptyHint: MessageId;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  {
    id: 'assigned',
    title: 'home.assigned',
    help: 'home.assignedHelp',
    empty: 'home.assignedEmpty',
    emptyHint: 'home.assignedEmptyHint',
    icon: TicketIcon,
  },
  {
    id: 'recent',
    title: 'home.recent',
    help: 'home.recentHelp',
    empty: 'home.recentEmpty',
    emptyHint: 'home.recentEmptyHint',
    icon: SearchIcon,
  },
  {
    id: 'followed',
    title: 'home.followed',
    help: 'home.followedHelp',
    empty: 'home.followedEmpty',
    emptyHint: 'home.followedEmptyHint',
    icon: InboxIcon,
  },
];

const STARTS: {
  href: string;
  title: MessageId;
  hint: MessageId;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { href: '#/create', title: 'home.start.create', hint: 'home.start.createHint', icon: PlusIcon },
  { href: '#/boards', title: 'home.start.board', hint: 'home.start.boardHint', icon: BoardsIcon },
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
 * Home (M1-052; AGL-018, AGL-019; ADR-114): ways to start, the open tickets assigned to the
 * person, the ones they opened lately, the ones they follow and the tracks they can see. Each
 * list loads on its own, so one that fails leaves the others; an empty one says how it fills.
 */
export function HomePage({ client = homeClient, tracks = homeTracks }: HomePageProps) {
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
  }, [client, tracks]);

  return (
    <section aria-labelledby={titleId} className="home-page">
      <PageHeader
        titleId={titleId}
        title={t('home.title')}
        eyebrow={name ? t('home.greeting', { name }) : undefined}
        purpose={t('purpose.home')}
        about={t('about.home')}
      />

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
            icon={section.icon}
            list={lists[section.id]}
          />
        ))}
      </div>

      <HomeTracks list={trackList} />
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
  icon,
  list,
}: {
  title: string;
  help: string;
  empty: string;
  emptyHint: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
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
          <span className="panel-count">{list.items.length}</span>
        )}
      </div>
      <ListStatus list={list} />
      {list.status === 'loaded' && list.items.length === 0 && (
        <EmptyState
          icon={icon}
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

function HomeTracks({ list }: { list: Loaded<HomeTrack> }) {
  const t = useT();
  const headingId = useId();
  const title = t('home.tracks');
  return (
    <section aria-labelledby={headingId} className="home-tracks">
      <div className="panel-head">
        <h2 id={headingId} className="section-title">
          {title}
        </h2>
        <HelpTip name={title}>{t('home.tracksHelp')}</HelpTip>
      </div>
      <ListStatus list={list} />
      {list.status === 'loaded' && list.items.length === 0 && (
        <EmptyState icon={TracksIcon} title={t('home.tracksEmpty')} />
      )}
      {list.status === 'loaded' && list.items.length > 0 && (
        <ul className="home-track-list">
          {list.items.map((track) => (
            <li key={track.id}>
              <a
                className="track-tile glass-card"
                href={routeHref(`#/tracks/${encodeURIComponent(track.key)}`)}
              >
                <span className="track-tile-badge" aria-hidden="true">
                  {track.key.slice(0, 3)}
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
