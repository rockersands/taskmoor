import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import type { PlanSection } from './address';
import type { PlanCalendar, PlanCapacity, PlanFilters, PlanTimeline } from './client';
import { fakePlanClient, planItems } from './fixtures';
import { PlanCalendarPage } from './PlanCalendarPage';
import { PlanPage } from './PlanPage';
import { PlanTimelinePage } from './PlanTimelinePage';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

/** Answers held until the test lets them go, in any order. */
function held<T>() {
  const waiting = new Map<string, (value: T) => void>();
  return {
    ask: (key: string) => new Promise<T>((resolve) => waiting.set(key, resolve)),
    answer: (key: string, value: T) => waiting.get(key)?.(value),
  };
}

const now = () => new Date('2026-11-04T09:00:00Z');

describe('a plan view read again (PLN-012)', () => {
  it('[PLN-012] draws the timeline for the latest filters, whatever answers last', async () => {
    const inner = fakePlanClient();
    const plan = await inner.get(12);
    const answers = held<PlanTimeline>();
    const client = {
      ...inner,
      timeline: (_id: number, f: PlanFilters) => answers.ask(f.track ?? ''),
    };
    const page = (filters: PlanFilters) => (
      <I18nProvider locale="en">
        <PlanTimelinePage
          id={12}
          plan={plan}
          filters={filters}
          client={client}
          now={now}
          group={null}
        />
      </I18nProvider>
    );
    const { rerender } = render(page({ track: 'SHOP' }));
    rerender(page({ track: 'OPS' }));
    const items = planItems();
    const data = (keys: string[]) => ({
      query: 'q',
      items: items.filter((i) => keys.includes(i.key)),
      links: [],
      blockersElsewhere: [],
      tracks: [],
      markers: { sprints: [], releases: [] },
      truncated: false,
    });
    await act(async () => answers.answer('OPS', data(['OPS-4'])));
    expect(await screen.findByRole('link', { name: 'OPS-4' })).toBeVisible();
    // The slow answer for the filter left behind arrives last, and is not drawn.
    await act(async () => answers.answer('SHOP', data(['SHOP-2'])));
    expect(screen.queryByRole('link', { name: 'SHOP-2' })).toBeNull();
    expect(screen.getByRole('link', { name: 'OPS-4' })).toBeVisible();
  });

  it('[PLN-012] draws the calendar for the latest filters, whatever answers last', async () => {
    const inner = fakePlanClient();
    const plan = await inner.get(12);
    const answers = held<PlanCalendar>();
    const client = {
      ...inner,
      calendar: (_id: number, f: PlanFilters) => answers.ask(f.track ?? ''),
    };
    const page = (filters: PlanFilters) => (
      <I18nProvider locale="en">
        <PlanCalendarPage id={12} plan={plan} filters={filters} client={client} now={now} />
      </I18nProvider>
    );
    const { rerender } = render(page({ track: 'SHOP' }));
    rerender(page({ track: 'OPS' }));
    const entry = (key: string, summary: string) => ({
      id: 1,
      key,
      summary,
      type: 'Feature',
      stage: 'new' as const,
      start: null,
      due: '2026-11-12',
      trackId: 1,
    });
    const data = (tickets: ReturnType<typeof entry>[]) => ({
      query: 'q',
      tickets,
      tracks: [],
      sprints: [],
      releases: [],
      truncated: false,
    });
    await act(async () => answers.answer('OPS', data([entry('OPS-4', 'Scale the servers')])));
    expect(
      await screen.findByRole('link', { name: 'OPS-4 Scale the servers, due this day' }),
    ).toBeVisible();
    await act(async () => answers.answer('SHOP', data([entry('SHOP-2', 'Build the shop page')])));
    expect(screen.queryByRole('link', { name: /^SHOP-2/ })).toBeNull();
  });
});

/**
 * The views in a scenario (T-089e; PLN-002; ADR-122 stage 6): "Faster" drafts SHOP-2 due on
 * 11 November instead of the 10th. Every change there writes a draft and never the ticket.
 */
function renderInScenario(
  section: PlanSection,
  hash: string,
  options: FakeScenarioOptions = {},
  wrap: (plans: ReturnType<typeof fakePlanClient>) => ReturnType<typeof fakePlanClient> = (p) => p,
) {
  window.location.hash = hash;
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, {
    scenarios: [
      { name: 'Main plan' },
      { name: 'Faster', drafts: [{ ticketId: 2, dueDate: '2026-11-11' }] },
    ],
    ...options,
  });
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={wrap(plans)}
        scenarios={scenarios}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { plans, scenarios };
}
const liveOf = (plans: ReturnType<typeof fakePlanClient>, key: string) =>
  plans.items().find((i) => i.key === key);

describe('the views in a scenario (PLN-002)', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('[PLN-002] marks a drafted bar in words and makes a change on the Timeline a draft, never the ticket’s own', async () => {
    const { plans, scenarios } = renderInScenario('timeline', '#/plans/12/timeline?scenario=2');
    const bar = await screen.findByRole('button', {
      name: 'SHOP-2, draft: Nov 2, 2026 to Nov 11, 2026. Now Nov 2, 2026 to Nov 10, 2026.',
    });
    expect(bar).toHaveClass('is-draft');
    const row = bar.closest('li') as HTMLElement;
    expect(within(row).getByText('Draft')).toBeVisible();
    expect(screen.getByText('Draft change (dashed edge, marked Draft)')).toBeVisible();
    // Alt and an arrow move OPS-4 a day: a draft in Faster, and the ticket keeps its days.
    const ops = screen.getByRole('button', { name: /^OPS-4: / });
    fireEvent.keyDown(ops, { key: 'ArrowRight', altKey: true });
    expect(
      await screen.findByText(
        'Draft: OPS-4 Nov 13, 2026 to Nov 19, 2026 in Faster. Nothing changed yet.',
      ),
    ).toBeVisible();
    expect(scenarios.writes.at(-1)).toEqual([
      { ticketId: 4, startDate: '2026-11-13', dueDate: '2026-11-19' },
    ]);
    expect(liveOf(plans, 'OPS-4')).toMatchObject({ start: '2026-11-12', due: '2026-11-18' });
    expect(
      await screen.findByRole('button', {
        name: 'OPS-4, draft: Nov 13, 2026 to Nov 19, 2026. Now Nov 12, 2026 to Nov 18, 2026.',
      }),
    ).toBeVisible();
  });

  it('[PLN-002] shows a drafted ticket’s days now and drafted in the side panel, which undoes the draft', async () => {
    const user = userEvent.setup();
    const { plans, scenarios } = renderInScenario('timeline', '#/plans/12/timeline?scenario=2');
    await user.click(await screen.findByRole('button', { name: /^SHOP-2, draft: / }));
    const panel = screen.getByRole('complementary', { name: 'Days of SHOP-2' });
    expect(within(panel).getByText('Now: Nov 2, 2026 to Nov 10, 2026')).toBeVisible();
    expect(within(panel).getByLabelText('Due date')).toHaveValue('2026-11-11');
    // Saving from the panel drafts too.
    await user.clear(within(panel).getByLabelText('Due date'));
    await user.type(within(panel).getByLabelText('Due date'), '2026-11-12');
    await user.click(within(panel).getByRole('button', { name: 'Save draft' }));
    await screen.findByText(
      'Draft: SHOP-2 Nov 2, 2026 to Nov 12, 2026 in Faster. Nothing changed yet.',
    );
    expect(liveOf(plans, 'SHOP-2')?.due).toBe('2026-11-10');
    await screen.findByRole('button', { name: /^SHOP-2, draft: Nov 2, 2026 to Nov 12, 2026/ });
    // The panel stays, and Save draft keeps the focus through the timeline read again.
    const again = screen.getByRole('complementary', { name: 'Days of SHOP-2' });
    expect(within(again).getByRole('button', { name: 'Save draft' })).toHaveFocus();
    await user.click(within(again).getByRole('button', { name: 'Undo this draft' }));
    await screen.findByText('The draft of SHOP-2 in Faster is undone.');
    expect(scenarios.writes.at(-1)).toEqual([{ ticketId: 2, dueDate: '2026-11-10' }]);
    expect(
      await screen.findByRole('button', { name: 'SHOP-2: Nov 2, 2026 to Nov 10, 2026' }),
    ).toBeVisible();
    // Undo goes with the draft: Save, beside it, takes the focus, and the fields hold the days now.
    await waitFor(() =>
      expect(within(again).getByRole('button', { name: 'Save draft' })).toHaveFocus(),
    );
    expect(within(again).getByLabelText('Due date')).toHaveValue('2026-11-10');
  });

  it('[PLN-012] keeps the side panel, and focus on Save dates, when the live Timeline is read again after a save', async () => {
    const user = userEvent.setup();
    const { plans } = renderInScenario('timeline', '#/plans/12/timeline');
    await user.click(await screen.findByRole('button', { name: /^SHOP-2: / }));
    const panel = screen.getByRole('complementary', { name: 'Days of SHOP-2' });
    await user.clear(within(panel).getByLabelText('Due date'));
    await user.type(within(panel).getByLabelText('Due date'), '2026-11-13');
    await user.click(within(panel).getByRole('button', { name: 'Save dates' }));
    await screen.findByRole('button', { name: 'SHOP-2: Nov 2, 2026 to Nov 13, 2026' });
    expect(liveOf(plans, 'SHOP-2')?.due).toBe('2026-11-13');
    expect(within(panel).getByRole('button', { name: 'Save dates' })).toHaveFocus();
    expect(within(panel).getByLabelText('Due date')).toHaveValue('2026-11-13');
  });

  it('[PLN-002] refuses a draft for someone who may not draft, in words', async () => {
    renderInScenario('timeline', '#/plans/12/timeline?scenario=2', { editable: false });
    const ops = await screen.findByRole('button', { name: /^OPS-4: / });
    fireEvent.keyDown(ops, { key: 'ArrowRight', altKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(/^OPS-4 was not drafted/);
  });

  it('[PLN-002] begins a drafted ticket’s calendar entry with "Draft" and makes a move a draft', async () => {
    const { plans } = renderInScenario('calendar', '#/plans/12/calendar?scenario=2');
    const chip = await screen.findByRole('link', {
      name: 'Draft SHOP-2 Build the shop page, due this day',
    });
    expect(chip).toHaveTextContent(/^Draft SHOP-2/);
    const ops = screen.getByRole('link', { name: 'OPS-4 Scale the servers, due this day' });
    fireEvent.keyDown(ops, { key: 'ArrowRight', altKey: true });
    expect(
      await screen.findByText(/^Draft: OPS-4 due .*19.* in Faster\. Nothing changed yet\.$/),
    ).toBeInTheDocument();
    expect(liveOf(plans, 'OPS-4')?.due).toBe('2026-11-18');
  });

  it('[PLN-002] keeps the List live in a scenario: it says so and edits nothing in place', async () => {
    renderInScenario('list', '#/plans/12/list?scenario=2');
    expect(
      await screen.findByText(
        'The List shows tickets as they are, not drafts, and its cells cannot be edited here.',
      ),
    ).toBeVisible();
    await screen.findAllByRole('link', { name: /^SHOP-/ });
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toEqual([]);
  });

  it('[PLN-002] names the scenario on Capacity and says a count a draft touched without a link', async () => {
    const user = userEvent.setup();
    const touched = (plans: ReturnType<typeof fakePlanClient>) => ({
      ...plans,
      capacity: async (...args: Parameters<typeof plans.capacity>): Promise<PlanCapacity> => {
        const answer = await plans.capacity(...args);
        if (args[4] === undefined) return answer;
        // As the server says it: SHOP-2's draft moved it within Ana's first period, so nothing
        // there is touched; Web's first cell is, by one draft, for this test.
        const [team] = answer.teams;
        if (!team) return answer;
        const [first, ...rest] = team.cells;
        return first
          ? {
              ...answer,
              teams: [
                { ...team, cells: [{ ...first, drafts: 1 }, ...rest] },
                ...answer.teams.slice(1),
              ],
            }
          : answer;
      },
    });
    renderInScenario('capacity', '#/plans/12/capacity?scenario=2', {}, touched);
    expect(await screen.findByRole('heading', { name: /, in Faster$/ })).toBeVisible();
    const region = screen.getByRole('region', { name: 'Capacity by period' });
    const web = within(region)
      .getAllByRole('row')
      .find((r) => r.textContent?.startsWith('Web'));
    if (!web) throw new Error('Web’s row');
    const [firstCell] = within(web).getAllByRole('cell');
    expect(within(firstCell as HTMLElement).getByText('With 1 draft change')).toBeVisible();
    expect(within(firstCell as HTMLElement).queryByRole('link')).toBeNull();
    // Other counts still link to their searches.
    expect(within(region).getAllByRole('link').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Set capacity of Web' }));
    expect(
      await screen.findByText(
        'Capacity is the plan’s own, not a draft: it applies live and in every scenario.',
      ),
    ).toBeVisible();
  });

  it('[PLN-002] says Summary and Releases stay live in a scenario', async () => {
    renderInScenario('summary', '#/plans/12?scenario=2');
    await waitFor(() =>
      expect(screen.getByText('This tab shows tickets as they are, not drafts.')).toBeVisible(),
    );
  });
});
