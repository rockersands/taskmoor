import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeSavedSearchClient } from './fixtures';
import { SavedSearchBar } from './SavedSearchBar';

const client = fakeSavedSearchClient();

const meta = {
  title: 'Search/SavedSearchBar',
  component: SavedSearchBar,
  args: {
    client,
    query: 'track = SHOP AND priority = High',
    columns: ['summary', 'status'],
    opened: null,
    onOpen: fn(),
    onSaved: fn(),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SavedSearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No saved search yet: what one is and how to make the first. */
export const NoneYet: Story = {
  args: { client: fakeSavedSearchClient([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No saved searches yet')).toBeVisible();
  },
};

/** Nothing open yet: the saved searches the person sees, and saving the query as new. */
export const NothingOpen: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('combobox', { name: 'Saved searches you can see' });
    await expect(
      await within(list).findByRole('option', { name: 'Shop releases (by Ada Admin)' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(list, '1');
    await userEvent.click(canvas.getByRole('button', { name: 'Open' }));
    await expect(args.onOpen).toHaveBeenCalled();
  },
};

/**
 * Starred and subscribed (PL-32): both buttons filled in the accent, with a filled star and a tick,
 * so the state reads apart from the plain ✉ Subscribe and ☆ Star of a search that is neither.
 */
export const StarredAndSubscribed: Story = {
  args: {
    client: { ...client, subscribedTo: async () => true },
    opened: client.saved[0] ?? null,
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const subscribed = await canvas.findByRole('button', { name: 'Subscribed' });
    const star = canvas.getByRole('button', { name: 'Star' });
    const share = canvas.getByRole('button', { name: 'Share' });
    for (const on of [subscribed, star]) {
      await expect(on).toHaveAttribute('aria-pressed', 'true');
      await expect(getComputedStyle(on).backgroundColor).not.toBe(
        getComputedStyle(share).backgroundColor,
      );
    }
    await expect(star).toHaveTextContent('★');
    await expect(subscribed).toHaveTextContent('✓');
  },
};

/** One of the person's own open: save into it, share it, subscribe, star. */
export const OwnOpen: Story = {
  args: { opened: client.saved[0] ?? null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Share' }));
    await userEvent.click(canvas.getByRole('radio', { name: 'Everyone signed in' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save sharing' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Everyone signed in sees My open work now.',
    );
  },
};

/** Somebody else's shared one: subscribe and star, but not save or share. */
export const SharedWithMe: Story = {
  args: { opened: client.saved[1] ?? null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Share' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Subscribe' }));
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'How often' }), 'weekly');
    await expect(canvas.getByRole('combobox', { name: 'On' })).toBeVisible();
  },
};

/** One an import could not translate (M1-094): it says why, and how to fix it. */
export const FromAnImport: Story = {
  args: {
    opened: {
      ...(client.saved[0] as NonNullable<(typeof client.saved)[0]>),
      name: 'Sub-tasks of the shop',
      query: 'issueFunction in subtasksOf("project = SHOP")',
      importProblem: 'No field "issueFunction"',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('note')).toHaveTextContent('No field "issueFunction"');
  },
};
