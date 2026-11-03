import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { ThemeToggle } from './ThemeToggle';

afterEach(() => {
  delete document.documentElement.dataset.skin;
});

describe('the light and dark switch (ADR-114)', () => {
  it('[NFR-005] offers the mode opposite to the one on screen and follows changes made elsewhere', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn((skin: string) => {
      document.documentElement.dataset.skin = skin;
    });
    document.documentElement.dataset.skin = 'light';
    render(
      <I18nProvider locale="en">
        <ThemeToggle onChoose={onChoose} />
      </I18nProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(onChoose).toHaveBeenCalledWith('dark');
    expect(await screen.findByRole('button', { name: 'Switch to light mode' })).toBeVisible();

    // The account page or the palette changed it back.
    document.documentElement.dataset.skin = 'light';
    expect(await screen.findByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
  });
});
