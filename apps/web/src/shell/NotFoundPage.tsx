import { createContext, type ReactNode, useContext, useEffect, useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref, useRoute } from '../routing/router';
import { PageHeader } from './PageHeader';

/**
 * Tells the frame that the page at this address is a not-found page, so the navigation marks no
 * section (D4): a track, plan or ticket that does not exist is not inside any of them.
 */
export const NotFoundContext = createContext<((route: string) => void) | null>(null);

export interface NotFoundPageProps {
  /** What was not found, such as "Track not found"; the page's only level-one heading. */
  title: string;
  /** One sentence on what happened; a general one for an unknown address otherwise. */
  children?: ReactNode;
}

/**
 * Not found (D4): an address that matches no page, and a track, board, plan, ticket, release,
 * dashboard or bulk change that does not exist or that the person may not see. It says so in its
 * title and offers the two ways on that always work: Home and Search.
 */
export function NotFoundPage({ title, children }: NotFoundPageProps) {
  const t = useT();
  const titleId = useId();
  const route = useRoute();
  const notFound = useContext(NotFoundContext);
  useEffect(() => notFound?.(route), [notFound, route]);
  return (
    <section className="page not-found-page" aria-labelledby={titleId}>
      {/* What happened is the page's purpose line, said as an alert. */}
      <PageHeader
        titleId={titleId}
        title={title}
        purpose={<span role="alert">{children ?? t('notFound.page')}</span>}
      />
      <nav className="form-actions" aria-label={t('notFound.waysOn')}>
        <a className="button-primary" href={routeHref('#/home')}>
          {t('notFound.home')}
        </a>
        <a className="button-secondary" href={routeHref('#/search')}>
          {t('notFound.search')}
        </a>
      </nav>
    </section>
  );
}
