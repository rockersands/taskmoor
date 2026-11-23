import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeToolsClient } from './fixtures';
import { LinksPanel } from './LinksPanel';

const meta = {
  title: 'Tickets/LinksPanel',
  component: LinksPanel,
  args: {
    ticket: { id: 41, key: 'SHOP-41', track: { key: 'SHOP' } },
    client: fakeToolsClient(),
    revision: 0,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 640 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof LinksPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Grouped by what they read from this side, one reaching another track. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'is blocked by' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'OPS-88' })).toBeVisible();
  },
};

/**
 * Removing the link to another track asks first, since the form cannot make it again (D13, T-267);
 * at a small phone's width the question takes the row's whole line.
 */
export const RemovingALinkToAnotherTrackOnAPhone: Story = {
  args: { client: fakeToolsClient() },
  decorators: [
    (Story) => (
      <div data-testid="phone-width" style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove the link: is blocked by OPS-88' }),
    );
    const question = canvas.getByRole('group', { name: /^OPS-88 is in another track/ });
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};

/** The form, with what was typed finding tickets of this track. */
export const Picking: Story = {
  args: { client: fakeToolsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a link' }));
    await userEvent.type(
      await canvas.findByRole('combobox', { name: 'Ticket number or name' }),
      'receipt',
    );
    await expect(await canvas.findByRole('option', { name: /SHOP-42/ })).toBeVisible();
  },
};

/** Someone who may only read. */
export const ReadOnly: Story = {
  args: { client: fakeToolsClient({ mayLink: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'SHOP-39' });
    await expect(canvas.queryByRole('button', { name: 'Add a link' })).toBeNull();
  },
};

/** No links yet. */
export const Empty: Story = {
  args: { client: fakeToolsClient({ links: [] }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No links yet.')).toBeVisible();
  },
};
