import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { HelpMenu } from './HelpMenu';

function renderMenu() {
  render(
    <I18nProvider locale="en">
      <HelpMenu />
    </I18nProvider>,
  );
  return screen.getByRole('button', { name: 'Help' });
}

describe('the Help menu (ADR-114)', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('[NFR-005] works as a menu button with the keyboard', async () => {
    const user = userEvent.setup();
    const button = renderMenu();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    button.focus();
    await user.keyboard('{ArrowDown}');
    const menu = screen.getByRole('menu', { name: 'Help' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Tutorials', 'Keyboard shortcuts']);
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('[NFR-005] lists every keyboard shortcut in a dialog and gives focus back', async () => {
    const user = userEvent.setup();
    const button = renderMenu();
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Ctrl K')).toBeVisible();
    expect(within(dialog).getByText('Write a comment')).toBeVisible();
    expect(within(dialog).getByText(/Alt\+Left and Alt\+Right/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('opens the tutorials', async () => {
    const user = userEvent.setup();
    await user.click(renderMenu());
    await user.click(screen.getByRole('menuitem', { name: 'Tutorials' }));
    expect(window.location.hash).toBe('#/settings/tutorials');
  });
});
