import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { ChecklistsPanel, droppedOrder } from './ChecklistsPanel';
import type { Checklist } from './client';
import { fakeToolsClient, STARTING_CHECKLISTS } from './fixtures';

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
  it('[CORE-033] names every button starting with the word it shows, in English and Spanish (PL-24)', async () => {
    for (const locale of ['en', 'es'] as const) {
      const { container } = renderPanel(fakeToolsClient(), locale);
      await screen.findAllByRole('checkbox');
      const buttons = [...container.querySelectorAll('button[aria-label]')];
      expect(buttons.length).toBeGreaterThan(0);
      const mismatched = buttons.flatMap((button) => {
        const shown = (button.textContent ?? '').trim().toLowerCase();
        const name = (button.getAttribute('aria-label') ?? '').toLowerCase();
        return shown && !name.startsWith(shown) ? [`${shown} / ${name}`] : [];
      });
      expect(mismatched).toEqual([]);
      container.remove();
    }
  });

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
    const down = await screen.findByRole('button', { name: 'Move down Write the notes' });
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
    expect(screen.queryByRole('button', { name: 'Move up Tag the build' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move down Print it' })).toBeNull();
  });

  it('[CORE-033] keeps the focus with an item moved to the first or the last place', async () => {
    const user = userEvent.setup();
    renderPanel();
    (await screen.findByRole('button', { name: 'Move up Tag the build' })).focus();
    await user.keyboard('{Enter}');
    // First now: it can only go back down, and that is where the focus is.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move down Tag the build' })).toHaveFocus(),
    );
    expect(screen.queryByRole('button', { name: 'Move up Tag the build' })).toBeNull();
    screen.getByRole('button', { name: 'Move down Tell the people' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move up Tell the people' })).toHaveFocus(),
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      'Tag the build',
      'Write the notes',
      'Run the upgrade',
      'Print it',
      'Tell the people',
    ]);
  });

  it('[CORE-033] keeps the focus with a checklist that moved, by keyboard', async () => {
    const user = userEvent.setup();
    const afterwards = {
      id: 31,
      name: 'Afterwards',
      items: [],
      progress: { done: 0, counted: 0, percent: null },
    };
    renderPanel(fakeToolsClient({ checklists: [...STARTING_CHECKLISTS, afterwards] }));
    const titles = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    (await screen.findByRole('button', { name: 'Move down the checklist Before release' })).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(titles()).toEqual(['Afterwards', 'Before release']));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move up the checklist Before release' }),
      ).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    await waitFor(() => expect(titles()).toEqual(['Before release', 'Afterwards']));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Move down the checklist Before release' }),
      ).toHaveFocus(),
    );
  });

  it('[CORE-033] gives the focus back to what opened a form, saved or left with Escape', async () => {
    const user = userEvent.setup();
    renderPanel();
    // Renaming a checklist.
    await user.click(await screen.findByRole('button', { name: 'Edit checklist Before release' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit checklist Before release' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Edit checklist Before release' }));
    await user.clear(screen.getByRole('textbox', { name: 'Checklist name' }));
    await user.keyboard('Shipping{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit checklist Shipping' })).toHaveFocus(),
    );
    // Editing an item.
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit Print it' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    await user.clear(screen.getByRole('textbox', { name: 'Item' }));
    await user.keyboard('Post it{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Post it' })).toHaveFocus());
    // A new checklist.
    await user.click(screen.getByRole('button', { name: 'Add a checklist' }));
    await user.keyboard('Afterwards{Enter}');
    await screen.findByRole('region', { name: 'Afterwards' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add a checklist' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Add a checklist' }));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add a checklist' })).toHaveFocus(),
    );
  });

  it('[CORE-033] keeps the focus in the panel when a checklist goes while a new one is named', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a checklist' }));
    await user.click(screen.getByRole('button', { name: 'Remove the checklist Before release' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Removing Before release/ })).getByRole('button', {
        name: 'Remove the checklist Before release',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Before release' })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Checklist name' })).toHaveFocus(),
    );
  });

  it('[CORE-033] keeps a tick shown while an earlier answer is set aside for a later one', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient({
      checklists: [
        {
          id: 30,
          name: 'Before release',
          items: [
            { id: 300, text: 'Print it', state: 'open' },
            { id: 301, text: 'Tell the people', state: 'open' },
          ],
          progress: { done: 0, counted: 2, percent: 0 },
        },
      ],
    });
    // The server answers when the test says so, each answer as of its own write.
    const update = client.updateItem;
    const answers: (() => void)[] = [];
    client.updateItem = (...args) =>
      new Promise((resolve, reject) => {
        answers.push(() => void update(...args).then(resolve, reject));
      });
    renderPanel(client);
    const print = await screen.findByRole('checkbox', { name: 'Print it' });
    const tell = screen.getByRole('checkbox', { name: 'Tell the people' });
    await user.click(print);
    await user.click(tell);
    expect(print).toBeChecked();
    expect(tell).toBeChecked();
    // The first answer knows nothing of the second tick, so it is set aside: both stay ticked.
    await act(async () => {
      answers[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(print).toBeChecked();
    expect(tell).toBeChecked();
    await act(async () => {
      answers[1]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText('2 of 2 done (100%)')).toBeVisible();
    expect(print).toBeChecked();
    expect(tell).toBeChecked();
  });

  it('[CORE-033] holds a checklist name to 200 characters and an item to 1,000, as the server does', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a checklist' }));
    const name = screen.getByRole('textbox', { name: 'Checklist name' });
    expect(name).toHaveAttribute('maxlength', '200');
    await user.paste('x'.repeat(250));
    expect(name).toHaveValue('x'.repeat(200));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit checklist Before release' }));
    expect(screen.getByRole('textbox', { name: 'Checklist name' })).toHaveAttribute(
      'maxlength',
      '200',
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    expect(screen.getByRole('textbox', { name: 'Item' })).toHaveAttribute('maxlength', '1000');
    expect(screen.getByRole('textbox', { name: 'Add an item to Before release' })).toHaveAttribute(
      'maxlength',
      '1000',
    );
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

  it('[CORE-033] keeps an item in progress half-ticked after its text is edited or left', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'State of Print it' }), [
      'In progress',
    ]);
    const box = () => screen.getByRole('checkbox', { name: 'Print it' }) as HTMLInputElement;
    await waitFor(() => expect(box().indeterminate).toBe(true));
    await waitFor(() => expect(stateOf('Print it')).toBeEnabled());
    // Left with Escape: the box is drawn again, still neither ticked nor empty.
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    await user.keyboard('{Escape}');
    expect(box().indeterminate).toBe(true);
    // Saved with new words: the same.
    await user.click(screen.getByRole('button', { name: 'Edit Print it' }));
    await user.clear(screen.getByRole('textbox', { name: 'Item' }));
    await user.keyboard('Print it twice{Enter}');
    const renamed = await screen.findByRole('checkbox', { name: 'Print it twice' });
    expect((renamed as HTMLInputElement).indeterminate).toBe(true);
    expect(renamed).not.toBeChecked();
  });

  it('[CORE-033] removes an item at once, and a checklist with items after saying what goes (D13)', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    // An item comes back by typing it again: no question (T-267).
    const item = await screen.findByRole('button', { name: 'Remove Print it' });
    expect(item).toHaveClass('button-secondary');
    await user.click(item);
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Print it' })).toBeNull());
    // The list takes its items and their states, and history keeps only its name: it asks.
    const trigger = screen.getByRole('button', { name: 'Remove the checklist Before release' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    const question = screen.getByRole('group', {
      name: 'Removing Before release deletes its 4 items and the state of each: 3 were done. History keeps only the checklist’s name, so this cannot be undone.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(client.calls.some((c) => c.action === 'removeChecklist')).toBe(false);
    await user.click(
      within(question).getByRole('button', { name: 'Remove the checklist Before release' }),
    );
    expect(await screen.findByText('No checklists yet.')).toBeVisible();
  });

  it('[CORE-033] removes an empty checklist at once, and keeps the question when refused', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    renderPanel(client);
    await user.click(await screen.findByRole('button', { name: 'Add a checklist' }));
    await user.keyboard('Afterwards{Enter}');
    await screen.findByRole('region', { name: 'Afterwards' });
    // An empty list loses only a name.
    const empty = screen.getByRole('button', { name: 'Remove the checklist Afterwards' });
    expect(empty).toHaveClass('button-secondary');
    await user.click(empty);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Afterwards' })).toBeNull());

    client.removeChecklist = async () => {
      throw new ApiError(409, { error: 'order_changed' });
    };
    await user.click(screen.getByRole('button', { name: 'Remove the checklist Before release' }));
    const question = screen.getByRole('group', { name: /^Removing Before release/ });
    await user.click(
      within(question).getByRole('button', { name: 'Remove the checklist Before release' }),
    );
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(within(question).getByRole('button', { name: 'Cancel' })).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Move up the checklist Afterwards' }));
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

describe('dragging a checklist item with a pointer (CORE-033; ADR-120, TT-5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = (text: string) =>
    screen.getByRole('checkbox', { name: text }).closest('li') as HTMLElement;
  const grip = (text: string) => row(text).querySelector('.checklist-grip') as HTMLElement;

  /**
   * A drag as a mouse or a finger makes it: down on the grip, moves, up over the target, on its
   * upper or lower half. jsdom lays nothing out, so the target is what is under the pointer and
   * it says where its halves are.
   */
  function dragTo(
    from: HTMLElement,
    to: HTMLElement,
    half: 'upper' | 'lower',
    pointerType: 'mouse' | 'touch' = 'mouse',
  ) {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(to);
    vi.spyOn(to, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 40));
    const y = half === 'upper' ? 110 : 130;
    const point = { pointerId: 3, pointerType, isPrimary: true };
    fireEvent.pointerDown(from, { ...point, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { ...point, clientX: 12, clientY: 60 });
    fireEvent.pointerMove(window, { ...point, clientX: 12, clientY: y });
    return () => fireEvent.pointerUp(window, { ...point, clientX: 12, clientY: y });
  }

  it('[CORE-033] puts an item before or after the one it is dropped on', () => {
    const ids = [1, 2, 3, 4];
    expect(droppedOrder(ids, 1, 3, false)).toEqual([2, 1, 3, 4]);
    expect(droppedOrder(ids, 1, 3, true)).toEqual([2, 3, 1, 4]);
    expect(droppedOrder(ids, 4, 1, false)).toEqual([4, 1, 2, 3]);
    expect(droppedOrder(ids, 2, 4, true)).toEqual([1, 3, 4, 2]);
    // Where it already is, on itself, or onto something not in the list: nothing changes.
    expect(droppedOrder(ids, 2, 3, false)).toBeNull();
    expect(droppedOrder(ids, 2, 1, true)).toBeNull();
    expect(droppedOrder(ids, 2, 2, true)).toBeNull();
    expect(droppedOrder(ids, 2, 9, true)).toBeNull();
  });

  it('[CORE-033] moves an item dragged with a mouse, showing where it would land', async () => {
    const { client } = renderPanel();
    await screen.findByRole('checkbox', { name: 'Write the notes' });
    const drop = dragTo(grip('Write the notes'), row('Tell the people'), 'lower');
    expect(row('Write the notes')).toHaveAttribute('data-dragged', 'true');
    expect(row('Tell the people')).toHaveAttribute('data-landing', 'after');
    drop();
    expect(row('Write the notes')).not.toHaveAttribute('data-dragged');
    await waitFor(() =>
      expect(client.calls).toContainEqual({
        action: 'orderItems',
        args: [41, 30, [301, 302, 303, 300, 304]],
      }),
    );
    expect(await screen.findByText('Moved: Write the notes')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => box.labels?.[0]?.textContent)).toEqual([
      'Tag the build',
      'Run the upgrade',
      'Tell the people',
      'Write the notes',
      'Print it',
    ]);
  });

  it('[CORE-033] moves an item dragged with a finger, before the one it is dropped on', async () => {
    const { client } = renderPanel();
    await screen.findByRole('checkbox', { name: 'Print it' });
    dragTo(grip('Print it'), row('Tag the build'), 'upper', 'touch')();
    await waitFor(() =>
      expect(client.calls).toContainEqual({
        action: 'orderItems',
        args: [41, 30, [300, 304, 301, 302, 303]],
      }),
    );
  });

  it('[CORE-033] a press without moving, Escape, or a drop where it already is moves nothing', async () => {
    const { client } = renderPanel();
    await screen.findByRole('checkbox', { name: 'Write the notes' });
    const point = { pointerId: 3, pointerType: 'mouse', isPrimary: true };
    fireEvent.pointerDown(grip('Tag the build'), { ...point, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { ...point, clientX: 6, clientY: 6 });
    const drop = dragTo(grip('Tag the build'), row('Tell the people'), 'upper');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(row('Tell the people')).not.toHaveAttribute('data-landing');
    drop();
    dragTo(grip('Tag the build'), row('Run the upgrade'), 'upper')();
    expect(row('Run the upgrade')).not.toHaveAttribute('data-landing');
    await act(async () => {});
    expect(client.calls.filter((call) => call.action === 'orderItems')).toEqual([]);
  });

  it('[CORE-033] keeps the grip for pointers: the keyboard has Move up and Move down', async () => {
    renderPanel();
    await screen.findByRole('checkbox', { name: 'Write the notes' });
    const handle = grip('Tag the build');
    expect(handle).toHaveAttribute('aria-hidden', 'true');
    expect(handle).not.toHaveAttribute('tabindex');
    expect(
      within(row('Tag the build')).getByRole('button', { name: 'Move up Tag the build' }),
    ).toBeVisible();
  });

  it('[CORE-033] has no grip where nothing can move: one item, or a reader', async () => {
    const first = STARTING_CHECKLISTS[0] as Checklist;
    const one = fakeToolsClient({ checklists: [{ ...first, items: first.items.slice(0, 1) }] });
    const { container, unmount } = render(
      <I18nProvider locale="en">
        <ChecklistsPanel ticket={TICKET} client={one} revision={0} />
      </I18nProvider>,
    );
    await screen.findByRole('checkbox', { name: 'Write the notes' });
    expect(container.querySelector('.checklist-grip')).toBeNull();
    unmount();
    const reader = renderPanel(fakeToolsClient({ canEdit: false }));
    await screen.findByRole('checkbox', { name: 'Write the notes' });
    expect(reader.container.querySelector('.checklist-grip')).toBeNull();
  });
});
