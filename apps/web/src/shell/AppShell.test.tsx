import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NAV_ITEMS } from '../App';
import { KALO, SIGNED_IN } from '../account/fixtures';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { trackSectionsChanged } from '../tracks/trackSections';

describe('desktop layout', () => {
  it('shows every navigation item in the sidebar and marks the current page', () => {
    render(<App session={SIGNED_IN} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });

  it('collapses to an icon rail whose links keep their accessible names', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Tracks' })).toBeInTheDocument();
    expect(within(nav).queryByText('Tracks')).toBeNull();
  });

  it('shows the page named in the URL hash', () => {
    render(<App session={SIGNED_IN} />);
    act(() => {
      window.location.hash = '#/tracks';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tracks');
    expect(screen.getByRole('link', { name: 'Tracks' })).toHaveAttribute('aria-current', 'page');
  });

  it.each([
    '#/tracks',
    '#/tracks/SHOP',
    '#/tracks/SHOP/board',
    '#/tickets/SHOP-1',
    '#/boards/7',
    '#/boards/7/settings',
  ])('[CORE-001] Tracks is one plain link, current inside %s', (hash) => {
    render(<App session={SIGNED_IN} />);
    act(() => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const tracks = within(nav).getByRole('link', { name: 'Tracks' });
    expect(tracks).toHaveAttribute('aria-current', 'page');
    expect(tracks).toHaveAttribute('href', '#/tracks');
    expect(tracks).not.toHaveAttribute('aria-expanded');
    expect(within(nav).getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
  });

  it.each(['#/create', '#/bulk/8'])(
    '[CORE-001] marks no section on %s, which is no page of a track (PL-43)',
    (hash) => {
      window.location.hash = hash;
      render(<App session={SIGNED_IN} />);
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull();
    },
  );

  it('[NFR-005] says an address matches no page, rather than showing Home (D4, AC-3)', () => {
    window.location.hash = '#/no-such-page';
    render(<App session={SIGNED_IN} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing is at this address/);
    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '#/home');
    expect(screen.getByRole('link', { name: 'Go to Search' })).toHaveAttribute('href', '#/search');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('[NFR-005] marks no section on a track that is not there (D4)', async () => {
    window.location.hash = '#/tracks/NOPE/board';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: 'not_found' })),
    );
    render(<App session={SIGNED_IN} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Track not found' })).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Sections of NOPE' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await waitFor(() => expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull());
  });

  it('[NFR-005] marks Tracks again once a track that was not there is back at the same address (D4)', async () => {
    window.location.hash = '#/tracks/BACK/files';
    let restored = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        restored && String(url).endsWith('/tracks/BACK')
          ? jsonResponse(200, { track: { sections: { backlog: false, sprints: false } } })
          : jsonResponse(404, { error: 'not_found' }),
      ),
    );
    render(<App session={SIGNED_IN} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Track not found' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await waitFor(() => expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull());
    // Restored from the trash: the open page reads the track again, at the same address.
    restored = true;
    act(() => trackSectionsChanged('BACK'));
    expect(await screen.findByRole('navigation', { name: 'Sections of BACK' })).toBeVisible();
    expect(window.location.hash).toBe('#/tracks/BACK/files');
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Tracks' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
  });

  it('[CORE-001] Tracks is not current outside a track', () => {
    render(<App session={SIGNED_IN} />);
    act(() => {
      window.location.hash = '#/search';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('link', { name: 'Tracks' })).not.toHaveAttribute('aria-current');
  });
});

describe('compact layout (phones)', () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  it('hides navigation behind a menu button', () => {
    render(<App session={SIGNED_IN} />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens a modal drawer and focuses its first link', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(within(drawer).getByRole('link', { name: 'Home' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('closes on Escape and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu).toHaveFocus();
  });

  it('closes when a page is chosen and shows that page', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('link', {
        name: 'Tracks',
      }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Tracks' })).toBeInTheDocument();
  });

  it('closes when the backdrop is tapped', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const backdrop = document.querySelector('.shell-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[NFR-005] heads the drawer with the product name and a close button that hands focus back (S3-SP-12)', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    const drawer = within(screen.getByRole('dialog', { name: 'Navigation' }));
    expect(drawer.getByText('Taskmoor')).toBeVisible();
    await user.click(drawer.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu).toHaveFocus();
  });

  it('keeps Tab focus inside the open drawer', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = within(screen.getByRole('dialog'));
    const close = drawer.getByRole('button', { name: 'Close navigation' });
    const links = drawer.getAllByRole('link');
    const last = links[links.length - 1];
    act(() => last?.focus());

    // Round from the last link to the close button at the top, and back.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('switches to the sidebar when the window grows past the breakpoint', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    act(() => setViewportWidth(1280));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
});

describe('pseudo-locale', () => {
  it('reaches every visible string and reports no missing message', () => {
    const errors: Error[] = [];
    render(<App session={SIGNED_IN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Key names such as "Ctrl K" are hidden from assistive technology and not translated.
      if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
      const text = node.textContent?.trim();
      if (text) texts.push(text);
    }
    for (const el of document.body.querySelectorAll('[aria-label], [title]')) {
      for (const attr of ['aria-label', 'title']) {
        const value = el.getAttribute(attr);
        if (value) texts.push(value);
      }
    }
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.filter((t) => !/^\[.+\]$/s.test(t))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('signed out: the reduced frame (D8)', () => {
  it.each(['#/home', '#/tracks', '#/inbox', '#/no-such-page'])(
    '[IAM-001] shows only the product name and the sign-in page at %s',
    async (hash) => {
      window.location.hash = hash;
      render(<App />);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Sign in to continue' }),
      ).toBeVisible();
      // The first banner: the test library counts a page's own header too, where a browser does not.
      expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Taskmoor');
      expect(screen.queryByRole('navigation')).toBeNull();
      // Nothing that answers as if there were nothing to see (AC-2), and no second way in (AC-13).
      expect(screen.queryByText('No tracks yet')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
      expect(screen.getByText('You need to sign in to see this page.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    },
  );

  it('[IAM-001] keeps the sign-in page its own title', async () => {
    window.location.hash = '#/sign-in';
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('[IAM-001] waits in the frame with a neutral note while the session is checked (T-214)', () => {
    render(<App session={{ status: 'loading' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(screen.queryByText(/under construction/)).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('[IAM-001] shows the page asked for once signed in there', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session') && init?.method === 'POST') {
          signedIn = true;
          return jsonResponse(200, { user: KALO });
        }
        if (String(url).endsWith('/session') && signedIn) {
          return jsonResponse(200, { user: KALO });
        }
        return jsonResponse(signedIn ? 200 : 401, signedIn ? {} : { error: 'not_signed_in' });
      }),
    );
    window.location.hash = '#/settings';
    render(<App />);
    // The deep link opens in the reduced frame: the product name, the sign-in form, no app.
    await user.type(await screen.findByLabelText('Email'), 'kalo@example.com');
    expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Taskmoor');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Settings' })).toBeNull();
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // Signed in, the same address shows its page inside the whole frame.
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(window.location.hash).toBe('#/settings');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
