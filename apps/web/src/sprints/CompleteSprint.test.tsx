import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { CompleteSprintDialog, type SprintCounts } from './CompleteSprint';
import type { CompleteTarget, Sprint } from './client';

const sprint = (id: number, name: string, state: Sprint['state']): Sprint => ({
  id,
  boardId: 7,
  name,
  goal: '',
  state,
  sequence: id,
  startAt: null,
  endAt: null,
  startedAt: null,
  completedAt: null,
  version: 1,
});
const ACTIVE = sprint(11, 'Checkout Sprint 1', 'active');
const PLANNED = sprint(12, 'Checkout Sprint 2', 'future');

function open(
  counts: SprintCounts | null,
  complete: (id: number, to: CompleteTarget) => Promise<void> = async () => {},
  locale: Locale = 'en',
) {
  const calls: [number, CompleteTarget][] = [];
  const onCompleted = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <button type="button">Opener</button>
      <CompleteSprintDialog
        sprint={ACTIVE}
        futures={[PLANNED]}
        counts={counts}
        client={{
          complete: async (id, to) => {
            calls.push([id, to]);
            await complete(id, to);
          },
        }}
        onCompleted={onCompleted}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  const dialog = within(screen.getByRole('dialog', { name: /Checkout Sprint 1/ }));
  return { calls, onCompleted, onClose, dialog };
}

describe('the pop-up that completes a sprint (T-106)', () => {
  it('[AGL-010] says how many tickets are done and open and offers where the open ones go', async () => {
    const user = userEvent.setup();
    const { dialog, calls, onCompleted } = open({ done: 3, open: 2 });
    expect(dialog.getByRole('heading', { name: 'Complete Checkout Sprint 1?' })).toBeVisible();
    expect(dialog.getByText('3 tickets are done and 2 are open.')).toBeVisible();
    const where = dialog.getByRole('combobox', { name: 'Open tickets go to' });
    expect(
      within(where)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Backlog', 'Checkout Sprint 2', 'A new sprint']);
    await user.selectOptions(where, 'Checkout Sprint 2');
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(calls).toEqual([[11, { type: 'sprint', sprintId: 12 }]]);
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it('[AGL-010] sends open tickets to the backlog unless told otherwise, or to a new sprint', async () => {
    const user = userEvent.setup();
    const { dialog, calls } = open({ done: 0, open: 1 });
    expect(dialog.getByText('No tickets are done and 1 is open.')).toBeVisible();
    expect(dialog.getByRole('combobox', { name: 'Open tickets go to' })).toHaveValue('backlog');
    await user.selectOptions(dialog.getByRole('combobox'), 'A new sprint');
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(calls).toEqual([[11, { type: 'new' }]]);
  });

  it('[AGL-010] asks nothing about open tickets when every ticket is done', async () => {
    const user = userEvent.setup();
    const { dialog, calls } = open({ done: 4, open: 0 });
    expect(dialog.getByText('All 4 tickets are done, so nothing moves.')).toBeVisible();
    expect(dialog.queryByRole('combobox')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(calls).toEqual([[11, { type: 'backlog' }]]);
  });

  it('[AGL-010] still asks where open tickets go when the board could not count them', () => {
    const { dialog } = open(null);
    expect(dialog.getByText(/could not be counted/)).toBeVisible();
    expect(dialog.getByRole('combobox', { name: 'Open tickets go to' })).toBeVisible();
  });

  it('[AGL-010] Escape and Cancel close it without completing', async () => {
    const user = userEvent.setup();
    const { dialog, calls, onClose } = open({ done: 1, open: 1 });
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it('[AGL-010] keeps Tab inside, from the choice to Complete and Cancel', async () => {
    const user = userEvent.setup();
    const { dialog } = open({ done: 1, open: 1 });
    await user.tab();
    expect(dialog.getByRole('combobox')).toHaveFocus();
    await user.tab();
    expect(dialog.getByRole('button', { name: 'Complete sprint' })).toHaveFocus();
    await user.tab();
    expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(dialog.getByRole('combobox')).toHaveFocus();
  });

  it.each<[string, () => Error, string]>([
    [
      'no permission',
      () => new ApiError(403, { error: 'forbidden', permission: 'manage_sprints' }),
      'Only people who manage this board’s sprints can complete them.',
    ],
    [
      'completed elsewhere',
      () => new ApiError(409, { error: 'sprint_not_active' }),
      'This sprint is no longer active: someone may have completed it already.',
    ],
    [
      'a planned sprint gone',
      () =>
        new ApiError(400, { error: 'invalid_fields', fields: { 'moveTo.sprintId': 'not_found' } }),
      'The sprint you chose for the open tickets is no longer planned. Choose another place.',
    ],
    [
      'the sprint gone',
      () => new ApiError(404, { error: 'not_found' }),
      'This sprint or its board is no longer there.',
    ],
    ['no answer', () => new Error('offline'), 'The sprint could not be completed.'],
  ])('[AGL-010] says in plain words why it was refused: %s', async (_case, refusal, words) => {
    const user = userEvent.setup();
    const { dialog, onCompleted } = open({ done: 1, open: 1 }, async () => {
      throw refusal();
    });
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(words);
    expect(dialog.getByRole('button', { name: 'Complete sprint' })).toBeEnabled();
    expect(dialog.getByRole('button', { name: 'Complete sprint' })).toHaveFocus();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('[AGL-010] does not close while the completion is on its way', async () => {
    const user = userEvent.setup();
    let finish = () => {};
    const { dialog, onClose, onCompleted } = open(
      { done: 1, open: 1 },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(dialog.getByRole('button', { name: 'Complete sprint' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
  });

  it('[AGL-010] reads in Spanish', () => {
    const { dialog } = open({ done: 1, open: 2 }, async () => {}, 'es');
    expect(dialog.getByRole('heading', { name: '¿Completar Checkout Sprint 1?' })).toBeVisible();
    expect(dialog.getByText('1 ticket está terminado y 2 están abiertos.')).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeVisible();
  });
});
