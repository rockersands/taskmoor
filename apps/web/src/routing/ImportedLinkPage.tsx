import { type ImportedLinkKind, importedLinkOf, importedLinkRoute } from '@taskmoor/webconfig';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { redirectRoute, routeHref } from './router';

/** Finds what a link of the earlier tracker became: the app's route, or null for nothing. */
export type ImportedLinkLookup = (
  kind: ImportedLinkKind,
  sourceId: string,
) => Promise<string | null>;

export const apiLookup: ImportedLinkLookup = async (kind, sourceId) => {
  try {
    const found = await api<{ route: string }>(`/imported-links/${kind}/${sourceId}`);
    return found.route;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};

/** The route a link of the earlier tracker stands for, when the route is one (M1-128). */
export function sourceLinkRoute(route: string): string | null {
  const path = route.replace(/^#\/?/, '');
  const at = path.indexOf('?');
  return importedLinkRoute(at < 0 ? path : path.slice(0, at), at < 0 ? '' : path.slice(at));
}

export interface ImportedLinkPageProps {
  /** `#/imported/<kind>/<source id>`, or a link of the earlier tracker as a route. */
  route: string;
  lookup?: ImportedLinkLookup;
  /** Goes to the found page in place of this one (the default leaves no history entry). */
  onFound?: (route: string) => void;
}

/**
 * A link from the tracker an import came from (M1-128; IMP-011; ADR-097): a filter, board or
 * dashboard named by the earlier tracker's id. It asks the backend what the import made of it and
 * goes there; when nothing matches (or the person may not see it), it says so.
 */
export function ImportedLinkPage({
  route,
  lookup = apiLookup,
  onFound = redirectRoute,
}: ImportedLinkPageProps) {
  const t = useT();
  const [state, setState] = useState<'looking' | 'missing' | 'failed'>('looking');
  useEffect(() => {
    let live = true;
    const direct = importedLinkOf(route) ? route : sourceLinkRoute(route);
    const link = direct ? importedLinkOf(direct) : null;
    if (!link) {
      if (direct) onFound(direct);
      else setState('missing');
      return;
    }
    setState('looking');
    lookup(link.kind, link.id).then(
      (found) => {
        if (!live) return;
        if (found) onFound(found);
        else setState('missing');
      },
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [route, lookup, onFound]);

  return (
    <section className="page" aria-labelledby="imported-link-title">
      <h1 id="imported-link-title">{t('importedLink.title')}</h1>
      {state === 'looking' && <p role="status">{t('importedLink.looking')}</p>}
      {state === 'missing' && (
        <>
          <p role="alert">{t('importedLink.missing')}</p>
          <p>
            <a href={routeHref('#/search')}>{t('importedLink.toSearch')}</a>
          </p>
        </>
      )}
      {state === 'failed' && <p role="alert">{t('importedLink.failed')}</p>}
    </section>
  );
}
