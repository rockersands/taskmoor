import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, within } from 'storybook/test';
import { type ImportedLinkLookup, ImportedLinkPage } from './ImportedLinkPage';

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

/**
 * Nothing imported matches (or the person may not see it): the not-found pattern of every other
 * page (D4, D24): its title, one line said as an alert, Home and Search, and no intro.
 */
export const Missing: Story = {
  args: { route: '#/imported/board/99', lookup: async () => null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Nothing that was imported matches this link',
    );
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Link not found');
    const waysOn = canvas.getByRole('navigation', { name: 'Ways on' });
    await expect(
      within(waysOn)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.className]),
    ).toEqual([
      ['Go to Home', 'button-primary'],
      ['Go to Search', 'button-secondary'],
    ]);
    await expect(canvas.queryByText(/now that its work was imported here/)).toBeNull();
    await expect(canvasElement.querySelector('.form-error')).toBeNull();
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

export const MissingAtPhoneWidth: Story = {
  args: { route: '#/imported/board/99', lookup: async () => null },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
