import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setCoarsePointer, setViewportWidth } from '../test/viewport';
import type { TrackSections } from '../tracks/client';
import { TrackSectionsContext } from '../tracks/trackSections';
import { BacklogPage } from './BacklogPage';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

function renderBacklog(client = fakeSprintClient(), sections: TrackSections | null = null) {
  render(
    <I18nProvider locale="en">
      <TrackSectionsContext.Provider value={sections}>
        <BacklogPage boardId={7} client={client} now={() => new Date('2026-10-29T09:00:00Z')} />
      </TrackSectionsContext.Provider>
    </I18nProvider>,
  );
  return client;
}
const section = (name: string) => within(screen.getByRole('region', { name }));
const keysIn = (name: string) =>
  section(name)
    .queryAllByRole('link')
    .map((a) => a.textContent)
    .filter((text) => text?.startsWith('CHK-'));

describe('the backlog with sprint sections (M1-044)', () => {
  it('[AGL-011] shows the active sprint, the planned one and the backlog, each with its totals', async () => {
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(keysIn('Checkout Sprint 1')).toEqual(['CHK-1', 'CHK-2']);
    expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3']);
    expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']);
    expect(
      section('Checkout Sprint 1').getByText('2 tickets, estimate 7h, 5h remaining'),
    ).toBeVisible();
    expect(
      section('Checkout Sprint 1').getByRole('link', { name: 'Sprint report' }),
    ).toHaveAttribute('href', '#/boards/7/sprints/11/report');
  });

  it('[CORE-005] [CORE-014] shows each ticket’s type and priority as named icons', async () => {
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(section('Backlog').getAllByRole('img', { name: 'Task' })).toHaveLength(2);
    expect(section('Backlog').getAllByRole('img', { name: 'High' })).toHaveLength(2);
  });

  it('[AGL-008] moves a ticket into a sprint and back to the backlog from its grip, by keyboard', async () => {
    const user = userEvent.setup();
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    const grip = section('Backlog').getByRole('button', { name: 'Move CHK-4' });
    grip.focus();
    await user.keyboard('{Enter}');
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Move down',
      'Move to the bottom',
      'Move to Checkout Sprint 1',
      'Move to Checkout Sprint 2',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Move to Checkout Sprint 2' }));
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-4']));
    // The grip is where the ticket went, and still has the keyboard.
    await waitFor(() =>
      expect(
        section('Checkout Sprint 2').getByRole('button', { name: 'Move CHK-4' }),
      ).toHaveFocus(),
    );
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Move CHK-3' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to Backlog' }));
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-3', 'CHK-5']));
  });

  it('[AGL-010] completes the active sprint into a planned one, then starts it', async () => {
    const user = userEvent.setup();
    const client = renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    // Only one sprint may be active: starting the planned one is refused until then.
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be started');
    await user.selectOptions(
      section('Checkout Sprint 1').getByRole('combobox', { name: 'Move unfinished tickets to' }),
      'Checkout Sprint 2',
    );
    await user.click(section('Checkout Sprint 1').getByRole('button', { name: 'Complete sprint' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Checkout Sprint 1' })).toBeNull(),
    );
    expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-1']);
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }));
    await waitFor(() => expect(client.state().sprints[0]?.state).toBe('active'));
    await user.click(screen.getByRole('button', { name: 'Create sprint' }));
    expect(await screen.findByRole('heading', { name: 'Checkout Sprint 3' })).toBeVisible();
  });

  it('[AGL-010] says so in plain words when the track has its sprints turned off', async () => {
    const user = userEvent.setup();
    const client = fakeSprintClient();
    client.start = async () => ({ ok: false, code: 'sprints_off' });
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track has its sprints turned off, so none can start.',
    );
  });

  it("[AGL-010] offers no Start sprint while the track's sprints are off, and says why", async () => {
    renderBacklog(fakeSprintClient(), { backlog: true, sprints: false });
    await screen.findByRole('heading', { name: 'Checkout Sprint 2' });
    expect(section('Checkout Sprint 2').queryByRole('button', { name: 'Start sprint' })).toBeNull();
    expect(
      screen.getByText(
        'This track has its sprints turned off, so none can start. An administrator turns them on under Administration, Tracks.',
      ),
    ).toBeVisible();
    // The running one can still be completed, and sprints can still be planned.
    expect(
      section('Checkout Sprint 1').getByRole('button', { name: 'Complete sprint' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create sprint' })).toBeVisible();
  });

  it('[AGL-010] offers Start sprint on a track with sprints on, with no note', async () => {
    renderBacklog(fakeSprintClient(), { backlog: true, sprints: true });
    await screen.findByRole('heading', { name: 'Checkout Sprint 2' });
    expect(
      section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }),
    ).toBeVisible();
    expect(screen.queryByText(/sprints turned off/)).toBeNull();
  });

  it('[AGL-010] tells a finger how to rank, and a keyboard the keys, on any width (D6, TR-7)', async () => {
    const keys = /With the keyboard, the grip opens a menu/;
    const finger =
      'Drag a ticket by its grip to rank it or move it to another section, or tap the grip for a menu of every move.';
    setViewportWidth(375);
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(screen.getByText(keys)).toBeInTheDocument();
    expect(screen.queryByText(finger)).toBeNull();
    cleanup();
    setCoarsePointer(true);
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(screen.getByText(finger)).toBeInTheDocument();
    expect(screen.queryByText(keys)).toBeNull();
  });

  it('[AGL-010] fits a phone: sections stack, nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

describe('planning on the backlog (M1-047)', () => {
  const rowOf = (key: string) =>
    screen.getByRole('link', { name: key }).closest('li') as HTMLElement;
  /** jsdom lays nothing out: each row the test lands on is given a box, 40 pixels from y. */
  const placed = (row: HTMLElement, top: number) =>
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 600, 40));
  /**
   * A drag with pointer events, as a mouse or a finger makes it (T-162): down on a row or a grip,
   * over the page, then up (unless the test lets go itself). What is under the pointer is the
   * target given.
   */
  function dragTo(
    from: HTMLElement,
    to: Element,
    options: { pointerType?: 'mouse' | 'touch'; y?: number; up?: boolean } = {},
  ) {
    const { pointerType = 'mouse', y = 300, up = true } = options;
    const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(to);
    const point = { pointerId: 3, pointerType, isPrimary: true };
    fireEvent.pointerDown(from, { ...point, button: 0, clientX: 10, clientY: 200 });
    fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 40, clientY: y });
    fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 80, clientY: y });
    if (up) fireEvent.pointerUp(window, { ...point, clientX: 80, clientY: y });
    return under;
  }
  /** The fake client, counting the calls that change sprints and ranks. */
  function counted() {
    const client = fakeSprintClient();
    const calls: string[] = [];
    return {
      calls,
      client: {
        ...client,
        addTickets: async (sprint: number, ids: number[]) => {
          calls.push(`add ${sprint} ${ids.join(',')}`);
          await client.addTickets(sprint, ids);
        },
        rank: async (...args: Parameters<typeof client.rank>) => {
          calls.push(`rank ${args[1].join(',')} ${JSON.stringify(args[2])}`);
          return client.rank(...args);
        },
      },
    };
  }

  it('[AGL-008] moves selected tickets into a sprint in one operation', async () => {
    const user = userEvent.setup();
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.click(
      screen.getByRole('checkbox', { name: 'Select every ticket shown in Backlog' }),
    );
    const selection = screen.getByRole('group', { name: 'Selected tickets' });
    expect(within(selection).getByText('2 tickets selected')).toBeVisible();
    await user.selectOptions(
      within(selection).getByRole('combobox', { name: 'Move selected to…' }),
      'Checkout Sprint 2',
    );
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-4', 'CHK-5']));
    expect(calls).toEqual(['add 12 4,5']);
    expect(screen.getByRole('status')).toHaveTextContent('2 tickets moved to Checkout Sprint 2.');
  });

  it('[AGL-008] drags the selection by mouse to a place in another section, as one block', async () => {
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CHK-5' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CHK-4' }));
    // Above the middle of CHK-3: the block goes before it, in the order the page shows.
    placed(rowOf('CHK-3'), 290);
    dragTo(screen.getByText('Split payments'), rowOf('CHK-3'), { y: 300 });
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-4', 'CHK-5', 'CHK-3']));
    expect(calls).toEqual(['add 12 4,5', 'rank 4,5 {"before":3}']);
  });

  it('[AGL-009] ranks within a section by dragging and with Alt and the arrows', async () => {
    const user = userEvent.setup();
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    placed(rowOf('CHK-4'), 290);
    dragTo(screen.getByText('Split payments'), rowOf('CHK-4'), { y: 300 });
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-5', 'CHK-4']));
    expect(calls).toEqual(['rank 5 {"before":4}']);
    // Dropped where it already is: nothing is asked of the server, and the page says so.
    placed(rowOf('CHK-4'), 290);
    dragTo(screen.getByText('Split payments'), rowOf('CHK-4'), { y: 300 });
    expect(calls).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('CHK-5 stays where it was.');
    screen.getByRole('link', { name: 'CHK-5' }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']));
    expect(calls.at(-1)).toBe('rank 5 {"after":4}');
    expect(screen.getByRole('status')).toHaveTextContent('CHK-5 moved down.');
    await waitFor(() => expect(screen.getByRole('link', { name: 'CHK-5' })).toHaveFocus());
  });

  it('[AGL-008] [NFR-005] says what is in hand, marks where it would land, and Escape cancels', async () => {
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    placed(rowOf('CHK-3'), 290);
    const under = dragTo(screen.getByText('Gift cards'), rowOf('CHK-3'), { y: 300, up: false });
    expect(
      screen.getByText(
        'Moving CHK-4: drop on a place in a sprint or the backlog, or on an outcome or a release. Escape cancels.',
      ),
    ).toHaveClass('visually-hidden');
    expect(rowOf('CHK-4')).toHaveClass('is-dragging');
    expect(screen.getByRole('region', { name: 'Checkout Sprint 2' })).toHaveClass('is-drop-target');
    expect(rowOf('CHK-3')).toHaveClass('is-drop-before');
    // Escape goes no further than the drag: a dialog around the page would stay open.
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 3, pointerType: 'mouse', clientX: 80, clientY: 300 });
    under.mockRestore();
    expect(screen.getByRole('status')).toHaveTextContent('CHK-4 stays where it was.');
    expect(rowOf('CHK-4')).not.toHaveClass('is-dragging');
    expect(screen.getByRole('region', { name: 'Checkout Sprint 2' })).not.toHaveClass(
      'is-drop-target',
    );
    expect(calls).toEqual([]);
    expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']);
  });

  it('[AGL-008] a finger drags a ticket by its grip, not by its row; a tap opens the grip’s menu', async () => {
    // On a phone, where a finger is the pointer.
    setViewportWidth(375);
    const user = userEvent.setup();
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    // A finger on the row scrolls the page: nothing moves.
    dragTo(
      screen.getByText('Gift cards'),
      screen.getByRole('region', { name: 'Checkout Sprint 2' }),
      {
        pointerType: 'touch',
      },
    ).mockRestore();
    expect(calls).toEqual([]);
    // On the grip, it drags: to the end of the planned sprint.
    dragTo(
      section('Backlog').getByRole('button', { name: 'Move CHK-4' }),
      screen.getByRole('heading', { name: 'Checkout Sprint 2' }),
      { pointerType: 'touch' },
    ).mockRestore();
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-4']));
    expect(calls).toEqual(['add 12 4', 'rank 4 {"after":3}']);
    expect(screen.getByRole('status')).toHaveTextContent('1 ticket moved to Checkout Sprint 2.');
    // A press without moving is the grip's own: its menu opens.
    await user.click(section('Backlog').getByRole('button', { name: 'Move CHK-5' }));
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('[AGL-009] the grip’s menu ranks one ticket up, down, to the top and to the bottom', async () => {
    const user = userEvent.setup();
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.click(section('Backlog').getByRole('button', { name: 'Move CHK-5' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to the top' }));
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-5', 'CHK-4']));
    expect(calls).toEqual(['rank 5 {"position":"top"}']);
    expect(screen.getByRole('status')).toHaveTextContent('CHK-5 moved to the top.');
    await waitFor(() =>
      expect(section('Backlog').getByRole('button', { name: 'Move CHK-5' })).toHaveFocus(),
    );
    // Alt and the arrows work on the grip too, and leave the keyboard on it.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']));
    expect(calls.at(-1)).toBe('rank 5 {"after":4}');
    await waitFor(() =>
      expect(section('Backlog').getByRole('button', { name: 'Move CHK-5' })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move up',
      'Move to the top',
      'Move to Checkout Sprint 1',
      'Move to Checkout Sprint 2',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-5', 'CHK-4']));
    expect(calls.at(-1)).toBe('rank 5 {"before":4}');
    expect(screen.getByRole('status')).toHaveTextContent('CHK-5 moved up.');
  });

  it('[AGL-009] a grip with no move to offer opens no empty menu, and says it is unavailable', async () => {
    const user = userEvent.setup();
    // A new board: no sprints yet, and one ticket in its backlog.
    const client = fakeSprintClient();
    const first = client.state();
    client.backlog = async () =>
      structuredClone({
        ...first,
        sprints: [],
        backlog: { ...first.backlog, tickets: first.backlog.tickets.slice(0, 1) },
      });
    renderBacklog(client);
    const grip = await screen.findByRole('button', { name: 'Move CHK-4' });
    expect(grip).toHaveAttribute('aria-disabled', 'true');
    expect(grip).not.toHaveAttribute('aria-haspopup');
    await user.click(grip);
    expect(screen.queryByRole('menu')).toBeNull();
    grip.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(grip).toHaveFocus();
  });

  it('[AGL-008] puts tickets under an outcome by a drop on the panel, and filters by it', async () => {
    const user = userEvent.setup();
    const client = fakeSprintClient();
    renderBacklog(client);
    const panels = within(
      await screen.findByRole('complementary', { name: 'Outcomes and releases' }),
    );
    const outcome = await panels.findByRole('button', { name: /Faster checkout/ });
    dragTo(rowOf('CHK-4'), outcome).mockRestore();
    await waitFor(() => expect(outcome).toHaveTextContent('1 ticket, 0 closed'));
    expect(client.state().backlog.tickets.find((x) => x.key === 'CHK-4')?.parentId).toBe(40);
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 ticket put under CHK-40 Faster checkout.',
    );
    await user.click(outcome);
    expect(outcome).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing the tickets of CHK-40 Faster checkout.')).toBeVisible();
    expect(keysIn('Backlog')).toEqual(['CHK-4']);
    expect(keysIn('Checkout Sprint 1')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Show all tickets' }));
    expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']);
  });

  it('[AGL-008] adds selected tickets to a release and takes them from an outcome with the menus', async () => {
    const user = userEvent.setup();
    const client = fakeSprintClient();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.click(screen.getByRole('checkbox', { name: 'Select CHK-1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select CHK-5' }));
    const selection = within(screen.getByRole('group', { name: 'Selected tickets' }));
    await user.selectOptions(
      selection.getByRole('combobox', { name: 'Add selected to release…' }),
      'Checkout 2.0',
    );
    expect(await screen.findByRole('button', { name: /Checkout 2\.0/ })).toHaveTextContent(
      '2 tickets, due 2026-12-01',
    );
    await user.selectOptions(
      selection.getByRole('combobox', { name: 'Put selected under…' }),
      'CHK-40 Faster checkout',
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '2 tickets put under CHK-40 Faster checkout.',
      ),
    );
    await user.selectOptions(
      selection.getByRole('combobox', { name: 'Put selected under…' }),
      'No outcome',
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('2 tickets taken from their outcome.'),
    );
    expect(client.state().sprints[0]?.tickets[0]).toMatchObject({
      parentId: null,
      releaseIds: [50],
    });
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('group', { name: 'Selected tickets' })).toBeNull();
  });

  it('[AGL-008] makes a ticket inline in a sprint', async () => {
    const user = userEvent.setup();
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 2' });
    await user.type(
      screen.getByRole('textbox', { name: 'Summary of a new ticket in Checkout Sprint 2' }),
      'Pay by bank transfer{Enter}',
    );
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-7']));
    expect(screen.getByRole('status')).toHaveTextContent('CHK-7 created.');
    expect(
      screen.getByRole('textbox', { name: 'Summary of a new ticket in Checkout Sprint 2' }),
    ).toHaveValue('');
  });
});

describe('the sprint report (M1-044)', () => {
  it('[AGL-010] marks scope change and changed estimates, with the totals', async () => {
    render(
      <I18nProvider locale="en">
        <SprintReportPage boardId={7} sprintId={11} client={fakeSprintClient()} />
      </I18nProvider>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Sprint report: Checkout Sprint 1' }),
    ).toBeVisible();
    const open = section('Tickets not completed');
    expect(open.getByText('3h → 5h')).toBeVisible();
    expect(open.getByText('Added after the start')).toBeVisible();
    expect(section('Completed tickets').getByRole('link', { name: 'CHK-2' })).toBeVisible();
    expect(screen.getByText('Committed at the start').nextElementSibling).toHaveTextContent('5h');
  });
});
