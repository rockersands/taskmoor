import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { expectWithinBudget } from '../test/budget';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePlanClient, manyPlanItems } from './fixtures';
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

/** A plan that cannot be found still has its page: a title, what the section is for, a way back. */
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
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1, name: 'Multi-track' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'All plans' })).toBeVisible();
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
