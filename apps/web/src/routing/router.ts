import type { RoutingMode, RuntimeConfig } from '@taskmoor/webconfig';
import { useSyncExternalStore } from 'react';
import { runtimeConfig } from '../runtime/config';

/**
 * Addresses inside the app (M1-105, ADR-066). Pages speak in routes written the way hash
 * routing writes them, `#/boards/7?x=1` ('' is the start page), whatever the deployment uses.
 * Hash routing keeps them in the fragment and works on any host. Clean URLs write them as paths
 * below the base path (`/boards/7?x=1`); the host sends deep links to index.html, and a hash
 * route such as an older link or an email's `/#/tickets/ABC-1` still opens and is rewritten to
 * its path.
 */
export interface Router {
  readonly mode: RoutingMode;
  /** The current route, `#/boards/7` in either mode. */
  current(): string;
  /** What a link to the route points at: the route itself, or its path. */
  href(route: string): string;
  /** The route as an absolute address, for copying. */
  url(route: string): string;
  /** Goes to the route as a new history entry. */
  navigate(route: string): void;
  /** Rewrites the address without a new entry or a change event, as history.replaceState does. */
  replace(route: string): void;
  /** Goes to the route in place of the current entry, with a change event (M1-128). */
  redirect(route: string): void;
  /** Calls the listener after every route change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Clean URLs: rewrites a hash route in the address and takes over links. Returns the stop. */
  start(): () => void;
}

const CHANGE = 'taskmoor:route';

/** A route carrying a one-time token (setup, password and unsubscribe links) stays in the
 * fragment, which browsers never send to a server, so a reload does not log the token. */
const TOKEN = /[?&]token=/;

/** The route's path and query, without its `#/`: `#/boards/7?x=1` -> `boards/7?x=1`. */
function routePath(route: string): string {
  return route.replace(/^#?\/?/, '');
}

export function createRouter(
  win: Window,
  config: Pick<RuntimeConfig, 'routing' | 'basePath'>,
): Router {
  const base = config.basePath;
  const notify = () => win.dispatchEvent(new Event(CHANGE));

  /** The route an address inside the app stands for; null outside it and for the API. */
  const routeOfUrl = (url: URL): string | null => {
    if (url.hash.startsWith('#/')) return url.hash;
    const path = url.pathname;
    if (path.startsWith('/api/') || path.startsWith(`${base}api/`)) return null;
    if (path === base || path === base.slice(0, -1)) return '';
    if (!path.startsWith(base)) return null;
    return `#/${path.slice(base.length)}${url.search}`;
  };

  if (config.routing === 'hash') {
    return {
      mode: 'hash',
      current: () => win.location.hash,
      href: (route) => route,
      url: (route) => `${win.location.origin}${win.location.pathname}${route}`,
      navigate: (route) => {
        win.location.hash = route;
      },
      replace: (route) => {
        const here = `${win.location.pathname}${win.location.search}`;
        win.history.replaceState(win.history.state, '', route ? `${here}${route}` : here);
      },
      redirect: (route) => {
        const here = `${win.location.pathname}${win.location.search}`;
        win.history.replaceState(win.history.state, '', route ? `${here}${route}` : here);
        notify();
      },
      subscribe: (listener) => {
        win.addEventListener('hashchange', listener);
        win.addEventListener(CHANGE, listener);
        return () => {
          win.removeEventListener('hashchange', listener);
          win.removeEventListener(CHANGE, listener);
        };
      },
      start: () => () => {},
    };
  }

  const href = (route: string) => `${base}${routePath(route)}`;
  const here = () => `${win.location.pathname}${win.location.search}${win.location.hash}`;
  const current = () => routeOfUrl(new URL(win.location.href)) ?? '';
  const navigate = (route: string) => {
    if (href(route) === here()) return;
    win.history.pushState(null, '', href(route));
    notify();
  };
  /** A hash route in the address becomes its path, unless it carries a token. */
  const tidy = () => {
    const hash = win.location.hash;
    if (!hash.startsWith('#/') || TOKEN.test(hash)) return;
    win.history.replaceState(win.history.state, '', href(hash));
  };
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // HTML and SVG links alike, so read attributes rather than HTMLAnchorElement properties.
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor) return;
    const target = anchor.getAttribute('target');
    if ((target && target !== '_self') || anchor.hasAttribute('download')) return;
    const raw = anchor.getAttribute('href') ?? '';
    // An in-page fragment such as the skip link: the base element would otherwise send it to
    // the base path, so move to the element here.
    if (raw.startsWith('#') && !raw.startsWith('#/')) {
      event.preventDefault();
      const element = win.document.getElementById(raw.slice(1));
      element?.scrollIntoView?.();
      if (element instanceof HTMLElement && element.hasAttribute('tabindex')) element.focus();
      return;
    }
    const url = new URL(raw, win.document.baseURI);
    const route = url.origin === win.location.origin ? routeOfUrl(url) : null;
    if (route === null) return;
    event.preventDefault();
    navigate(route);
  };

  return {
    mode: 'path',
    current,
    href,
    url: (route) => new URL(href(route), win.location.origin).href,
    navigate,
    replace: (route) => win.history.replaceState(win.history.state, '', href(route)),
    redirect: (route) => {
      win.history.replaceState(win.history.state, '', href(route));
      notify();
    },
    subscribe: (listener) => {
      win.addEventListener('popstate', listener);
      win.addEventListener('hashchange', listener);
      win.addEventListener(CHANGE, listener);
      return () => {
        win.removeEventListener('popstate', listener);
        win.removeEventListener('hashchange', listener);
        win.removeEventListener(CHANGE, listener);
      };
    },
    start: () => {
      tidy();
      win.addEventListener('hashchange', tidy);
      win.document.addEventListener('click', onClick);
      return () => {
        win.removeEventListener('hashchange', tidy);
        win.document.removeEventListener('click', onClick);
      };
    },
  };
}

/** The app's router, in the mode the runtime configuration names. */
export const router: Router = createRouter(window, runtimeConfig);

export const currentRoute = (): string => router.current();
export const routeHref = (route: string): string => router.href(route);
export const routeUrl = (route: string): string => router.url(route);
export const navigate = (route: string): void => router.navigate(route);
export const replaceRoute = (route: string): void => router.replace(route);
export const redirectRoute = (route: string): void => router.redirect(route);
export const onRouteChange = (listener: () => void): (() => void) => router.subscribe(listener);

/** The current route, re-rendered on every change. */
export function useRoute(): string {
  return useSyncExternalStore(onRouteChange, currentRoute, () => '');
}
