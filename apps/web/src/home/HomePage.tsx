import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { type HomeClient, type HomeTicket, homeClient } from './client';

export interface HomePageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: HomeClient;
}

type List =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; tickets: HomeTicket[] };

const SECTIONS: { id: keyof HomeClient; title: MessageId; empty: MessageId }[] = [
  { id: 'assigned', title: 'home.assigned', empty: 'home.assignedEmpty' },
  { id: 'recent', title: 'home.recent', empty: 'home.recentEmpty' },
  { id: 'followed', title: 'home.followed', empty: 'home.followedEmpty' },
];

/**
 * Home (M1-052; AGL-018, AGL-019): the open tickets assigned to the person, the ones they
 * opened lately and the ones they follow. Each list loads on its own, so one that fails leaves
 * the others.
 */
export function HomePage({ client = homeClient }: HomePageProps) {
  const t = useT();
  const titleId = useId();
  const { session } = useSession();
  const name = session.status === 'signed-in' ? session.user.name : '';
  const [lists, setLists] = useState<Record<keyof HomeClient, List>>({
    assigned: { status: 'loading' },
    recent: { status: 'loading' },
    followed: { status: 'loading' },
  });

  useEffect(() => {
    let live = true;
    for (const { id } of SECTIONS) {
      client[id]().then(
        (tickets) => live && setLists((l) => ({ ...l, [id]: { status: 'loaded', tickets } })),
        () => live && setLists((l) => ({ ...l, [id]: { status: 'failed' } })),
      );
    }
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section aria-labelledby={titleId} className="home-page">
      <h1 id={titleId} className="page-title">
        {t('home.title')}
      </h1>
      {name && <p className="page-note">{t('home.greeting', { name })}</p>}
      <div className="home-lists">
        {SECTIONS.map((section) => (
          <HomeList
            key={section.id}
            title={t(section.title)}
            empty={t(section.empty)}
            list={lists[section.id]}
          />
        ))}
      </div>
    </section>
  );
}

function HomeList({ title, empty, list }: { title: string; empty: string; list: List }) {
  const t = useT();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="home-list">
      <h2 id={headingId} className="facts-title">
        {title}
      </h2>
      {list.status === 'loading' && <p className="page-note">{t('home.loading')}</p>}
      {/* Not an alert: a list that could not be read is no reason to interrupt. */}
      {list.status === 'failed' && <p className="form-error">{t('home.failed')}</p>}
      {list.status === 'loaded' && list.tickets.length === 0 && (
        <p className="page-note">{empty}</p>
      )}
      {list.status === 'loaded' && list.tickets.length > 0 && (
        <ul className="home-tickets">
          {list.tickets.map((ticket) => (
            <li key={ticket.id} className="home-ticket">
              <a href={`#/tickets/${encodeURIComponent(ticket.key)}`} className="home-ticket-link">
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
