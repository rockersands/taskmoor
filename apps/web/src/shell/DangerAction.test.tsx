import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { DangerAction } from './DangerAction';

function deactivate(onConfirm = vi.fn()) {
  render(
    <I18nProvider locale="en">
      <DangerAction
        label="Deactivate"
        outcome="Ana Ruiz can no longer sign in. Her tickets and comments stay."
        confirmLabel="Deactivate Ana Ruiz"
        onConfirm={onConfirm}
      />
    </I18nProvider>,
  );
  return onConfirm;
}

describe('an action that removes something (D13)', () => {
  it('[NFR-005] asks first, naming what will happen, with focus on Cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = deactivate();
    const first = screen.getByRole('button', { name: 'Deactivate' });
    expect(first).toHaveClass('button-danger-quiet');
    await user.click(first);
    expect(onConfirm).not.toHaveBeenCalled();
    const question = screen.getByRole('group', {
      name: 'Ana Ruiz can no longer sign in. Her tickets and comments stay.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(question).getByRole('button', { name: 'Deactivate Ana Ruiz' })).toHaveClass(
      'button-danger',
    );
  });

  it('[NFR-005] does it only on the named confirmation', async () => {
    const user = userEvent.setup();
    const onConfirm = deactivate();
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Deactivate Ana Ruiz' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('[NFR-005] goes back on Cancel and on Escape, focus on the button, nothing done', async () => {
    const user = userEvent.setup();
    const onConfirm = deactivate();
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Deactivate' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
