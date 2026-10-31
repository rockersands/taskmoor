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
