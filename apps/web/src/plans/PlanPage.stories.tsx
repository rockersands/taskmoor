import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { expectWithinBudget } from '../test/budget';
import { asOnATouchScreen, notSized, onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import type { PlanTimelineItem } from './client';
import { fakePlanClient, manyPlanItems, planItems } from './fixtures';
import { PlanPage } from './PlanPage';

const search = fakeListSearch();

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

const meta = {
  title: 'Plans/PlanPage',
  component: PlanPage,
  args: {
    id: 12,
    section: 'summary',
    client: fakePlanClient(),
    search,
    list: fakeListClient(search),
    now: () => new Date('2026-11-04T09:00:00Z'),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
  beforeEach: () => {
    window.location.hash = '#/plans/12';
  },
} satisfies Meta<typeof PlanPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Summary: every number links to the search that finds those tickets. */
export const Summary: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: '5 tickets in this plan' })).toBeVisible();
  },
};

/** PL-37: room between the numbers and the cards, and each card only as tall as its list. */
export const SummaryKeepsItsParts: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: '5 tickets in this plan' });
    const stats = canvasElement.querySelector('.report-stats')?.getBoundingClientRect();
    const cards = canvasElement.querySelector<HTMLElement>('.summary-sections');
    if (!stats || !cards) throw new Error('the Summary draws its numbers and cards');
    await expect(cards.getBoundingClientRect().top - stats.bottom).toBeGreaterThanOrEqual(8);
    await expect(getComputedStyle(cards).alignItems).toBe('start');
  },
};

/** The Summary at a phone's width: the header, tabs, numbers and sections stay inside. */
export const SummaryAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: '5 tickets in this plan' })).toBeVisible();
    await expect(canvas.getByText(/^The work of this plan/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * On a phone more tabs wait past the bar's right edge (PL-17; PLN-012): that edge fades, as a
 * track's tab bar does, so the cut tab reads as "more this way".
 */
export const TabBarFadesOnAPhone: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await canvas.findByRole('navigation', { name: 'Sections of Spring launch' });
    await waitFor(() => expect(bar).toHaveAttribute('data-more', 'end'));
    await expect(getComputedStyle(bar).maskImage).toContain('linear-gradient');
  },
};

/** The Timeline across two tracks, grouped by track, Ana's tickets only. */
export const TimelineByTrack: Story = {
  args: { section: 'timeline' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline?assignee=me&group=track';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('SHOP · Shop (1)')).toBeVisible();
  },
};

/**
 * Dependencies (PLN-006): SHOP-2 blocks SHOP-3, which starts before SHOP-2 ends, so its badge is
 * red and says "late"; OPS-4 counts two blockers outside the plan; the list below says the same.
 */
export const TimelineDependencies: Story = {
  args: { section: 'timeline' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('1 · late')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Dependencies' })).toBeVisible();
    await expect(canvas.getByText('2 tickets outside this plan')).toBeVisible();
    await expect(canvas.getByText('3 tickets have blockers; 1 dependency is late.')).toBeVisible();
  },
};

/** SHOP-9, all of it long before the days in view: its row has an "Earlier" marker. */
const earlyItem = (): PlanTimelineItem => ({
  id: 9,
  key: 'SHOP-9',
  summary: 'Pick the payment provider',
  type: 'Feature',
  level: { rank: 0, kind: 'standard' },
  parentId: null,
  status: { name: 'Closed', stage: 'closed' },
  start: '2026-03-02',
  due: '2026-03-06',
  dated: 'own',
  rollup: null,
  trackId: 1,
  assignee: null,
  priority: 'Medium',
});

/**
 * The "Earlier" marker of a ticket before the days in view is opaque (PLN-012; PL-6): today's
 * line, which runs under the rows, never shows through its words on a phone (the second sweep's
 * plan-timeline--375--dark).
 */
export const TimelineEdgeOverTodaysLine: Story = {
  args: { section: 'timeline', client: fakePlanClient({ items: [...planItems(), earlyItem()] }) },
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline';
    return onARealTouchScreen();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const edge = await canvas.findByRole('button', { name: /^Earlier: SHOP-9 ends/ });
    await expect(canvasElement.querySelector('.timeline-today')).not.toBeNull();
    // An opaque fill: the browser writes a colour with any transparency as rgba().
    await expect(getComputedStyle(edge).backgroundColor).toMatch(/^rgb\(/);
  },
};

/** The List as a search, grouped by track. */
export const ListByTrack: Story = {
  args: { section: 'list' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/list?group=track';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'SHOP (2 tickets)' })).toBeVisible();
  },
};

/** The Calendar of November across tracks. */
export const Calendar: Story = {
  args: { section: 'calendar' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/calendar';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'OPS-4 Scale the servers, due this day' }),
    ).toBeVisible();
  },
};

/**
 * The Calendar on a phone's touch screen (PLN-012, ADR-033): a ticket's chip keeps a finger's
 * height beside its grip, and its words sit in the middle of it, not at its top (the second
 * sweep's plan-calendar--375).
 */
export const CalendarChipsOnATouchScreen: Story = {
  args: { section: 'calendar' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/calendar';
    return onARealTouchScreen();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'OPS-4 Scale the servers, due this day' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.calendar-entry .calendar-chip',
        '.calendar-grip button',
      ]),
    ).toEqual([]);
    const off: string[] = [];
    for (const chip of canvasElement.querySelectorAll<HTMLElement>(
      '.calendar-entry .calendar-chip',
    )) {
      const words = document.createRange();
      words.selectNodeContents(chip);
      const text = words.getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      const by = text.top + text.height / 2 - (box.top + box.height / 2);
      if (Math.abs(by) > 2) off.push(`${chip.textContent}: ${Math.round(by)} px from the middle`);
    }
    await expect(off).toEqual([]);
  },
};

/**
 * Capacity (PLN-005, PLN-009): Web and its people by two-week period, in points. Ana is over in
 * both periods shown first (13 points elsewhere, then leave), in red and in words.
 */
export const Capacity: Story = {
  args: { section: 'capacity', client: fakePlanClient() },
  beforeEach: () => {
    window.location.hash = '#/plans/12/capacity';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Capacity by period' })).toBeVisible();
    await expect(canvas.getByText('Over capacity by 8 points')).toBeVisible();
    // Web's and Ana's: counted, never named.
    await expect(canvas.getAllByText('+13 points in 1 ticket elsewhere')).toHaveLength(2);
    // PL-2: the "Open, no due date" column shows whole inside the card (D32).
    const card = canvas.getByRole('region', { name: 'Capacity by period' }).getBoundingClientRect();
    const open = canvas.getByRole('columnheader', { name: 'Open, no due date' });
    await expect(open.getBoundingClientRect().right).toBeLessThanOrEqual(card.right + 0.5);
  },
};

/** Capacity on a phone: a card per team and person, no sideways scroll. */
export const CapacityOnAPhone: Story = {
  args: { section: 'capacity', client: fakePlanClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: () => {
    window.location.hash = '#/plans/12/capacity';
  },
  play: async ({ canvasElement }) => {
    // The e2e spec checks the cards and the scroll at a phone's width; here, the content.
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Over capacity by 8 points')).toBeVisible();
  },
};

/** Capacity in a plan with no teams yet: where to choose them. */
export const CapacityWithoutTeams: Story = {
  args: { section: 'capacity', client: fakePlanClient({ noTeams: true }) },
  beforeEach: () => {
    window.location.hash = '#/plans/12/capacity';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('This plan has no teams yet.')).toBeVisible();
  },
};

/** Settings: name, description, sources and who sees it. */
export const Settings: Story = {
  args: { section: 'settings' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/settings';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox', { name: 'DATA · Data' })).toBeVisible();
    // Teams and capacity (PLN-005): the site's teams, the unit and the periods.
    await expect(await canvas.findByRole('checkbox', { name: 'Web (2 people)' })).toBeChecked();
    await expect(canvas.getByLabelText('Count work in')).toHaveValue('points');
  },
};

/**
 * Settings at a phone's width on a touch screen, a new unit about to be saved and Delete plan
 * pressed: each asks in its own place what goes (D13), its answers wrapping and big enough for a
 * finger (ADR-033), nothing sticking out.
 */
export const SettingsAskingOnAPhone: Story = {
  args: { section: 'settings', client: fakePlanClient() },
  decorators: [atPhoneWidth],
  beforeEach: () => {
    window.location.hash = '#/plans/12/settings';
    return asOnATouchScreen();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const unit = await canvas.findByLabelText('Count work in');
    await userEvent.selectOptions(unit, 'hours');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Delete plan' }));
    await expect(
      canvas.getByRole('group', {
        name: 'Change the unit? Every capacity set in this plan will be cleared.',
      }),
    ).toBeVisible();
    await expect(canvas.getByRole('group', { name: /Delete the plan/ })).toBeVisible();
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.danger-confirm .button-danger',
        '.danger-confirm .button-secondary',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

/**
 * Settings on a phone's touch screen (PLN-001, ADR-033): every check box is the shared 28 px square,
 * as on Search, and its row with the label takes the finger (the second sweep's
 * plan-settings--375: the boxes were 28 x 44).
 */
export const SettingsBoxesOnATouchScreen: Story = {
  args: { section: 'settings' },
  beforeEach: () => {
    window.location.hash = '#/plans/12/settings';
    return onARealTouchScreen();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'DATA · Data' });
    await canvas.findByRole('checkbox', { name: 'Web (2 people)' });
    await expect(notSized(canvasElement, '.plan-settings input[type="checkbox"]', 28)).toEqual([]);
    await expect(
      tooSmallForAFinger(canvasElement, ['.plan-settings .form-field-inline label']),
    ).toEqual([]);
  },
};

/** Some sources are hidden from the viewer, and a saved search no longer runs. */
export const HiddenSources: Story = {
  args: { client: fakePlanClient({ hidden: 2, editable: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        '2 sources of this plan are hidden from you, so they add nothing here.',
      ),
    ).toBeVisible();
  },
};

/** The viewer may see none of its sources: it finds nothing for them. */
export const NothingVisible: Story = {
  args: { section: 'timeline', client: fakePlanClient({ hidden: 'all', editable: false }) },
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'You cannot see any of this plan’s sources, so it shows nothing for you.',
      ),
    ).toBeVisible();
  },
};

/** When the timeline arrived, for the render budget below. */
const arrival = { at: 0 };

/**
 * The render budget (PLN-012): a plan's 10,000 listed tickets on the Timeline, drawn within
 * 1.5 s of their arrival; only the rows in view are drawn. Axe is off here only: it would time
 * the checks, not the timeline.
 */
export const TenThousandTickets: Story = {
  args: {
    section: 'timeline',
    client: (() => {
      const inner = fakePlanClient({ items: manyPlanItems(10_000) });
      return {
        ...inner,
        timeline: async (id: number, filters: Parameters<typeof inner.timeline>[1]) => {
          const data = await inner.timeline(id, filters);
          arrival.at = performance.now();
          return data;
        },
      };
    })(),
  },
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline';
  },
  parameters: { a11y: { test: 'off' } },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => expect(canvasElement.querySelectorAll('.timeline-row').length).toBeGreaterThan(10),
      { timeout: 10_000, interval: 10 },
    );
    const took = performance.now() - arrival.at;
    await expect(canvasElement.querySelectorAll('.timeline-row').length).toBeLessThan(200);
    await expectWithinBudget(took, 1500, '10,000 plan timeline rows on screen (ms)');
  },
};

/** A plan that cannot be found gets the shared not-found page (D4): Home and Search. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakePlanClient(),
      get: async () => {
        throw new ApiError(404, { error: 'not_found' });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The shared not-found page (D4): its own title, what happened, and the two ways on.
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'This plan does not exist, or you cannot see it.',
    );
    await expect(canvas.getByRole('heading', { level: 1, name: 'Plan not found' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Search' })).toBeVisible();
  },
};

/** The Releases tab: linked releases gathered under theirs, then the rest by track. */
export const Releases: Story = {
  args: { section: 'releases' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Launch across tracks' })).toBeVisible();
    await expect(canvas.getByText('Out of step')).toBeVisible();
  },
};

/** A finger reaches a group's heading and each release on the Releases tab (ADR-033). */
export const ReleasesOnATouchScreen: Story = {
  args: { section: 'releases' },
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('region', { name: 'Launch across tracks' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.cross-track-group-head h2 a',
        '.plan-releases .release-name',
      ]),
    ).toEqual([]);
  },
};

/** The Releases tab at a phone's width: each group is a card, nothing sticking out. */
export const ReleasesAtPhoneWidth: Story = {
  args: { section: 'releases' },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Launch across tracks' });
    await fitsPhoneWidth(canvas);
  },
};
