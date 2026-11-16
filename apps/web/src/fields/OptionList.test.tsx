import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Field } from './client';
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
    await user.click(screen.getByRole('button', { name: 'Delete Lisbon' }));
    const question = screen.getByRole('group', { name: /^Delete Lisbon\? It leaves this list/ });
    await user.click(within(question).getByRole('button', { name: 'Delete Lisbon' }));
    expect(await screen.findByText('Lisbon was deleted.')).toBeVisible();
    expect(values(europe)).toEqual(['Barcelona']);
  });

  it('[CORE-009] asks before deleting an option, naming its child options, and keeps the keyboard', async () => {
    const user = userEvent.setup();
    const client = await renderField(5);
    // The first press only asks, with the danger look; Cancel sends nothing (D13).
    const first = screen.getByRole('button', { name: 'Delete Europe' });
    expect(first).toHaveClass('button-danger-quiet');
    await user.click(first);
    const question = screen.getByRole('group', {
      name: /^Delete Europe and its 2 child options\? They leave this list for good/,
    });
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete Europe' })).toHaveFocus();
    expect(client.calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete Madrid' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Delete Madrid\?/ })).getByRole('button', {
        name: 'Delete Madrid',
      }),
    );
    expect(await screen.findByText('Madrid was deleted.')).toBeVisible();
    expect(client.calls).toEqual([{ action: 'deleteOption', args: [5, 50, 511] }]);
    // Its row is gone, so the list's heading takes the keyboard, not the page.
    expect(screen.getByRole('heading', { name: 'Options in Everywhere' })).toHaveFocus();
  });
});
