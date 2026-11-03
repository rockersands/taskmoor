import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter, type Router } from './router';

const at = (address: string) => window.history.replaceState(null, '', address);
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

/** A link in the page, clicked the way a person clicks it. */
function click(href: string, init: MouseEventInit = {}, attributes: Record<string, string> = {}) {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
  link.textContent = 'link';
  document.body.append(link);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  // The window hears the click after the router's document listener: note whether the router
  // took it, then stop jsdom from following a link the router left alone.
  let handled = false;
  const after = (e: Event) => {
    handled = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener('click', after);
  link.dispatchEvent(event);
  window.removeEventListener('click', after);
  link.remove();
  return handled;
}

describe('hash routing', () => {
  const router = createRouter(window, { routing: 'hash', basePath: '/' });
  beforeEach(() => at('/'));

  it('[OPS-013] keeps routes in the fragment and links to them as they are', () => {
    at('/#/boards/7?x=1');
    expect(router.current()).toBe('#/boards/7?x=1');
    expect(router.href('#/tickets/ABC-1')).toBe('#/tickets/ABC-1');
    expect(router.url('#/tickets/ABC-1')).toBe('http://localhost:3000/#/tickets/ABC-1');
    router.replace('#/search?q=x');
    expect(address()).toBe('/#/search?q=x');
    router.replace('');
    expect(address()).toBe('/');
  });

  it('[IMP-011] redirects in place of the current entry and tells listeners', () => {
    at('/#/browse/ABC-42');
    const listener = vi.fn();
    const stop = router.subscribe(listener);
    const before = window.history.length;
    router.redirect('#/tickets/ABC-42');
    expect(address()).toBe('/#/tickets/ABC-42');
    expect(window.history.length).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('[OPS-013] tells listeners about a new route', () => {
    const listener = vi.fn();
    const stop = router.subscribe(listener);
    router.navigate('#/boards');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(router.current()).toBe('#/boards');
    expect(listener).toHaveBeenCalled();
    stop();
  });
});

describe('clean URLs', () => {
  let router: Router;
  let stop: () => void;
  beforeEach(() => {
    at('/');
    router = createRouter(window, { routing: 'path', basePath: '/' });
    stop = router.start();
  });
  afterEach(() => stop());

  it('[OPS-013] reads the route from the path and writes routes as paths', () => {
    at('/boards/7?x=1');
    expect(router.current()).toBe('#/boards/7?x=1');
    at('/');
    expect(router.current()).toBe('');
    expect(router.href('#/tickets/ABC-1')).toBe('/tickets/ABC-1');
    expect(router.href('')).toBe('/');
    expect(router.url('#/tickets/ABC-1?comment=4')).toBe(
      'http://localhost:3000/tickets/ABC-1?comment=4',
    );
  });

  it('[OPS-013] pushes a history entry per navigation and tells listeners', () => {
    const listener = vi.fn();
    const unsubscribe = router.subscribe(listener);
    const before = window.history.length;
    router.navigate('#/boards/7');
    expect(address()).toBe('/boards/7');
    expect(router.current()).toBe('#/boards/7');
    expect(window.history.length).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    router.navigate('#/boards/7');
    expect(listener).toHaveBeenCalledTimes(1);
    router.replace('#/boards/7?quick=mine');
    expect(address()).toBe('/boards/7?quick=mine');
    expect(listener).toHaveBeenCalledTimes(1);
    router.redirect('#/tickets/ABC-42');
    expect(address()).toBe('/tickets/ABC-42');
    expect(window.history.length).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('[OPS-013] opens a hash link and rewrites it to its path, except one carrying a token', () => {
    stop();
    at('/#/tickets/ABC-1?comment=3');
    stop = router.start();
    expect(address()).toBe('/tickets/ABC-1?comment=3');
    expect(router.current()).toBe('#/tickets/ABC-1?comment=3');
    // A later hash change (an old link, location.hash written somewhere) is tidied the same way.
    window.location.hash = '#/boards';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(address()).toBe('/boards');
    stop();
    at('/#/setup?token=abc');
    stop = router.start();
    expect(address()).toBe('/#/setup?token=abc');
    expect(router.current()).toBe('#/setup?token=abc');
  });

  it('[OPS-013] takes over links into the app and leaves the rest to the browser', () => {
    expect(click('/boards/7')).toBe(true);
    expect(address()).toBe('/boards/7');
    expect(click('#/tickets/ABC-1')).toBe(true);
    expect(address()).toBe('/tickets/ABC-1');
    expect(click('/')).toBe(true);
    expect(address()).toBe('/');
    // A new tab, a download, another origin and the API stay the browser's.
    expect(click('/boards/8', { ctrlKey: true })).toBe(false);
    expect(click('/boards/8', { metaKey: true })).toBe(false);
    expect(click('/boards/8', {}, { target: '_blank' })).toBe(false);
    expect(click('/api/v1/search/export?q=x', {}, { download: '' })).toBe(false);
    expect(click('/api/v1/releases/1/notes')).toBe(false);
    expect(click('https://example.com/boards/8')).toBe(false);
    expect(address()).toBe('/');
  });

  it('[OPS-013] moves to an in-page target without leaving the page', () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);
    at('/boards/7');
    expect(click('#main')).toBe(true);
    expect(address()).toBe('/boards/7');
    expect(document.activeElement).toBe(main);
    main.remove();
  });

  it('[OPS-013] writes routes below a base path and ignores addresses outside it', () => {
    stop();
    router = createRouter(window, { routing: 'path', basePath: '/tracker/' });
    stop = router.start();
    expect(router.href('#/boards/7')).toBe('/tracker/boards/7');
    at('/tracker/boards/7');
    expect(router.current()).toBe('#/boards/7');
    at('/tracker');
    expect(router.current()).toBe('');
    at('/elsewhere/boards/7');
    expect(router.current()).toBe('');
    at('/tracker/');
    expect(click('/tracker/boards/8')).toBe(true);
    expect(address()).toBe('/tracker/boards/8');
    expect(click('/tracker/api/v1/x')).toBe(false);
    expect(click('/other/page')).toBe(false);
  });
});

describe.each([
  ['hash', '/#/tracks/FE/board?people=7', (route: string) => `/${route}`],
  ['path', '/tracks/FE/board?people=7', (route: string) => `/${route.slice(2)}`],
] as const)('a ticket over a page (%s routing)', (mode, page, addressOf) => {
  const BOARD = '#/tracks/FE/board?people=7';
  const TICKET = '#/tickets/FE-12';
  let router: Router;
  let stop: () => void;
  const link = (route: string) => (mode === 'hash' ? route : addressOf(route));
  const back = async (toAddress: string) => {
    window.history.back();
    await vi.waitFor(() => expect(address()).toBe(toAddress));
  };

  beforeEach(() => {
    router = createRouter(window, { routing: mode, basePath: '/' });
    stop = router.start();
    window.history.pushState(null, '', page);
  });
  afterEach(() => stop());

  it('[AGL-018] a plain click pushes the ticket’s address and the page stays the route', () => {
    const changed = vi.fn();
    const unsubscribe = router.subscribe(changed);
    expect(click(link(TICKET))).toBe(true);
    unsubscribe();
    expect(address()).toBe(addressOf(TICKET));
    expect(router.address()).toBe(TICKET);
    expect(router.current()).toBe(BOARD);
    expect(router.overlay()).toBe(TICKET);
    expect(router.overlayDepth()).toBe(1);
    expect(changed).toHaveBeenCalled();
  });

  it('[AGL-018] Ctrl, Cmd, Shift, middle click, a new tab and other routes are left alone', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(click(link(TICKET), init)).toBe(false);
    }
    expect(click(link(TICKET), {}, { target: '_blank' })).toBe(false);
    expect(router.overlay()).toBeNull();
    click(link('#/tickets/FE-12/elsewhere'));
    click(link('#/boards/7'));
    expect(router.overlay()).toBeNull();
  });

  it('[AGL-018] a link with data-full-page leaves the page instead', () => {
    expect(click(link(TICKET), {}, { 'data-full-page': '' })).toBe(mode === 'path');
    expect(router.overlay()).toBeNull();
  });

  it('[AGL-018] the way out to the full page is a new entry, with no page beneath', async () => {
    click(link(TICKET));
    expect(click(link(TICKET), {}, { 'data-full-page': '' })).toBe(true);
    expect(address()).toBe(addressOf(TICKET));
    expect(router.overlay()).toBeNull();
    expect(router.current()).toBe(TICKET);
    await back(addressOf(TICKET));
    await vi.waitFor(() => expect(router.overlay()).toBe(TICKET));
    expect(router.current()).toBe(BOARD);
  });

  it('[AGL-018] Back steps through tickets to the page; closing goes there at once', async () => {
    click(link(TICKET));
    click(link('#/tickets/FE-13?comment=4'));
    expect(router.overlayDepth()).toBe(2);
    expect(router.current()).toBe(BOARD);
    await back(addressOf(TICKET));
    expect(router.overlayDepth()).toBe(1);
    expect(router.current()).toBe(BOARD);
    await back(page);
    expect(router.overlay()).toBeNull();
    expect(router.current()).toBe(BOARD);

    click(link(TICKET));
    click(link('#/tickets/FE-13'));
    router.closeOverlay();
    await vi.waitFor(() => expect(address()).toBe(page));
    expect(router.overlay()).toBeNull();
  });

  it('[AGL-018] closing with no history below it rewrites the entry to the page', () => {
    vi.useFakeTimers();
    try {
      click(link(TICKET));
      const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
      router.closeOverlay();
      vi.advanceTimersByTime(2000);
      go.mockRestore();
      expect(address()).toBe(page);
      expect(router.overlay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[AGL-018] a reload reads the same entry: the ticket over its page', () => {
    click(link(TICKET));
    const again = createRouter(window, { routing: mode, basePath: '/' });
    expect(again.overlay()).toBe(TICKET);
    expect(again.current()).toBe(BOARD);
  });

  it('[AGL-018] the same address with no state, as a shared link, is the full page', () => {
    window.history.pushState(null, '', addressOf(TICKET));
    expect(router.overlay()).toBeNull();
    expect(router.current()).toBe(TICKET);
  });

  it('[AGL-018] the page beneath rewrites its own route, not the ticket’s address', () => {
    click(link(TICKET));
    router.replace('#/tracks/FE/board?people=8');
    expect(address()).toBe(addressOf(TICKET));
    expect(router.current()).toBe('#/tracks/FE/board?people=8');
    router.replaceOverlay('#/tickets/BE-1');
    expect(router.address()).toBe('#/tickets/BE-1');
    expect(router.current()).toBe('#/tracks/FE/board?people=8');
  });

  describe('a page that holds unsaved text (T-190)', () => {
    /** The full ticket page, guarded: anything but its own ticket would lose a draft. */
    function guarded(holding = true) {
      window.history.pushState(null, '', addressOf(TICKET));
      const ask = vi.fn<(proceed: () => void) => void>();
      const release = router.guardLeave({
        holds: (route) => holding && !route.startsWith(TICKET),
        ask,
      });
      return { ask, release, proceed: () => ask.mock.calls.at(-1)?.[0]() };
    }

    it('[NFR-005] a link out of the page asks first, and goes when told', async () => {
      const { ask, release, proceed } = guarded();
      expect(click(link('#/boards/7'))).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(router.current()).toBe(TICKET);
      proceed();
      await vi.waitFor(() => expect(router.current()).toBe('#/boards/7'));
      release();
    });

    it('[NFR-005] a comment of the page, a ticket over it, or nothing held, do not ask', () => {
      const { ask, release } = guarded();
      click(link(`${TICKET}?comment=3`));
      click(link('#/tickets/FE-13'));
      expect(router.overlay()).toBe('#/tickets/FE-13');
      expect(ask).not.toHaveBeenCalled();
      release();
      const free = guarded(false);
      expect(click(link('#/boards/7'))).toBe(mode === 'path');
      expect(free.ask).not.toHaveBeenCalled();
      free.release();
    });

    it('[NFR-005] Back comes back to the page at once and asks; going on steps back', async () => {
      const { ask, release, proceed } = guarded();
      const heard = vi.fn(() => router.current());
      const unsubscribe = router.subscribe(heard);
      window.history.back();
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
      expect(address()).toBe(addressOf(TICKET));
      expect(router.current()).toBe(TICKET);
      // Whoever listens reads the page's route, never the one left.
      for (const result of heard.mock.results) expect(result.value).toBe(TICKET);
      proceed();
      await vi.waitFor(() => expect(address()).toBe(page));
      expect(router.current()).toBe(BOARD);
      unsubscribe();
      release();
    });

    it('[NFR-005] once released, Back goes at once', async () => {
      const { ask, release } = guarded();
      release();
      await back(page);
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it('[AGL-018] on a ticket’s own page, a link to a comment there stays on that page', () => {
    window.history.pushState(null, '', addressOf(TICKET));
    click(link(`${TICKET}?comment=3`));
    expect(router.overlay()).toBeNull();
    click(link('#/tickets/FE-13'));
    expect(router.overlay()).toBe('#/tickets/FE-13');
    expect(router.current().startsWith(TICKET)).toBe(true);
  });
});
