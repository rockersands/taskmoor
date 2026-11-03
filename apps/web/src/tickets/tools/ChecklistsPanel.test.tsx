import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { ChecklistsPanel } from './ChecklistsPanel';
import { fakeToolsClient } from './fixtures';

const TICKET = { id: 41 };

function renderPanel(client = fakeToolsClient(), locale: Locale = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <ChecklistsPanel ticket={TICKET} client={client} revision={0} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

const stateOf = (text: string) => screen.getByRole('combobox', { name: `State of ${text}` });

describe('ChecklistsPanel', () => {
  it('[CORE-033] (1) shows 75% for 3 done, 1 open and 1 rejected', async () => {
    renderPanel();
    const panel = await screen.findByRole('region', { name: 'Checklists' });
    const list = within(panel).getByRole('region', { name: 'Before release' });
    expect(within(list).getByText('3 of 4 done (75%)')).toBeVisible();
    expect(within(list).getByRole('progressbar', { name: '3 of 4 done (75%)' })).toHaveAttribute(
      'aria-valuenow',
      '75',
    );
  });

  it('[CORE-033] makes an item done with its box, and open again', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const box = await screen.findByRole('checkbox', { name: 'Tell the people' });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(client.calls).toContainEqual({
      action: 'updateItem',
      args: [41, 30, 303, { state: 'done' }],
    });
    expect(screen.getByText('4 of 4 done (100%)')).toBeVisible();
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(stateOf('Tell the people')).toHaveValue('open');
  });

  it('[CORE-033] has only the four states, and a rejected item stops counting', async () => {
    const user = userEvent.setup();
    renderPanel();
    const select = (await screen.findByRole('combobox', {
      name: 'State of Tell the people',
    })) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Open',
      'In progress',
      'Done',
      'Rejected',
    ]);
    await user.selectOptions(select, 'Rejected');
    expect(await screen.findByText('3 of 3 done (100%)')).toBeVisible();
    await waitFor(() => expect(stateOf('Tell the people')).toBeEnabled());
    await user.selectOptions(stateOf('Tell the people'), 'In progress');
    expect(await screen.findByText('3 of 4 done (75%)')).toBeVisible();
    expect(
      (screen.getByRole('checkbox', { name: 'Tell the people' }) as HTMLInputElement).indeterminate,
    ).toBe(true);
  });

  it('[CORE-033] adds an item and stays in the field, by keyboard', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const field = await screen.findByRole('textbox', { name: 'Add an item to Before release' });
    await user.type(field, 'Ring the bell{Enter}');
    expect(await screen.findByRole('checkbox', { name: 'Ring the bell' })).toBeVisible();
    expect(client.calls).toContainEqual({
      action: 'addItem',
      args: [41, 30, 'Ring the bell'],
    });
    expect(field).toHaveValue('');
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('[CORE-033] reorders by keyboard, with the focus on the button that moved', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const down = await screen.findByRole('button', { name: 'Move Write the notes down' });
    down.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(client.calls).toContainEqual({
        action: 'orderItems',
        args: [41, 30, [301, 300, 302, 303, 304]],
      }),
    );
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      'Tag the build',
      'Write the notes',
      'Run the upgrade',
      'Tell the people',
      'Print it',
    ]);
    await waitFor(() => expect(down).toHaveFocus());
    // The first and last cannot go further.
    expect(screen.queryByRole('button', { name: 'Move Tag the build up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Print it down' })).toBeNull();
  });

  it('[CORE-033] edits an item, and Escape leaves it as it was', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit Print it' }));
    const field = screen.getByRole('textbox', { name: 'Item' });
    await user.keyboard('{Escape}');
    expect(field).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    await user.clear(screen.getByRole('textbox', { name: 'Item' }));
    await user.keyboard('Post it{Enter}');
    expect(await screen.findByRole('checkbox', { name: 'Post it' })).toBeVisible();
  });

  it('[CORE-033] removes an item and a checklist', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Remove Print it' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Print it' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Remove the checklist Before release' }));
    expect(await screen.findByText('No checklists yet.')).toBeVisible();
  });

  it('[CORE-033] holds several named lists, with overall progress and an order', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a checklist' }));
    await user.keyboard('Afterwards{Enter}');
    const second = await screen.findByRole('region', { name: 'Afterwards' });
    await user.type(
      within(second).getByRole('textbox', { name: 'Add an item to Afterwards' }),
      'Tidy up{Enter}',
    );
    expect(await screen.findByText('All checklists')).toBeVisible();
    expect(await screen.findByText('3 of 5 done (60%)')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move the checklist Afterwards up' }));
    await waitFor(() =>
      expect(client.calls.some((c) => c.action === 'orderChecklists')).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
        'Afterwards',
        'Before release',
      ]),
    );
  });

  it('[CORE-033] (2) only reads, for someone who may not edit, with the state in words', async () => {
    renderPanel(fakeToolsClient({ canEdit: false }));
    const box = await screen.findByRole('checkbox', { name: 'Print it' });
    expect(box).toBeDisabled();
    expect(screen.getByText('Rejected')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add a checklist' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('[CORE-033] leaves no section for someone who may not edit a ticket with none', async () => {
    const { container } = renderPanel(fakeToolsClient({ canEdit: false, checklists: [] }));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('[CORE-033] says so when the server refuses, and reads again', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    client.addItem = async () => {
      throw new ApiError(409, { error: 'too_many' });
    };
    renderPanel(client);
    await user.type(
      await screen.findByRole('textbox', { name: 'Add an item to Before release' }),
      'One more{Enter}',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/20 checklists/);
    expect(screen.getByRole('textbox', { name: 'Add an item to Before release' })).toHaveValue(
      'One more',
    );
  });

  it('[CORE-033] works on a phone', async () => {
    setViewportWidth(360);
    renderPanel();
    expect(await screen.findByRole('checkbox', { name: 'Print it' })).toBeVisible();
  });

  it('[NFR-006] comes from the catalogue, in the pseudo-locale too', async () => {
    const { errors, container } = renderPanel(undefined, 'en-XA');
    await screen.findByRole('progressbar');
    expect(errors).toEqual([]);
    const texts = visibleTexts(container).filter(
      (text) => !/Before release|Write the|Tag the|Run the|Tell the|Print it/.test(text),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
