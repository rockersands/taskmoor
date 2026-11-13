import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { NotFoundPage } from './NotFoundPage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

const meta = {
  title: 'Shell/NotFoundPage',
  component: NotFoundPage,
  args: { title: 'Page not found' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof NotFoundPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An address that matches no page (D4). */
export const UnknownAddress: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Search' })).toBeVisible();
  },
};

/** A track that does not exist, or that the person may not see: the same page, its own words. */
export const Track: Story = {
  args: {
    title: 'Track not found',
    children: 'This track does not exist, or you cannot see it.',
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
