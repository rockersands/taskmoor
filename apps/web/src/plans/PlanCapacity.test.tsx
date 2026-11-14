import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import type { PlanSection } from './address';
import { type FakePlanOptions, fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

/**
 * Teams and capacity in a plan (T-089b; PLN-005, PLN-009; ADR-122 stage 3), with the fixture
 * plan: two-week periods from Monday 2026-11-02, in points. Web (Ana and Bo) may take 20 points a
 * period, Ana 10, and none from Nov 16 (leave). Ana has SHOP-2 (5 points) due Nov 10 and 13 points
 * elsewhere then, OPS-4 (3) due Nov 18; Bo has SHOP-3 (8) due Nov 20. Ops (Cy) has nothing.
 */
function renderPlan(section: PlanSection, hash: string, options: FakePlanOptions = {}) {
  window.location.hash = hash;
  const client = fakePlanClient(options);
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={client}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}
const renderCapacity = (options: FakePlanOptions = {}) =>
  renderPlan('capacity', '#/plans/12/capacity', options);

const BASE = 'track IN ("SHOP", "OPS") OR (track = PLB AND due IS NOT EMPTY)';
const searched = (link: HTMLElement) =>
  new URLSearchParams((link.getAttribute('href') ?? '').split('?')[1]).get('q');

/** The table row whose header starts with this name. */
const rowOf = (name: string) =>
  screen
    .getAllByRole('row')
    .find((r) => r.querySelector('th .capacity-name')?.textContent === name) as HTMLElement;
/** That row's cell for a period, by its index (0 is the first period in view). */
const cellOf = (name: string, period: number) =>
  within(rowOf(name)).getAllByRole('cell')[period] as HTMLElement;

afterEach(() => {
  window.location.hash = '';
});

describe('teams and capacity in a plan (PLN-005, PLN-009)', () => {
  it('[PLN-005] shows each team and person’s work per period against capacity, each count linked to its search', async () => {
    renderCapacity();
    expect(await screen.findByRole('region', { name: 'Capacity by period' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Capacity' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Nov 2, 2026 to Dec 27, 2026' })).toBeVisible();
    // The period holding today says so in words.
    expect(screen.getByRole('columnheader', { name: 'Nov 2 to Nov 15 Now' })).toBeVisible();
    // Web: its members' 5 points here and 13 elsewhere, against its own 20.
    expect(cellOf('Web', 0)).toHaveTextContent('18 of 20 points');
    expect(cellOf('Web', 0)).not.toHaveClass('is-over');
    // Ana: 5 points in the plan, 13 elsewhere, against 10: over, in red and in words.
    const ana = cellOf('Ana Ruiz', 0);
    expect(ana).toHaveTextContent('18 of 10 points');
    expect(within(ana).getByText('Over capacity by 8 points')).toBeVisible();
    expect(ana.querySelector('.capacity-cell')).toHaveClass('is-over');
    const link = within(ana).getByRole('link', {
      name: '1 ticket for Ana Ruiz, Nov 2 to Nov 15: open the search',
    });
    expect(searched(link)).toBe(
      `(${BASE}) AND assignee = 7 AND due >= "2026-11-02" AND due <= "2026-11-15"`,
    );
    // On leave from Nov 16: 3 points against none.
    const leave = cellOf('Ana Ruiz', 1);
    expect(leave).toHaveTextContent('3 of 0 points');
    expect(within(leave).getByText('Leave')).toBeVisible();
    expect(within(leave).getByText('Over capacity by 3 points')).toBeVisible();
    // Bo has no capacity of his own: his work, never "over".
    expect(cellOf('Bo Lindqvist', 1)).toHaveTextContent('8 points');
    expect(within(cellOf('Bo Lindqvist', 1)).getByText('No capacity set')).toBeVisible();
    expect(cellOf('Bo Lindqvist', 1).querySelector('.is-over')).toBeNull();
    // Unassigned work open without a due date, in the last column, linked to its search.
    const open = within(cellOf('Unassigned', 4)).getByRole('link', {
      name: '2 tickets for Unassigned, Open, no due date: open the search',
    });
    expect(searched(open)).toBe(
      `(${BASE}) AND assignee IS EMPTY AND stage != closed AND due IS EMPTY`,
    );
  });

  it('[PLN-009] counts work outside the plan or hidden from the viewer as a number, never naming it', async () => {
    renderCapacity();
    await screen.findByRole('region', { name: 'Capacity by period' });
    const ana = cellOf('Ana Ruiz', 0);
    expect(within(ana).getByText('+13 points in 1 ticket elsewhere')).toBeVisible();
    // Only the plan's own tickets are a link; the work elsewhere is not.
    expect(within(ana).getAllByRole('link')).toHaveLength(1);
    expect(
      screen.getByText(/“Elsewhere” is someone’s other work due in that period/),
    ).toHaveTextContent(
      'It is counted by whole weeks, Monday to Sunday, each in the period that holds most of it.',
    );
  });

  it('[PLN-009] sets a person’s capacity for every period and for one, from the keyboard', async () => {
    const user = userEvent.setup();
    const client = renderCapacity();
    await user.click(await screen.findByRole('button', { name: 'Set capacity of Bo Lindqvist' }));
    const dialog = screen.getByRole('dialog', { name: 'Capacity of Bo Lindqvist' });
    expect(within(dialog).getByLabelText('Capacity for every period')).toHaveFocus();
    await user.keyboard('abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save capacity' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a number from 0 to');
    const every = within(dialog).getByLabelText('Capacity for every period');
    await user.clear(every);
    await user.type(every, '12');
    await user.type(within(dialog).getByLabelText('Capacity for Nov 16 to Nov 29'), '4');
    await user.type(within(dialog).getByLabelText('Note for Nov 16 to Nov 29'), 'Half time{Enter}');
    expect(await screen.findByText('Capacity of Bo Lindqvist saved.')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.capacitySaved.at(-1)).toEqual([
      { userId: 8, period: null, amount: 12, note: '' },
      { userId: 8, period: '2026-11-16', amount: 4, note: 'Half time' },
    ]);
    await waitFor(() => expect(cellOf('Bo Lindqvist', 1)).toHaveTextContent('8 of 4 points'));
    expect(within(cellOf('Bo Lindqvist', 1)).getByText('Over capacity by 4 points')).toBeVisible();
    expect(cellOf('Bo Lindqvist', 0)).toHaveTextContent('0 of 12 points');
    // Opened again, only what changes is sent: emptying a period removes its own capacity.
    await user.click(screen.getByRole('button', { name: 'Set capacity of Bo Lindqvist' }));
    await user.clear(screen.getByLabelText('Capacity for Nov 16 to Nov 29'));
    await user.click(screen.getByRole('button', { name: 'Save capacity' }));
    await waitFor(() =>
      expect(client.capacitySaved.at(-1)).toEqual([
        { userId: 8, period: '2026-11-16', amount: null },
      ]),
    );
  });

  it('[PLN-009] refuses a note typed without a capacity at that capacity, never dropping it', async () => {
    const user = userEvent.setup();
    const client = renderCapacity();
    await user.click(await screen.findByRole('button', { name: 'Set capacity of Ana Ruiz' }));
    // Ana has 10 points every period: the period's own field shows it, empty.
    const amount = screen.getByLabelText('Capacity for Nov 30 to Dec 13');
    expect(amount).toHaveValue('');
    expect(amount).toHaveAttribute('placeholder', '10');
    await user.type(screen.getByLabelText('Note for Nov 30 to Dec 13'), 'Holiday{Enter}');
    // Nothing sent and the dialog stays, saying so at the amount, which takes the focus.
    expect(screen.getByRole('dialog', { name: 'Capacity of Ana Ruiz' })).toBeVisible();
    expect(client.capacitySaved).toEqual([]);
    await waitFor(() => expect(amount).toHaveFocus());
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveAccessibleDescription(
      'A note goes with a capacity: enter one for Nov 30 to Dec 13, or clear its note.',
    );
    expect(screen.getByLabelText('Note for Nov 30 to Dec 13')).toHaveValue('Holiday');
    // Typing the amount clears what was said; saving keeps the note with it.
    await user.type(amount, '6');
    expect(amount).not.toHaveAttribute('aria-invalid');
    expect(amount).not.toHaveAccessibleDescription();
    // The same for every period's note.
    await user.clear(screen.getByLabelText('Capacity for every period'));
    await user.type(screen.getByLabelText('Note for every period'), 'Part time');
    await user.click(screen.getByRole('button', { name: 'Save capacity' }));
    const every = screen.getByLabelText('Capacity for every period');
    await waitFor(() => expect(every).toHaveFocus());
    expect(every).toHaveAccessibleDescription(
      'A note goes with a capacity: enter one for every period, or clear its note.',
    );
    expect(client.capacitySaved).toEqual([]);
    await user.type(every, '8{Enter}');
    expect(await screen.findByText('Capacity of Ana Ruiz saved.')).toBeVisible();
    expect(client.capacitySaved).toEqual([
      [
        { userId: 7, period: null, amount: 8, note: 'Part time' },
        { userId: 7, period: '2026-11-30', amount: 6, note: 'Holiday' },
      ],
    ]);
    // Emptying an amount alone still removes that capacity, with the note it had.
    await user.click(screen.getByRole('button', { name: 'Set capacity of Ana Ruiz' }));
    expect(screen.getByLabelText('Note for Nov 16 to Nov 29')).toHaveValue('Leave');
    await user.clear(screen.getByLabelText('Capacity for Nov 16 to Nov 29'));
    await user.click(screen.getByRole('button', { name: 'Save capacity' }));
    await waitFor(() =>
      expect(client.capacitySaved.at(-1)).toEqual([
        { userId: 7, period: '2026-11-16', amount: null },
      ]),
    );
  });

  it('[PLN-009] sends the unit and periods capacity was typed for, and says when they changed', async () => {
    const user = userEvent.setup();
    const client = renderCapacity();
    await user.click(await screen.findByRole('button', { name: 'Set capacity of Bo Lindqvist' }));
    await user.type(screen.getByLabelText('Capacity for every period'), '12{Enter}');
    expect(await screen.findByText('Capacity of Bo Lindqvist saved.')).toBeVisible();
    expect(client.capacitySettings).toEqual([
      { unit: 'points', period: { kind: 'weeks', weeks: 2, anchor: '2026-11-02' } },
    ]);
    // Someone counts the plan in hours meanwhile: 12 points are not 12 hours, so nothing saves.
    await client.update(12, { capacityUnit: 'hours', version: 1 });
    await user.click(screen.getByRole('button', { name: 'Set capacity of Bo Lindqvist' }));
    const every = screen.getByLabelText('Capacity for every period');
    await user.clear(every);
    await user.type(every, '14{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This plan’s unit or periods changed meanwhile, so nothing was saved. Reload the page and set the capacity again.',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(client.capacitySaved).toHaveLength(1);
  });

  it('[PLN-009] says why a change of capacity was refused', async () => {
    const user = userEvent.setup();
    renderCapacity({ refuseCapacity: 'forbidden' });
    await user.click(await screen.findByRole('button', { name: 'Set capacity of Web' }));
    const every = screen.getByLabelText('Capacity for every period');
    expect(every).toHaveValue('20');
    await user.clear(every);
    await user.type(every, '25');
    await user.click(screen.getByRole('button', { name: 'Save capacity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You may not change this plan’s capacity.',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('[PLN-005] moves between periods, and only editors set capacity', async () => {
    const user = userEvent.setup();
    renderCapacity({ editable: false });
    expect(
      await screen.findByRole('heading', { name: 'Nov 2, 2026 to Dec 27, 2026' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Set capacity/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Later periods' }));
    expect(
      await screen.findByRole('heading', { name: 'Dec 28, 2026 to Feb 21, 2027' }),
    ).toBeVisible();
    expect(screen.queryByText('Now')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Earlier periods' }));
    expect(
      await screen.findByRole('heading', { name: 'Nov 2, 2026 to Dec 27, 2026' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Later periods' }));
    await user.click(await screen.findByRole('button', { name: 'This period' }));
    expect(
      await screen.findByRole('heading', { name: 'Nov 2, 2026 to Dec 27, 2026' }),
    ).toBeVisible();
  });

  it('[PLN-005] says when a plan has no teams yet and where to choose them', async () => {
    renderCapacity({ noTeams: true });
    expect(await screen.findByText('This plan has no teams yet.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Choose its teams in Settings' })).toHaveAttribute(
      'href',
      expect.stringContaining('#/plans/12/settings'),
    );
    // The plan's work still shows: unassigned and assigned. With no teams there is no "none of
    // these teams", and no "Elsewhere" to explain (PL-39).
    expect(rowOf('Unassigned')).toBeVisible();
    expect(rowOf('Assigned to someone')).toBeVisible();
    expect(screen.queryByText('People in none of these teams')).toBeNull();
    expect(screen.queryByText(/“Elsewhere”/)).toBeNull();
  });

  it('[PLN-005] shows few enough periods on a desktop that the open column fits, the rest by Earlier and Later (D32)', async () => {
    const client = renderCapacity();
    await screen.findByRole('region', { name: 'Capacity by period' });
    expect(client.capacityAsked.at(-1)?.periods).toBe(4);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Team or person',
      'Nov 2 to Nov 15 Now',
      'Nov 16 to Nov 29',
      'Nov 30 to Dec 13',
      'Dec 14 to Dec 27',
      'Open, no due date',
    ]);
  });

  it('[PLN-005] puts the periods’ dates first, Earlier and Later together after them (PL-38)', async () => {
    renderCapacity();
    const dates = await screen.findByRole('heading', { name: 'Nov 2, 2026 to Dec 27, 2026' });
    const earlier = screen.getByRole('button', { name: 'Earlier periods' });
    expect(dates.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(earlier.nextElementSibling).toBe(screen.getByRole('button', { name: 'Later periods' }));
  });

  it('[PLN-005] chooses the plan’s teams, unit and periods in Settings, asking before clearing capacity', async () => {
    const user = userEvent.setup();
    const client = renderPlan('settings', '#/plans/12/settings');
    const teams = await screen.findByRole('group', { name: 'Teams' });
    expect(await within(teams).findByRole('checkbox', { name: 'Web (2 people)' })).toBeChecked();
    await user.click(within(teams).getByRole('checkbox', { name: 'Data (4 people)' }));
    await user.click(within(teams).getByRole('checkbox', { name: 'Ops (1 person)' }));
    expect(within(teams).getByText('2 teams chosen')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Count work in'), 'hours');
    const confirm = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Save asks first, in its own place, saying what goes (D13); Cancel has the focus.
    const unitOutcome = 'Change the unit? Every capacity set in this plan will be cleared.';
    const unitQuestion = screen.getByRole('group', { name: unitOutcome });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(unitQuestion).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Escape sends nothing and gives the focus back to Save.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: unitOutcome })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    expect(client.saved).toEqual([]);
    // Asked again, and answered by keyboard.
    await user.keyboard('{Enter}');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(
      within(screen.getByRole('group', { name: unitOutcome })).getByRole('button', {
        name: 'Save and clear all capacity',
      }),
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.saved.at(-1)).toMatchObject({
      teams: [3, 5],
      capacityUnit: 'hours',
      period: { kind: 'weeks', weeks: 2, anchor: '2026-11-02' },
    });
    expect(screen.queryByRole('group', { name: unitOutcome })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    // Periods of a month, after a question about the capacity set for single periods.
    await user.selectOptions(screen.getByLabelText('Periods'), 'month');
    expect(screen.queryByLabelText('A period starts on')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const periodQuestion = screen.getByRole('group', {
      name: 'Change the periods? The capacity set for single periods will be cleared.',
    });
    // A change to the settings while it asks closes the question: it was about the old ones.
    await user.selectOptions(screen.getByLabelText('Periods'), '3');
    expect(periodQuestion).not.toBeInTheDocument();
    expect(client.saved).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Periods'), 'month');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(
      screen.getByRole('button', { name: 'Save and clear single periods’ capacity' }),
    );
    await waitFor(() => expect(client.saved.at(-1)).toMatchObject({ period: { kind: 'month' } }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('[PLN-005] a save that gets no answer gives Save back, the question closed and the reason said (D13)', async () => {
    const user = userEvent.setup();
    const client = renderPlan('settings', '#/plans/12/settings');
    await user.selectOptions(await screen.findByLabelText('Count work in'), 'hours');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const outcome = 'Change the unit? Every capacity set in this plan will be cleared.';
    // The connection drops: fetch throws, never an answer from the server.
    const update = vi
      .spyOn(client, 'update')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Save and clear all capacity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The plan could not be saved.');
    expect(screen.queryByRole('group', { name: outcome })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    expect(save).toHaveFocus();
    // Asked again, it saves.
    update.mockRestore();
    await user.click(save);
    await user.click(screen.getByRole('button', { name: 'Save and clear all capacity' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.saved.at(-1)).toMatchObject({ capacityUnit: 'hours' });
  });

  it('[PLN-005] typing in a list’s search box leaves the question open: it changes no setting (D13)', async () => {
    const user = userEvent.setup();
    renderPlan('settings', '#/plans/12/settings');
    await user.selectOptions(await screen.findByLabelText('Count work in'), 'hours');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const outcome = 'Change the unit? Every capacity set in this plan will be cleared.';
    const question = screen.getByRole('group', { name: outcome });
    await user.type(screen.getByLabelText('Find a track or saved search'), 'sh');
    expect(question).toBeInTheDocument();
    // A setting changed while it asks still closes it.
    await user.type(screen.getByLabelText('Name'), '!');
    expect(question).not.toBeInTheDocument();
  });

  it('[PLN-005] fits a phone: a card per team and person, no sideways scroll', async () => {
    setViewportWidth(375);
    renderCapacity();
    const cards = await screen.findByRole('list', { name: 'Capacity by period' });
    expect(within(cards).getByRole('heading', { name: 'Ana Ruiz', level: 3 })).toBeVisible();
    expect(within(cards).getAllByText('Over capacity by 8 points')[0]).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
