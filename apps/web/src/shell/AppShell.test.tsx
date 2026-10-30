import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App, NAV_ITEMS } from '../App';
import { setViewportWidth } from '../test/viewport';

describe('desktop layout', () => {
  it('shows every navigation item in the sidebar and marks the current page', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });

  it('collapses to an icon rail whose links keep their accessible names', async () => {
    const user = userEvent.setup();
    render(<App />);
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
    render(<App />);
    act(() => {
      window.location.hash = '#/tracks';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tracks');
    expect(screen.getByRole('link', { name: 'Tracks' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('compact layout (phones)', () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  it('hides navigation behind a menu button', () => {
    render(<App />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens a modal drawer and focuses its first link', async () => {
    const user = userEvent.setup();
    render(<App />);
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
    render(<App />);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu).toHaveFocus();
  });

  it('closes when a page is chosen and shows that page', async () => {
    const user = userEvent.setup();
    render(<App />);
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
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab focus inside the open drawer', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const links = within(screen.getByRole('dialog')).getAllByRole('link');
    const last = links[links.length - 1];
    act(() => last?.focus());

    await user.tab();
    expect(links[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('switches to the sidebar when the window grows past the breakpoint', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    act(() => setViewportWidth(1280));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
});

describe('pseudo-locale', () => {
  it('reaches every visible string and reports no missing message', () => {
    const errors: Error[] = [];
    render(<App locale="en-XA" onI18nError={(e) => errors.push(e)} />);
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
