import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeSavedSearchClient, fakeSearchClient } from './fixtures';
import { SearchPage } from './SearchPage';

const meta = {
  title: 'Search/SearchPage',
  component: SearchPage,
  args: { client: fakeSearchClient(), savedClient: fakeSavedSearchClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SearchPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The basic mode, before a search. */
export const Basic: Story = {};

/** A query from the address, run, with suggestions open at the caret. */
export const Advanced: Story = {
  args: { initialQuery: 'priority = High' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const query = await canvas.findByRole('combobox', { name: 'Query' });
    await userEvent.clear(query);
    await userEvent.type(query, 'track = ');
    await expect(await canvas.findByRole('option', { name: 'SHOP' })).toBeVisible();
  },
};

/** A query the backend refuses, with the place it is wrong. */
export const WrongQuery: Story = {
  args: { initialQuery: 'nope = 1' },
};

/** Results in the person's columns, with export links. */
export const Results: Story = {
  args: { initialQuery: 'track = SHOP' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  },
};

/** A saved search opened from the address: its query, its columns and its results (M1-063). */
export const SavedSearchOpened: Story = {
  args: { initialSavedSearch: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Saved search: Shop releases' }),
    ).toBeVisible();
    await expect(await canvas.findByRole('table')).toBeVisible();
  },
};
