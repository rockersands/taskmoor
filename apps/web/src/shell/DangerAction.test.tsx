import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

  it('[NFR-005] waits while the action runs: one request, neither answer, no Escape', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = deactivate(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    const yes = screen.getByRole('button', { name: 'Deactivate Ana Ruiz' });
    await user.dblClick(yes);
    expect(onConfirm).toHaveBeenCalledOnce();
    const question = screen.getByRole('group');
    expect(question).toHaveAttribute('aria-busy', 'true');
    expect(yes).toHaveAttribute('aria-disabled', 'true');
    expect(yes).toHaveFocus();
    const no = screen.getByRole('button', { name: 'Cancel' });
    expect(no).toHaveAttribute('aria-disabled', 'true');
    await user.click(no);
    await user.keyboard('{Escape}');
    await user.click(yes);
    expect(screen.getByRole('group')).toBe(question);
    expect(onConfirm).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toHaveFocus();
  });

  it('[NFR-005] stays open on a refusal, adding nothing, to try again or cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = deactivate(vi.fn().mockRejectedValueOnce(new Error('refused')));
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    const question = screen.getByRole('group');
    const before = question.textContent;
    const yes = screen.getByRole('button', { name: 'Deactivate Ana Ruiz' });
    await user.click(yes);
    expect(screen.getByRole('group')).toBe(question);
    expect(question.textContent).toBe(before);
    expect(question).not.toHaveAttribute('aria-busy');
    expect(yes).not.toHaveAttribute('aria-disabled');
    expect(yes).toHaveFocus();
    await user.click(yes);
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('[NFR-005] gives focus back to the button even when it is now unavailable', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    // The caller marks the action busy while it runs, and the person is deactivated after it.
    function Person() {
      const [busy, setBusy] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <I18nProvider locale="en">
          <DangerAction
            label="Deactivate"
            outcome="Ana Ruiz can no longer sign in."
            confirmLabel="Deactivate Ana Ruiz"
            busy={busy}
            disabled={gone}
            onConfirm={async () => {
              setBusy(true);
              await Promise.resolve();
              onConfirm();
              setGone(true);
            }}
          />
          <button type="button">Next</button>
        </I18nProvider>
      );
    }
    render(<Person />);
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Deactivate Ana Ruiz' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    const button = screen.getByRole('button', { name: 'Deactivate' });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Unavailable: a press opens nothing, and once focus moves on it is disabled outright.
    await user.click(button);
    expect(screen.queryByRole('group')).toBeNull();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    expect(button).toBeDisabled();
  });
  it('[NFR-005] names its button for the row it acts on, when a list repeats it', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <DangerAction
          label="Revoke"
          name="Revoke Sync job of River Stone"
          outcome="Programs using Sync job stop working at once."
          confirmLabel="Revoke Sync job of River Stone"
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    );
    const button = screen.getByRole('button', { name: 'Revoke Sync job of River Stone' });
    expect(button).toHaveTextContent(/^Revoke$/);
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Revoke Sync job of River Stone' })).toHaveFocus();
  });
});
