import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeListClient, fakeListSearch } from './fixtures';
import { ListPage } from './ListPage';

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

const search = fakeListSearch();
const meta = {
  title: 'Views/ListPage',
  component: ListPage,
  args: { trackKey: 'SHOP', search, client: fakeListClient(search) },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ListPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A track's tickets in the person's columns, with the format rules panel. */
export const List: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'SHOP-41' })).toBeVisible();
  },
};

/** Grouped by priority, each group with its count, and a rule colouring new tickets. */
export const GroupedWithRules: Story = {
  play: async ({ canvasElement }) => {
    window.localStorage.setItem(
      'taskmoor.list.rules.SHOP',
      JSON.stringify([
        { id: 'r1', name: 'Untouched', query: 'stage = new', target: 'row', tone: 'amber' },
      ]),
    );
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'Group by' }),
      'Priority',
    );
    await expect(await canvas.findByRole('heading', { name: 'High (1 ticket)' })).toBeVisible();
  },
};

/** At a phone's width: the table scrolls inside its own glass, the page never sideways. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'SHOP-41' })).toBeVisible();
    await expect(canvas.getByText(/^This track’s tickets as rows/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A track with no tickets, or a filter that finds none: what would be here and how it gets here. */
export const NoTickets: Story = {
  args: { search: { ...search, search: async () => ({ tickets: [], next: null }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No tickets.')).toBeVisible();
    await expect(canvas.getByText(/^Tickets of this track show here/)).toBeVisible();
  },
};

/** A track that is not there, or not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeListClient(search),
      track: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'List', level: 1 })).toBeVisible();
  },
};

/** A finger reaches each ticket's key and the buttons of Columns and Format rules (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: 'SHOP-41' });
    await expect(
      tooSmallForAFinger(canvasElement, ['.search-key a', '.list-panels .filter-chip']),
    ).toEqual([]);
  },
};
