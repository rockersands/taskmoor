import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { KALO } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';
import { ProgramBoardsPage } from './ProgramBoardsPage';
import { fakeBoardClient } from './programBoardFixtures';

/**
 * The plan pages as the third page sweep left them (T-316): the faults S3-PL-1 to S3-PL-11 that a
 * real browser can measure, each in its own story.
 */
const search = fakeListSearch();

const inSpanish = (Story: () => ReactElement) => (
  <I18nProvider locale="es">
    <Story />
  </I18nProvider>
);
/** About the width a plan's page has at 1280 px, the sidebar beside it. */
const atLaptopWidth = (Story: () => ReactElement) => (
  <div style={{ width: 960 }}>
    <Story />
  </div>
);
const atPhoneWidth = (Story: () => ReactElement) => (
  <div style={{ width: 360 }}>
    <Story />
  </div>
);
const top = (element: Element | null | undefined) =>
  Math.round(element?.getBoundingClientRect().top ?? Number.NaN);

const meta = {
  title: 'Plans/PlanPage after the third sweep',
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

/**
 * S3-PL-1: the Spanish tabs at a laptop's width wrap to a second line, so Configuración shows whole
 * and nothing hides past the bar's edge, with no fade to say so.
 */
export const SpanishTabsAtALaptopsWidth: Story = {
  decorators: [atLaptopWidth, inSpanish],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await canvas.findByRole('navigation', { name: /Spring launch/ });
    const last = within(bar).getByRole('link', { name: 'Configuración' });
    await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
    await expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(
      bar.getBoundingClientRect().right + 0.5,
    );
    await waitFor(() => expect(bar).toHaveAttribute('data-more', 'none'));
  },
};

/** PL-17 still holds: in a phone's narrow bar the tabs stay one strip that scrolls and fades. */
export const TabsStayOneStripOnAPhone: Story = {
  decorators: [atPhoneWidth, inSpanish],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await canvas.findByRole('navigation', { name: /Spring launch/ });
    await waitFor(() => expect(bar).toHaveAttribute('data-more', 'end'));
    const tops = within(bar)
      .getAllByRole('link')
      .map((link) => top(link));
    await expect(new Set(tops).size).toBe(1);
  },
};

/**
 * S3-PL-2: on a phone the scenario bar is one line, its label beside its select, and Live's
 * sentence is the select's description only; the share buttons leave no empty line under them.
 */
export const CompactBarsOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(window.innerWidth).toBeLessThan(768);
    const select = await canvas.findByRole('combobox', { name: 'Scenario' });
    await expect(select).toHaveAccessibleDescription('Changes you make here change tickets now.');
    const label = canvasElement.querySelector('.scenario-bar .form-label');
    const box = select.getBoundingClientRect();
    const middle = label
      ? (label.getBoundingClientRect().top + label.getBoundingClientRect().bottom) / 2
      : 0;
    await expect(middle).toBeGreaterThan(box.top);
    await expect(middle).toBeLessThan(box.bottom);
    const sentence = canvasElement.querySelector('.scenario-bar-sentence');
    await expect(sentence?.getBoundingClientRect().height ?? 0).toBeLessThanOrEqual(1);
    const actions = canvasElement.querySelector('.page-header-actions');
    const copy = canvas.getByRole('button', { name: 'Copy link' });
    await expect(
      (actions?.getBoundingClientRect().bottom ?? 0) - copy.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(1);
  },
};

/** S3-PL-5: the plan's title has its help mark, as a track's pages do. */
export const HelpBesideTheTitle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('heading', { level: 1, name: 'Spring launch' });
    const help = canvas.getByRole('button', { name: 'What is Spring launch for?' });
    await expect(help).toBeVisible();
    await expect(title.parentElement).toContainElement(help);
  },
};

/**
 * S3-PL-6: the five numbers in Spanish at a laptop's width sit on one line, however their labels
 * wrap; at a phone's width they go two to a row and the fifth takes the row's width.
 */
export const SpanishSummaryNumbers: Story = {
  decorators: [atLaptopWidth, inSpanish],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: /tickets en este plan/ });
    const numbers = Array.from(canvasElement.querySelectorAll('.report-stats dd'));
    await expect(numbers).toHaveLength(5);
    await expect(
      new Set(numbers.map((n) => Math.round(n.getBoundingClientRect().bottom))).size,
    ).toBe(1);
  },
};

export const SummaryNumbersOnAPhone: Story = {
  decorators: [atPhoneWidth, inSpanish],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: /tickets en este plan/ });
    const stats = canvasElement.querySelector('.report-stats');
    const tiles = Array.from(canvasElement.querySelectorAll('.report-stats > div'));
    await expect(tiles).toHaveLength(5);
    const fifth = tiles[4]?.getBoundingClientRect();
    await expect(Math.round(fifth?.width ?? 0)).toBe(
      Math.round(stats?.getBoundingClientRect().width ?? -1),
    );
    await expect(top(tiles[0])).toBe(top(tiles[1]));
  },
};

/**
 * S3-PL-7: the Timeline's head, cut at the card's right edge, fades there: a strip held at the
 * edge in view, after the scale, so scrolled to the end it covers no label.
 */
export const TimelineHeadFadesAtTheCut: Story = {
  args: { section: 'timeline' },
  decorators: [atLaptopWidth],
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline';
  },
  play: async ({ canvasElement }) => {
    const head = await waitFor(() => {
      const drawn = canvasElement.querySelector('.timeline-head');
      if (!drawn) throw new Error('the Timeline draws its head');
      return drawn;
    });
    const fade = getComputedStyle(head, '::after');
    await expect(fade.position).toBe('sticky');
    await expect(fade.right).toBe('0px');
    await expect(fade.backgroundImage).toContain('linear-gradient');
    await expect(fade.pointerEvents).toBe('none');
  },
};

/** S3-PL-10: Count work in, Periods and A period starts on stand level; the hint hangs below. */
export const SettingsFieldsLevel: Story = {
  args: { section: 'settings' },
  decorators: [atLaptopWidth],
  beforeEach: () => {
    window.location.hash = '#/plans/12/settings';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const unit = await canvas.findByLabelText('Count work in');
    const period = canvas.getByLabelText('Periods');
    const anchor = canvas.getByLabelText('A period starts on');
    await expect(top(period)).toBe(top(unit));
    await expect(top(anchor)).toBe(top(unit));
  },
};

/**
 * S3-PL-8: a site administrator is told where a Team field is added, with a link there, not to
 * ask a site administrator.
 */
export const ProgramBoardsWithoutATeamFieldForAnAdmin: StoryObj<typeof ProgramBoardsPage> = {
  render: () => (
    <SessionProvider session={{ status: 'signed-in', user: { ...KALO, isSiteAdmin: true } }}>
      <ProgramBoardsPage
        planId={12}
        client={fakeBoardClient({ list: { teamFields: [], editable: true } })}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </SessionProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Open Fields' })).toHaveAttribute(
      'href',
      '#/admin/fields',
    );
    await expect(canvas.queryByText(/Ask a site administrator/)).toBeNull();
  },
};
