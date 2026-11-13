import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { SIGNED_IN } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { CommandPalette } from './CommandPalette';

describe('command palette', () => {
  it('[AGL-018] lists label matches before commands found by a keyword only', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <CommandPalette
          commands={[
            {
              id: 'appearance-system',
              labelId: 'palette.appearance.system',
              keywords: ['system'],
              run: () => {},
            },
            { id: 'go-system', labelId: 'admin.system.title', run: () => {} },
          ]}
        />
      </I18nProvider>,
    );
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('system');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['System status', 'Follow the device for light or dark']);
  });

  it('[AGL-018] opens over the whole page, out of the top bar, with a phone-sized prompt (PL-3, PL-49)', async () => {
    const user = userEvent.setup();
    const palette = (
      <I18nProvider locale="en">
        <header className="shell-topbar">
          <CommandPalette commands={[{ id: 'go-home', labelId: 'nav.home', run: () => {} }]} />
        </header>
      </I18nProvider>
    );
    const { unmount } = render(palette);
    await user.keyboard('{Control>}k{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'Close the command palette' }).parentElement).toBe(
      document.body,
    );
    expect(within(dialog).getByRole('combobox')).toHaveAttribute(
      'placeholder',
      'Type a command or a page name (Ctrl K opens this anywhere)',
    );
    unmount();

    // A phone: the prompt fits, and names no key the phone does not have.
    setViewportWidth(375);
    render(palette);
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveAttribute(
      'placeholder',
      'Type a command or a page',
    );
  });

  it('opens with Ctrl+K, filters, and runs the chosen command', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox');
    expect(input).toHaveFocus();
    // The seven pages, then making a ticket, the account, three appearances and signing out.
    expect(within(dialog).getAllByRole('option')).toHaveLength(13);

    await user.keyboard('trac');
    const options = within(dialog).getAllByRole('option');
    // Multi-track (ADR-122) matches too, after the label that starts with the letters typed.
    expect(options.map((o) => o.textContent)).toEqual(['Tracks', 'Multi-track']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(window.location.hash).toBe('#/tracks');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tracks' })).toBeInTheDocument();
  });

  it('[CORE-001] offers New track only to someone the server lets make one', async () => {
    const user = userEvent.setup();
    const person = {
      id: 1,
      name: 'Kalo',
      email: 'kalo@example.com',
      isSiteAdmin: false,
      isConfigAdmin: false,
      timeZone: null,
      locale: null,
    };
    window.location.hash = '#/settings';
    const none = render(<App session={{ status: 'signed-in', user: person }} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('new track');
    expect(screen.queryByRole('option', { name: 'New track' })).toBeNull();
    none.unmount();

    render(
      <App session={{ status: 'signed-in', user: { ...person, mayCreateLocalTracks: true } }} />,
    );
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('new track');
    expect(screen.getByRole('option', { name: 'New track' })).toBeVisible();
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/tracks?new');
    expect(await screen.findByRole('dialog', { name: 'New track' })).toBeVisible();
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('moves with the arrow keys and closes with Escape, returning focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const trigger = screen.getByRole('button', { name: /Search or jump to/ });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const selected = within(dialog)
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toBe('Search');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('zzz');
    expect(screen.getByRole('option', { name: 'No matching commands' })).toBeInTheDocument();
  });
});

describe('session guard', () => {
  it('shows a sign-in form on a protected page once the backend says anonymous', async () => {
    window.location.hash = '#/settings';
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to continue' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows the page to signed-in users', () => {
    window.location.hash = '#/settings';
    render(
      <App
        session={{
          status: 'signed-in',
          user: {
            id: 1,
            name: 'Kalo',
            email: 'kalo@example.com',
            isSiteAdmin: true,
            timeZone: null,
            locale: null,
          },
        }}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('[IAM-001] shows no page signed out, not even Tracks (D8)', async () => {
    window.location.hash = '#/tracks';
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to continue' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Tracks' })).toBeNull();
  });
});
