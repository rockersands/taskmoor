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
 *
 * A ticket over a page (the ticket pop-up, `tickets/view/TicketPopup.tsx`). A plain click on a link
 * to a ticket pushes the ticket's own address with the page beneath held in that history entry's
 * state: `{ behind: '#/tracks/FE/board?people=1', depth: 1 }`. So:
 * - `current()` and `useRoute()` answer the page beneath, the page's own `replace()` rewrites the
 *   route held in the state, and `address()` is what the address bar says. The page beneath never
 *   sees a change of route: it stays mounted, keeps its scroll and filters and does not read again.
 * - A shared link, or a new tab, has no state: the same address is the full page, as it always was.
 * - A reload keeps the entry's state, so it brings the pop-up back over its page. The page reads
 *   its data again, as any reload does, and the ticket shows either way.
 * - Back steps to the entry below: the ticket before, from a link inside the pop-up (`depth` counts
 *   them), or the page beneath, which closes the pop-up. Closing with Escape, the button or a click
 *   outside goes back `depth` entries at once, so a later Back does not bring it up again, and
 *   Forward does. A history that cannot go back that far rewrites the entry to the page instead.
 *
 * Which links: `start()` listens for clicks on real links, one place, so a new list gets the pop-up
 * for free and keeps a real address for Ctrl, Cmd, Shift and middle click. A link, or anything
 * around it, with the `data-full-page` attribute opts out and leaves the page instead.
 *
 * Leaving a page that holds unsaved text (NFR-005; the full ticket page, `TicketPage.tsx`): the
 * page sets a `LeaveGuard`, and a link inside the app or a `navigate()` (a palette command, a
 * menu, a copy opened after Clone) that would leave it asks first, then goes on, the same in
 * both modes. Back and Forward cannot be refused: the page's entry comes back at once as a new
 * entry (with the entry the person went to just behind it), the page beneath never changes, and
 * discarding steps back to it. Opening a ticket over the page does not leave it. A link out of
 * the app, a reload or closing the tab are the browser's own `beforeunload` question.
 */
export interface LeaveGuard {
  /** Whether going to `route` (the page's route, as `current()` says it) would lose something. */
  holds(route: string): boolean;
  /** Asks the person; `proceed` goes on to where they were going. */
  ask(proceed: () => void): void;
}

export interface Router {
  readonly mode: RoutingMode;
  /** The current page's route, `#/boards/7` in either mode: with a ticket over it, the page beneath. */
  current(): string;
  /** The route the address bar shows, which is the ticket's while one shows over a page. */
  address(): string;
  /** The route showing over the page, or null. */
  overlay(): string | null;
  /** How many tickets opened one from another are stacked in history; 0 with none over the page. */
  overlayDepth(): number;
  /** Shows the route over the current page, as a new history entry. */
  openOverlay(route: string): void;
  /** Rewrites the address of the route over the page, without a new entry or a change event. */
  replaceOverlay(route: string): void;
  /** Back to the page beneath, whatever the number of tickets opened on the way. */
  closeOverlay(): void;
  /** What a link to the route points at: the route itself, or its path. */
  href(route: string): string;
  /** The route as an absolute address, for copying. */
  url(route: string): string;
  /**
   * Goes to the route as a new history entry. Leaving a page whose guard holds asks first, as a
   * link does, and goes only when told.
   */
  navigate(route: string): void;
  /** Rewrites the address without a new entry or a change event, as history.replaceState does. */
  replace(route: string): void;
  /** Goes to the route in place of the current entry, with a change event (M1-128). */
  redirect(route: string): void;
  /** Calls the listener after every route change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Asks before a link, `navigate()` or Back leaves the page while the guard holds; returns the
   * release.
   */
  guardLeave(guard: LeaveGuard): () => void;
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

/** What a history entry holds while a ticket shows over a page. */
interface OverlayState {
  behind: string;
  depth: number;
}
const OVERLAY = 'taskmoorOverlay';

/** Links in or around such an element leave the page rather than open the pop-up. */
export const FULL_PAGE_ATTRIBUTE = 'data-full-page';

/** The ticket a route is exactly about, in lower case; null for any other route. */
function ticketOfRoute(route: string): string | null {
  return /^#\/tickets\/([^/?#]+)(?:\?[^#]*)?$/.exec(route)?.[1]?.toLowerCase() ?? null;
}

/** A plain press of a real link, in this tab. Null for anything the browser should handle. */
export function pressedLink(event: MouseEvent): { anchor: Element; raw: string } | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  // HTML and SVG links alike, so read attributes rather than HTMLAnchorElement properties.
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!anchor) return null;
  const target = anchor.getAttribute('target');
  if ((target && target !== '_self') || anchor.hasAttribute('download')) return null;
  return { anchor, raw: anchor.getAttribute('href') ?? '' };
}

/** Moves focus to the link pressed: Safari does not, and closing the pop-up returns it here. */
function holdFocus(anchor: Element) {
  (anchor as HTMLElement).focus?.({ preventScroll: true });
}

export function createRouter(
  win: Window,
  config: Pick<RuntimeConfig, 'routing' | 'basePath'>,
): Router {
  const base = config.basePath;
  const notify = () => win.dispatchEvent(new Event(CHANGE));

  const overlayState = (): OverlayState | null => {
    const held = (win.history.state as Record<string, OverlayState> | null)?.[OVERLAY];
    return held && typeof held.behind === 'string' && held.depth > 0 ? held : null;
  };
  /** The page beneath takes a new route: only the state changes, not the address. */
  const holdBehind = (route: string) =>
    win.history.replaceState(
      { ...win.history.state, [OVERLAY]: { ...overlayState(), behind: route } },
      '',
    );
  /** A plain press of a link to a ticket other than the page's own opens it over the page. */
  const opensOverlay = (route: string, anchor: Element, page: string) => {
    const ticket = ticketOfRoute(route);
    if (ticket === null || anchor.closest(`[${FULL_PAGE_ATTRIBUTE}]`)) return false;
    return overlayState() !== null || ticketOfRoute(page) !== ticket;
  };
  /** The parts every mode shares, given what differs: its address and how to write one. */
  const overlayPart = (address: () => string, write: (route: string) => string) => ({
    overlay: () => (overlayState() ? address() : null),
    overlayDepth: () => overlayState()?.depth ?? 0,
    openOverlay: (route: string) => {
      const held = overlayState();
      if (held && route === address()) return;
      const state: OverlayState = {
        behind: held?.behind ?? address(),
        depth: (held?.depth ?? 0) + 1,
      };
      win.history.pushState({ [OVERLAY]: state }, '', write(route));
      notify();
    },
    replaceOverlay: (route: string) =>
      win.history.replaceState(win.history.state, '', write(route)),
    closeOverlay: () => {
      const held = overlayState();
      if (!held) return;
      // A history restored without its earlier entries goes nowhere: the page takes this entry.
      const stuck = win.setTimeout(() => {
        const behind = overlayState()?.behind;
        if (behind === undefined) return;
        win.history.replaceState(null, '', write(behind));
        notify();
      }, 1000);
      win.addEventListener('popstate', () => win.clearTimeout(stuck), { once: true });
      win.history.go(-held.depth);
    },
  });

  /**
   * The guard on leaving the page (see the comment above `LeaveGuard`), given how the mode reads
   * the page's route. It keeps the entry on show, to bring back when Back or Forward would lose
   * what the page holds; its listener comes before any of `subscribe`'s, so they read the page's
   * route again rather than the one left.
   */
  const leavePart = (current: () => string) => {
    let guard: LeaveGuard | null = null;
    let seen: { url: string; state: unknown } = {
      url: win.location.href,
      state: win.history.state,
    };
    const remember = () => {
      seen = { url: win.location.href, state: win.history.state };
    };
    /** Asks the guard; going on lets the page go, and it is gone by then. */
    const ask = (held: LeaveGuard, go: () => void) =>
      held.ask(() => {
        if (guard === held) guard = null;
        go();
      });
    win.addEventListener('popstate', () => {
      const held = guard;
      if (held?.holds(current())) {
        win.history.pushState(seen.state, '', seen.url);
        ask(held, () => win.history.back());
        return;
      }
      remember();
    });
    win.addEventListener('hashchange', remember);
    win.addEventListener(CHANGE, remember);
    return {
      remember,
      /** A link to `route` would leave the page while the guard holds: asked, then `go`. */
      asked: (route: string, go: () => void) => {
        const held = guard;
        if (!held?.holds(route)) return false;
        ask(held, go);
        return true;
      },
      /** `go` to `route`, asking first when that would leave the page while the guard holds. */
      guarded: (route: string, go: () => void) => {
        const held = guard;
        if (held?.holds(route)) ask(held, go);
        else go();
      },
      guardLeave: (next: LeaveGuard) => {
        guard = next;
        remember();
        return () => {
          if (guard === next) guard = null;
        };
      },
    };
  };

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
    const address = () => win.location.hash;
    const here = () => `${win.location.pathname}${win.location.search}`;
    const write = (route: string) => (route ? `${here()}${route}` : here());
    const part = overlayPart(address, write);
    const replace = (route: string) => {
      if (overlayState()) holdBehind(route);
      else win.history.replaceState(win.history.state, '', write(route));
      leave.remember();
    };
    // Every other link is the browser's own business in this mode (it only moves the fragment),
    // unless it leaves a page that asks first.
    const onClick = (event: MouseEvent) => {
      const pressed = pressedLink(event);
      if (!pressed || !pressed.raw.includes('#/')) return;
      const url = new URL(pressed.raw, win.document.baseURI);
      if (url.origin !== win.location.origin || url.pathname !== win.location.pathname) return;
      if (opensOverlay(url.hash, pressed.anchor, current())) {
        event.preventDefault();
        holdFocus(pressed.anchor);
        part.openOverlay(url.hash);
      } else if (leave.asked(url.hash, () => go(url.hash))) {
        event.preventDefault();
      } else if (overlayState() && url.hash === address()) {
        // The way out to the full page: the fragment does not change, so the browser would stay.
        event.preventDefault();
        navigate(url.hash);
      }
    };
    const current = () => overlayState()?.behind ?? address();
    const leave = leavePart(current);
    /** Goes to the route, whatever the page holds. */
    const go = (route: string) => {
      if (overlayState() && route === address()) {
        win.history.pushState(null, '', write(route));
        notify();
      } else {
        win.location.hash = route;
      }
    };
    // Asked here, not only when the fragment's change comes back as popstate: the page stays
    // until the person answers, as in the other mode.
    const navigate = (route: string) => leave.guarded(route, () => go(route));
    return {
      mode: 'hash',
      current,
      address,
      ...part,
      replaceOverlay: (route) => {
        part.replaceOverlay(route);
        leave.remember();
      },
      guardLeave: leave.guardLeave,
      href: (route) => route,
      url: (route) => `${win.location.origin}${win.location.pathname}${route}`,
      navigate,
      replace,
      redirect: (route) => {
        replace(route);
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
        win.document.addEventListener('click', onClick);
        return () => win.document.removeEventListener('click', onClick);
      },
    };
  }

  const href = (route: string) => `${base}${routePath(route)}`;
  const here = () => `${win.location.pathname}${win.location.search}${win.location.hash}`;
  const address = () => routeOfUrl(new URL(win.location.href)) ?? '';
  const current = () => overlayState()?.behind ?? address();
  const part = overlayPart(address, href);
  const leave = leavePart(current);
  const navigate = (route: string) => {
    if (href(route) === here() && !overlayState()) return;
    // Nothing comes back as popstate in this mode: a page that holds unsaved text asks here.
    leave.guarded(route, () => {
      win.history.pushState(null, '', href(route));
      notify();
    });
  };
  const replace = (route: string) => {
    if (overlayState()) holdBehind(route);
    else win.history.replaceState(win.history.state, '', href(route));
    leave.remember();
  };
  /** A hash route in the address becomes its path, unless it carries a token. */
  const tidy = () => {
    const hash = win.location.hash;
    if (!hash.startsWith('#/') || TOKEN.test(hash)) return;
    win.history.replaceState(win.history.state, '', href(hash));
    leave.remember();
  };
  const onClick = (event: MouseEvent) => {
    const pressed = pressedLink(event);
    if (!pressed) return;
    const { anchor, raw } = pressed;
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
    if (opensOverlay(route, anchor, current())) {
      holdFocus(anchor);
      part.openOverlay(route);
    } else {
      navigate(route);
    }
  };

  return {
    mode: 'path',
    current,
    address,
    ...part,
    replaceOverlay: (route) => {
      part.replaceOverlay(route);
      leave.remember();
    },
    guardLeave: leave.guardLeave,
    href,
    url: (route) => new URL(href(route), win.location.origin).href,
    navigate,
    replace,
    redirect: (route) => {
      replace(route);
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
export const addressRoute = (): string => router.address();
export const overlayRoute = (): string | null => router.overlay();
export const overlayDepth = (): number => router.overlayDepth();
export const openOverlay = (route: string): void => router.openOverlay(route);
export const replaceOverlay = (route: string): void => router.replaceOverlay(route);
export const closeOverlay = (): void => router.closeOverlay();
export const guardLeave = (guard: LeaveGuard): (() => void) => router.guardLeave(guard);

/** The current page's route, re-rendered on every change. */
export function useRoute(): string {
  return useSyncExternalStore(onRouteChange, currentRoute, () => '');
}

/** The route showing over the page, re-rendered on every change; null with none. */
export function useOverlayRoute(): string | null {
  return useSyncExternalStore(onRouteChange, overlayRoute, () => null);
}
