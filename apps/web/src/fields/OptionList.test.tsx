import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Field } from './client';
import { defaultOptionIds } from './defaultValue';
import { type FakeFieldsClient, fakeFieldsClient } from './fixtures';
import { OptionList } from './OptionList';

function Harness({ start, client }: { start: Field; client: FakeFieldsClient }) {
  const [field, setField] = useState(start);
  const [said, setSaid] = useState('');
  const context = field.contexts[0];
  if (!context) return null;
  return (
    <main>
      <OptionList
        field={field}
        context={context}
        client={client}
        onField={setField}
        onChanged={setSaid}
        onProblem={() => setSaid('refused')}
        defaultIds={defaultOptionIds(context.defaultValue)}
      />
      <p role="status">{said}</p>
    </main>
  );
}

async function renderField(id: number) {
  const client = fakeFieldsClient();
  const field = await client.field(id);
  render(
    <I18nProvider locale="en">
      <Harness start={field} client={client} />
    </I18nProvider>,
  );
  return client;
}

const values = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list)
    .map((item) => item.firstElementChild?.firstChild?.textContent);

describe('options and their order (T-320)', () => {
  it('[CORE-009] moves options up and down, sending every option at that level', async () => {
    const user = userEvent.setup();
    const client = await renderField(2);
    const list = screen.getAllByRole('list')[0] as HTMLElement;
    expect(values(list)).toEqual(['Low', 'Medium', 'Critical']);
    // The first cannot go up, the last cannot go down.
    expect(screen.getByRole('button', { name: 'Move Low up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Critical down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Medium up' }));
    expect(await screen.findByText('Medium was moved.')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'orderOptions',
      args: [2, 20, null, [202, 201, 203]],
    });
    expect(values(list)).toEqual(['Medium', 'Low', 'Critical']);
    // At the top it cannot go up again: the keyboard moves to its Down.
    expect(screen.getByRole('button', { name: 'Move Medium down' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Move Low down' }));
    expect(values(list)).toEqual(['Medium', 'Critical', 'Low']);
    expect(screen.getByRole('button', { name: 'Move Low up' })).toHaveFocus();
  });

  it('[CORE-009] keeps a two-level list’s child options under each option', async () => {
    const user = userEvent.setup();
    const client = await renderField(5);
    const europe = screen.getByRole('list', { name: 'Child options of Europe' });
    expect(values(europe)).toEqual(['Madrid', 'Lisbon']);
    expect(screen.getByText('Americas has no child options yet.')).toBeVisible();

    const add = screen.getByRole('form', { name: 'Add a child option to Americas' });
    await user.type(within(add).getByLabelText('New child option'), 'Lima');
    await user.click(within(add).getByRole('button', { name: 'Add the child option' }));
    expect(await screen.findByText('Lima was added under Americas.')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({ action: 'addOption', args: [5, 50, 'Lima', 502] });
    expect(within(add).getByLabelText('New child option')).toHaveValue('');
    expect(values(screen.getByRole('list', { name: 'Child options of Americas' }))).toEqual([
      'Lima',
    ]);

    await user.click(screen.getByRole('button', { name: 'Move Lisbon up' }));
    expect(client.calls.at(-1)).toEqual({
      action: 'orderOptions',
      args: [5, 50, 501, [512, 511]],
    });
    await user.click(screen.getByRole('button', { name: 'Rename Madrid' }));
    const input = screen.getByLabelText('New name for Madrid');
    await user.clear(input);
    await user.type(input, 'Barcelona');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The option is called Barcelona now.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Stop offering Barcelona' }));
    expect(await screen.findByText('Barcelona is no longer offered.')).toBeVisible();
    // A plain child option goes at once (D13, T-267).
    await user.click(screen.getByRole('button', { name: 'Delete Lisbon' }));
    expect(await screen.findByText('Lisbon was deleted.')).toBeVisible();
    expect(values(europe)).toEqual(['Barcelona']);
  });

  it('[CORE-009] asks before deleting an option with child options, deletes a plain one at once, and keeps the keyboard', async () => {
    const user = userEvent.setup();
    const client = await renderField(5);
    // An option with child options: the first press only asks, with the danger look; Cancel
    // sends nothing (D13, T-267).
    const first = screen.getByRole('button', { name: 'Delete Europe' });
    expect(first).toHaveClass('button-danger-quiet');
    await user.click(first);
    const question = screen.getByRole('group', {
      name: /^Delete Europe and its 2 child options\? They leave this list for good/,
    });
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete Europe' })).toHaveFocus();
    expect(client.calls).toEqual([]);

    // A plain child option asks nothing.
    const madrid = screen.getByRole('button', { name: 'Delete Madrid' });
    expect(madrid).toHaveClass('button-secondary');
    await user.click(madrid);
    expect(screen.queryByRole('group', { name: /^Delete Madrid/ })).toBeNull();
    expect(await screen.findByText('Madrid was deleted.')).toBeVisible();
    expect(client.calls).toEqual([{ action: 'deleteOption', args: [5, 50, 511] }]);
    // Its row is gone, so the list's heading takes the keyboard, not the page.
    expect(screen.getByRole('heading', { name: 'Options in Everywhere' })).toHaveFocus();
  });

  it('[CORE-009] asks before deleting the option or child option a default names', async () => {
    const user = userEvent.setup();
    const client = await renderField(4);
    // Office's default is Madrid, Floor 1: both are marked, and deleting either asks.
    await user.click(screen.getByRole('button', { name: 'Delete Floor 1' }));
    const question = screen.getByRole('group', {
      name:
        'Delete Floor 1? It leaves this list for good. New tickets in Everywhere start with ' +
        'Floor 1: once it goes they start empty until a default is saved again. An option a ' +
        'ticket holds is not deleted: stop offering it instead. This cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete Floor 1' }));
    expect(await screen.findByText('Floor 1 was deleted.')).toBeVisible();
    expect(client.calls).toEqual([{ action: 'deleteOption', args: [4, 40, 4011] }]);
    // The default went with it, so Madrid, with one child option left, asks only for that.
    expect(screen.queryByText('Default')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete Madrid' }));
    expect(
      screen.getByRole('group', {
        name:
          'Delete Madrid and its child option? They leave this list for good. Options a ticket ' +
          'holds are not deleted: stop offering them instead. This cannot be undone.',
      }),
    ).toBeVisible();
  });
});
