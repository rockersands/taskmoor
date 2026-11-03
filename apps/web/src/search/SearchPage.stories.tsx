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

/** Every kind of filter on the basic form, from a query in the address (QRY-014, QRY-006). */
export const BasicWithFilters: Story = {
  args: {
    initialQuery:
      'type IN (Bug, Story) AND priority = High AND labels = refunds AND requester = currentUser() AND targetRelease = "1.0" AND created >= 2026-10-01 AND created < 2026-11-01 AND due < 2026-12-01 ORDER BY updated DESC',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('group', { name: 'Date created' })).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Due date' })).toBeVisible();
    await expect(await canvas.findByRole('checkbox', { name: 'Bug' })).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Remove refunds from Labels' })).toBeVisible();
  },
};

/** Adding a date filter with "Add a filter", between two days. */
export const AddADateFilter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Add a filter' }), 'closed');
    await userEvent.click(canvas.getByRole('button', { name: 'Add filter' }));
    const group = within(canvas.getByRole('group', { name: 'Date closed' }));
    await expect(group.getByRole('combobox', { name: 'When' })).toHaveFocus();
    await userEvent.selectOptions(group.getByRole('combobox', { name: 'When' }), 'between');
    await expect(group.getByLabelText('To')).toBeVisible();
  },
};

/** A query from the address, run, with suggestions open at the caret. */
export const Advanced: Story = {
  args: { initialQuery: 'status = Active' },
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
