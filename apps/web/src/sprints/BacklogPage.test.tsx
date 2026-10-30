import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { BacklogPage } from './BacklogPage';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

function renderBacklog(client = fakeSprintClient()) {
  render(
    <I18nProvider locale="en">
      <BacklogPage boardId={7} client={client} now={() => new Date('2026-10-29T09:00:00Z')} />
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

  it('[AGL-008] moves a ticket into a sprint and back to the backlog with the keyboard', async () => {
    const user = userEvent.setup();
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.selectOptions(
      section('Backlog').getByRole('combobox', { name: 'Move CHK-4 to' }),
      'Checkout Sprint 2',
    );
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-4']));
    await user.selectOptions(
      section('Checkout Sprint 2').getByRole('combobox', { name: 'Move CHK-3 to' }),
      'Backlog',
    );
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

  it('[AGL-010] fits a phone: sections stack, nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

describe('planning on the backlog (M1-047)', () => {
  // jsdom has no DragEvent: a mouse event stands in, so the pointer's position reaches the page.
  beforeAll(() => {
    if (!('DragEvent' in window)) {
      Object.defineProperty(window, 'DragEvent', {
        value: class extends MouseEvent {},
        configurable: true,
      });
    }
  });
  const dataTransfer = () => ({
    setData: () => undefined,
    getData: () => '',
    effectAllowed: 'move',
    dropEffect: 'move',
  });
  const rowOf = (key: string) =>
    screen.getByRole('link', { name: key }).closest('li') as HTMLElement;
  // jsdom gives no layout: every row's box is empty, so a pointer above 0 is above its middle.
  const drag = (key: string, to: HTMLElement, over: HTMLElement = to, clientY = 10) => {
    const transfer = dataTransfer();
    fireEvent.dragStart(rowOf(key), { dataTransfer: transfer });
    fireEvent.dragOver(over, { dataTransfer: transfer, clientY });
    fireEvent.drop(to, { dataTransfer: transfer });
  };
  /** The fake client, counting the calls that change sprints. */
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

  it('[AGL-008] drags the selection to a place in another section, as one block', async () => {
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CHK-5' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CHK-4' }));
    // Above the middle of CHK-3: the block goes before it, in the order the page shows.
    drag('CHK-5', screen.getByRole('region', { name: 'Checkout Sprint 2' }), rowOf('CHK-3'), -1);
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-4', 'CHK-5', 'CHK-3']));
    expect(calls).toEqual(['add 12 4,5', 'rank 4,5 {"before":3}']);
  });

  it('[AGL-009] ranks within a section by dragging and with Alt and the arrows', async () => {
    const user = userEvent.setup();
    const { client, calls } = counted();
    renderBacklog(client);
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    drag('CHK-5', screen.getByRole('region', { name: 'Backlog' }), rowOf('CHK-4'), -1);
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-5', 'CHK-4']));
    expect(calls).toEqual(['rank 5 {"before":4}']);
    // Dropped where it already is: nothing is asked of the server.
    drag('CHK-5', screen.getByRole('region', { name: 'Backlog' }), rowOf('CHK-4'), -1);
    expect(calls).toHaveLength(1);
    screen.getByRole('link', { name: 'CHK-5' }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']));
    expect(calls.at(-1)).toBe('rank 5 {"after":4}');
    expect(screen.getByRole('status')).toHaveTextContent('CHK-5 moved down.');
    await waitFor(() => expect(screen.getByRole('link', { name: 'CHK-5' })).toHaveFocus());
  });

  it('[AGL-008] puts tickets under an outcome by a drop on the panel, and filters by it', async () => {
    const user = userEvent.setup();
    const client = fakeSprintClient();
    renderBacklog(client);
    const panels = within(
      await screen.findByRole('complementary', { name: 'Outcomes and releases' }),
    );
    const outcome = await panels.findByRole('button', { name: /Faster checkout/ });
    drag('CHK-4', outcome.closest('li') as HTMLElement);
    await waitFor(() => expect(outcome).toHaveTextContent('1 ticket, 0 closed'));
    expect(client.state().backlog.tickets.find((x) => x.key === 'CHK-4')?.parentId).toBe(40);
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
