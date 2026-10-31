import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { type ImportedLinkLookup, ImportedLinkPage } from './ImportedLinkPage';

const meta = {
  title: 'Routing/ImportedLinkPage',
  component: ImportedLinkPage,
  args: {
    route: '#/imported/saved-search/10010',
    lookup: (async () => '#/search?savedSearch=41') as ImportedLinkLookup,
    onFound: fn(),
  },
} satisfies Meta<typeof ImportedLinkPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An old filter link the import mapped: it goes to the saved search. */
export const Found: Story = {
  play: async ({ args }) => {
    await expect(args.onFound).toHaveBeenCalledWith('#/search?savedSearch=41');
  },
};

/** A link of the earlier tracker itself, as a static host hands it over: no lookup needed. */
export const IssueLink: Story = {
  args: { route: '#/browse/ABC-42?focusedCommentId=10101' },
  play: async ({ args }) => {
    await expect(args.onFound).toHaveBeenCalledWith('#/tickets/ABC-42');
  },
};

/** Nothing imported matches (or the person may not see it). */
export const Missing: Story = {
  args: { route: '#/imported/board/99', lookup: async () => null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Nothing that was imported matches this link',
    );
    await expect(canvas.getByRole('link', { name: 'Go to search' })).toBeVisible();
  },
};

/** The lookup failed: it says so. */
export const Failed: Story = {
  args: {
    lookup: async () => {
      throw new Error('offline');
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(
      'could not be looked up',
    );
  },
};
