import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
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

  it('opens with Ctrl+K, filters, and runs the chosen command', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox');
    expect(input).toHaveFocus();
    expect(within(dialog).getAllByRole('option')).toHaveLength(7);

    await user.keyboard('trac');
    const options = within(dialog).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Tracks']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(window.location.hash).toBe('#/tracks');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tracks' })).toBeInTheDocument();
  });

  it('moves with the arrow keys and closes with Escape, returning focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = screen.getByRole('button', { name: /Search or jump to/ });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const selected = within(dialog)
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toBe('Boards');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<App />);
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

  it('leaves public pages open to everyone', () => {
    window.location.hash = '#/dashboards';
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
  });
});
