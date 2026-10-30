import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeListClient, fakeListSearch } from './fixtures';
import { ListPage } from './ListPage';

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
