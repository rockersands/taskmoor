import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import type { SearchClient } from '../../search/client';
import { ResultTable } from '../../search/ResultTable';
import { TypeGlyph } from '../../shell/TicketIcons';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import type { Transition } from '../view/client';
import { childTransitions, fakeToolsClient, STARTING_CHILDREN } from './fixtures';
import { percentOf, SubticketProgressMini } from './Progress';
import { SubticketsPanel } from './SubticketsPanel';

const ticket = (rank: number) => ({
  id: 41,
  key: 'SHOP-41',
  track: { key: 'SHOP' },
  ticketType: { level: { rank } },
});

function renderPanel(client = fakeToolsClient(), rank = 0, locale: Locale = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SubticketsPanel ticket={ticket(rank)} client={client} revision={0} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('the percentage (CORE-032)', () => {
  it('[CORE-032] rounds to a whole percent, and nothing to count reads 0', () => {
    expect(percentOf(1, 2)).toBe(50);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe('SubticketsPanel', () => {
  it('[CORE-032] lists them with their status and the progress in numbers', async () => {
    renderPanel();
    const panel = await screen.findByRole('region', { name: 'Subtickets' });
    expect(await within(panel).findByRole('link', { name: 'SHOP-201' })).toBeVisible();
    expect(within(panel).getByText('Done')).toBeVisible();
    expect(within(panel).getByText('In progress')).toBeVisible();
    expect(await within(panel).findByText('1 of 2 closed (50%)')).toBeVisible();
    const bar = within(panel).getByRole('progressbar', { name: '1 of 2 closed (50%)' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('[CORE-032] adds one from a summary and stays, by keyboard', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const field = await screen.findByRole('textbox', { name: 'New subticket' });
    await user.type(field, 'Check the receipt{Enter}');
    await waitFor(() => expect(screen.getByText('Check the receipt')).toBeVisible());
    expect(client.calls).toContainEqual({
      action: 'createChild',
      args: [{ track: 'SHOP', parent: 'SHOP-41', ticketTypeId: 9, summary: 'Check the receipt' }],
    });
    expect(field).toHaveValue('');
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText('1 of 3 closed (33%)')).toBeVisible();
  });

  it('[CORE-032] says what the track also asks for when it refuses, by the fields’ names', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    const refusals: Record<string, string>[] = [
      { dueDate: 'required', 'fields.12': 'required' },
      { assigneeId: 'not_assignable' },
      { parent: 'wrong_level' },
      { parent: 'not_found' },
      { ticketTypeId: 'not_in_track' },
      { visibilityLevelId: 'not_in_track' },
      { 'fields.12.0': 'invalid' },
    ];
    client.createChild = async () => {
      throw new ApiError(400, { error: 'invalid_fields', fields: refusals.shift() });
    };
    renderPanel(client);
    const field = await screen.findByRole('textbox', { name: 'New subticket' });
    await user.type(field, 'Needs more{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track also asks for: Due date, Customer. Use the create form for this one.',
    );
    expect(field).toHaveValue('Needs more');
    const refused = async (words: string) => {
      await user.type(field, '{Enter}');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(words));
    };
    // Not a field the track asks for: one it did not take.
    await refused('This track did not take the value of: Assignee. Use the create form');
    // Where it goes, and its type, are no field to fill in.
    await refused('A ticket of this type cannot go under this one.');
    await refused('This ticket is gone, or you can no longer see it.');
    await refused('This track no longer offers that ticket type. Reload the page');
    // Named by its control's label, as every refusal names it (T-292, T-299), not by its key.
    await refused('This track did not take the value of: Visibility level. Use the create form');
    // A field it cannot name: no key is shown.
    await refused('That did not work. Try again in a moment.');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/fields\.|Id\b/);
    // The names come from the type's create form, read once and not again for each refusal.
    expect(client.calls.filter((call) => call.action === 'childFields')).toEqual([
      { action: 'childFields', args: ['SHOP', 9] },
    ]);
  });

  it('[CORE-032] reads the names before the first refusal, once per type, and falls back to the number', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient({
      childTypes: [
        { id: 9, name: 'Subticket' },
        { id: 10, name: 'Sub-bug' },
      ],
    });
    let names = 0;
    const read = client.childFields?.bind(client);
    client.childFields = async (track, typeId) => {
      names++;
      if (typeId === 10) throw new ApiError(503, { error: 'unavailable' });
      return (await read?.(track, typeId)) ?? [];
    };
    client.createChild = async () => {
      throw new ApiError(400, { error: 'invalid_fields', fields: { 'fields.12': 'required' } });
    };
    renderPanel(client);
    const field = await screen.findByRole('textbox', { name: 'New subticket' });
    expect(names).toBe(0);
    await user.type(field, 'A');
    // Asked as the subticket is written, not when the server refuses it.
    await waitFor(() => expect(names).toBe(1));
    await user.type(field, '{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('also asks for: Customer.');
    await user.type(field, '{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Customer'));
    expect(names).toBe(1);
    // Another type's form could not be read: the field goes by its number, and is asked again.
    await user.click(screen.getByRole('combobox', { name: 'Ticket type' }));
    await user.click(screen.getByRole('option', { name: 'Sub-bug' }));
    await user.type(field, '{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('also asks for: field 12.'),
    );
    const before = names;
    await user.type(field, '{Enter}');
    await waitFor(() => expect(names).toBe(before + 1));
  });

  it('[CORE-032] names the fields in Spanish too', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    client.createChild = async () => {
      throw new ApiError(400, {
        error: 'invalid_fields',
        fields: { dueDate: 'required', 'fields.41': 'required' },
      });
    };
    renderPanel(client, 0, 'es');
    await user.type(
      await screen.findByRole('textbox', { name: 'Nuevo subticket' }),
      'Falta algo{Enter}',
    );
    // The seeded Points field in the person's language, as the create form names it.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este track también pide: Fecha límite, Puntos. Usa el formulario de creación para este.',
    );
  });

  it('[CORE-032] reads the next page once, however often Show more is pressed, and keeps the focus in the list', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    const asked: (string | undefined)[] = [];
    let answer = () => {};
    const later = {
      id: 203,
      key: 'SHOP-203',
      summary: 'Check the receipt',
      status: { name: 'To do', stage: 'new' as const },
    };
    client.children = (_key, cursor) => {
      asked.push(cursor);
      if (!cursor)
        return Promise.resolve({ tickets: structuredClone(STARTING_CHILDREN), next: 'p2' });
      return new Promise((resolve) => {
        answer = () => resolve({ tickets: [later], next: null });
      });
    };
    renderPanel(client);
    const more = await screen.findByRole('button', { name: 'Show more' });
    more.focus();
    await user.keyboard('{Enter}');
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(more).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.click(more);
    expect(asked).toEqual([undefined, 'p2']);
    await act(async () => answer());
    const link = await screen.findByRole('link', { name: 'SHOP-203' });
    expect(screen.getAllByRole('link', { name: 'SHOP-203' })).toHaveLength(1);
    // The last page: the button goes, and the focus is on the first ticket it brought.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('[CORE-032] asks which type, in the icon menu Create uses, when the track has several', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel(
      fakeToolsClient({
        childTypes: [
          { id: 9, name: 'Subticket' },
          { id: 10, name: 'Sub-bug' },
        ],
      }),
    );
    // The icon menu Create uses for the same choice, not a native select.
    const type = await screen.findByRole('combobox', { name: 'Ticket type' });
    expect(type.tagName).toBe('BUTTON');
    expect(type).toHaveTextContent('Subticket');
    await user.click(type);
    await user.click(screen.getByRole('option', { name: 'Sub-bug' }));
    await user.type(screen.getByRole('textbox', { name: 'New subticket' }), 'A{Enter}');
    await waitFor(() =>
      expect(client.calls).toContainEqual({
        action: 'createChild',
        args: [{ track: 'SHOP', parent: 'SHOP-41', ticketTypeId: 10, summary: 'A' }],
      }),
    );
  });

  it('[CORE-032] draws each type with the icon its administrator chose, as Create does', async () => {
    const user = userEvent.setup();
    renderPanel(
      fakeToolsClient({
        childTypes: [
          { id: 9, name: 'Subticket', icon: null },
          { id: 10, name: 'Sub-bug', icon: 'bug' },
        ],
      }),
    );
    await user.click(await screen.findByRole('combobox', { name: 'Ticket type' }));
    const drawn = (name: string) =>
      screen.getByRole('option', { name }).querySelector('svg')?.outerHTML;
    // The chosen icon, not the default glyph a name it does not know gets.
    const bug = render(<TypeGlyph name="Bug" />).container.querySelector('svg')?.outerHTML;
    const plain = render(<TypeGlyph name="Sub-bug" />).container.querySelector('svg')?.outerHTML;
    expect(bug).not.toBe(plain);
    expect(drawn('Sub-bug')).toBe(bug);
    // A type with no chosen icon keeps its name's own.
    expect(drawn('Subticket')).toBe(
      render(<TypeGlyph name="Subticket" />).container.querySelector('svg')?.outerHTML,
    );
  });

  it('[CORE-032] shows nothing on a subticket: it has none of its own', async () => {
    const { client, container } = renderPanel(fakeToolsClient(), -1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('section')).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('[CORE-032] names the section differently above the standard level', async () => {
    renderPanel(fakeToolsClient(), 1);
    expect(await screen.findByRole('region', { name: 'Tickets under this' })).toBeVisible();
  });

  it('[CORE-032] says when there are none, with no progress', async () => {
    renderPanel(fakeToolsClient({ children: [] }));
    expect(await screen.findByText('None yet.')).toBeVisible();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('[CORE-032] works on a phone', async () => {
    setViewportWidth(360);
    renderPanel();
    expect(await screen.findByRole('textbox', { name: 'New subticket' })).toBeVisible();
  });

  it('[NFR-006] comes from the catalogue, in the pseudo-locale too', async () => {
    const { errors, container } = renderPanel(undefined, 0, 'en-XA');
    await screen.findByRole('link', { name: 'SHOP-201' });
    await screen.findByRole('progressbar');
    expect(errors).toEqual([]);
    const texts = visibleTexts(container).filter(
      (text) => !/SHOP|retry|slow network|^Done$|In progress/i.test(text),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('moving a subticket from its parent’s list (CORE-032; ADR-120, TT-6)', () => {
  const statusOf = (key: string, status: string) =>
    screen.findByRole('button', { name: `Status of ${key}: ${status}` });

  it('[CORE-032] moves one by keyboard through its workflow, and the progress follows', async () => {
    const user = userEvent.setup();
    const changed: number[] = [];
    const client = fakeToolsClient();
    render(
      <I18nProvider locale="en">
        <SubticketsPanel
          ticket={ticket(0)}
          client={client}
          revision={0}
          onChanged={() => changed.push(1)}
        />
      </I18nProvider>,
    );
    const status = await statusOf('SHOP-202', 'In progress');
    expect(status).toHaveAttribute('aria-haspopup', 'menu');
    status.focus();
    await user.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu', { name: 'Status of SHOP-202: In progress' });
    // Where it can go from here, read as the menu opens; not where it already is.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['To do', 'Done']);
    expect(within(menu).getByRole('menuitem', { name: 'To do' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(client.calls).toContainEqual({ action: 'moveChild', args: [202, 13, {}] });
    expect(await screen.findByText('SHOP-202 is now Done.')).toBeInTheDocument();
    expect(await screen.findByText('2 of 2 closed (100%)')).toBeVisible();
    const moved = await statusOf('SHOP-202', 'Done');
    await waitFor(() => expect(moved).toHaveFocus());
    expect(changed).toEqual([1]);
  });

  it('[CORE-032] asks for a close reason when the move needs one, and Cancel goes back', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient({ transitions: childTransitions(true) });
    renderPanel(client);
    await user.click(await statusOf('SHOP-202', 'In progress'));
    await user.click(await screen.findByRole('menuitem', { name: 'Done' }));
    const form = await screen.findByRole('form', { name: 'Finish SHOP-202: what it needs' });
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form')).toBeNull();
    expect(await statusOf('SHOP-202', 'In progress')).toHaveFocus();
    expect(client.calls.some((call) => call.action === 'moveChild')).toBe(false);

    await user.click(await statusOf('SHOP-202', 'In progress'));
    await user.click(await screen.findByRole('menuitem', { name: 'Done' }));
    const again = await screen.findByRole('form', { name: 'Finish SHOP-202: what it needs' });
    await user.selectOptions(within(again).getByRole('combobox', { name: 'Close reason' }), '2');
    await user.click(within(again).getByRole('button', { name: 'Finish SHOP-202' }));
    expect(client.calls).toContainEqual({
      action: 'moveChild',
      args: [202, 13, { 'close-reason': 2 }],
    });
    expect(await statusOf('SHOP-202', 'Done')).toBeVisible();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('[CORE-032] takes the focus to the form a move asks with, and Escape goes back', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient({ transitions: childTransitions(true) });
    // What a pop-up around the panel would hear of an Escape.
    const around: string[] = [];
    render(
      <I18nProvider locale="en">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: listens only, as a pop-up does */}
        <div
          onKeyDown={(event) => {
            if (!event.defaultPrevented) around.push(event.key);
          }}
        >
          <SubticketsPanel ticket={ticket(0)} client={client} revision={0} />
        </div>
      </I18nProvider>,
    );
    (await statusOf('SHOP-202', 'In progress')).focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu', { name: 'Status of SHOP-202: In progress' });
    await user.keyboard('{ArrowDown}{Enter}');
    // The form opens under the whole list: its first field takes the focus, inside a form
    // named for the ticket and the move.
    const form = await screen.findByRole('form', { name: 'Finish SHOP-202: what it needs' });
    const reason = within(form).getByRole('combobox', { name: 'Close reason' });
    await waitFor(() => expect(reason).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('form')).toBeNull();
    expect(await statusOf('SHOP-202', 'In progress')).toHaveFocus();
    expect(around).not.toContain('Escape');
    expect(client.calls.some((call) => call.action === 'moveChild')).toBe(false);
  });

  it('[CORE-032] sends the person to the ticket for a move that asks for more', async () => {
    const user = userEvent.setup();
    const [reopen] = childTransitions();
    const client = fakeToolsClient({
      transitions: [{ ...(reopen as Transition), layout: ['comment'] }],
    });
    renderPanel(client);
    await user.click(await statusOf('SHOP-201', 'Done'));
    await user.click(await screen.findByRole('menuitem', { name: 'To do' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SHOP-201 needs more to move there: open it to move it.',
    );
    expect(client.calls.some((call) => call.action === 'moveChild')).toBe(false);
  });

  it('[CORE-032] says why the workflow refused a move, naming the ticket', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    client.moveChild = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderPanel(client);
    await user.click(await statusOf('SHOP-202', 'In progress'));
    await user.click(await screen.findByRole('menuitem', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SHOP-202: You may not make this change to this ticket.',
    );
    expect(await statusOf('SHOP-202', 'In progress')).toHaveFocus();
  });

  it('[CORE-032] says when a status has nowhere to go', async () => {
    const user = userEvent.setup();
    renderPanel(fakeToolsClient({ transitions: [] }));
    await user.click(await statusOf('SHOP-202', 'In progress'));
    const item = await screen.findByRole('menuitem', { name: 'Nowhere to go from In progress' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(await statusOf('SHOP-202', 'In progress')).toHaveFocus();
  });

  it('[CORE-032] shows the status as text where the client cannot move tickets', async () => {
    renderPanel(fakeToolsClient({ transitions: 'none' }));
    expect(await screen.findByText('In progress')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Status of/ })).toBeNull();
  });

  it('[CORE-032] moves one on a phone too', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    const client = fakeToolsClient();
    renderPanel(client);
    await user.click(await statusOf('SHOP-201', 'Done'));
    await user.click(await screen.findByRole('menuitem', { name: 'In progress' }));
    expect(await statusOf('SHOP-201', 'In progress')).toBeVisible();
  });
});

describe('SubticketProgressMini', () => {
  it('[CORE-032] reads the numbers aloud and shows them short', () => {
    render(
      <I18nProvider locale="en">
        <SubticketProgressMini progress={{ total: 4, closed: 1 }} />
      </I18nProvider>,
    );
    expect(screen.getByText('1 of 4 closed (25%)')).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeVisible();
  });
});

describe('the result table (CORE-032)', () => {
  it('[CORE-032] shows the same small progress under the key of a ticket that has subtickets, named (PL-31)', async () => {
    const client = {
      priorities: async () => [],
      subticketProgress: async () => ({ 7: { total: 2, closed: 2 } }),
    } as unknown as SearchClient;
    const row = (id: number, key: string) => ({
      id,
      key,
      summary: key,
      status: { name: 'New', stage: 'new' as const },
      ticketType: { name: 'Feature' },
      assignee: null,
      updatedAt: '2026-11-03T10:00:00Z',
    });
    render(
      <I18nProvider locale="en">
        <ResultTable
          tickets={[row(7, 'SHOP-7'), row(8, 'SHOP-8')]}
          columns={[]}
          fields={[]}
          client={client}
          onSaved={() => {}}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText('2/2 subtickets closed')).toBeVisible();
    expect(screen.getByText('Subtickets: 2 of 2 closed (100%)')).toBeInTheDocument();
    expect(screen.getAllByText(/^[0-9]+.[0-9]+ subtickets closed$/)).toHaveLength(1);
  });
});
