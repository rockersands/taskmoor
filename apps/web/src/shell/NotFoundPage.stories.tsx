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

/** Where a label's line box sits inside its pill, and whether it is underlined. */
const labelIn = (link: HTMLElement) => {
  const words = document.createRange();
  words.selectNodeContents(link);
  const text = words.getBoundingClientRect();
  const pill = link.getBoundingClientRect();
  return {
    offCentre: Math.abs(text.top + text.height / 2 - (pill.top + pill.height / 2)),
    underlined: getComputedStyle(link).textDecorationLine !== 'none',
  };
};

/**
 * D4: both ways on read as buttons, links though they are: each label centred in its pill and not
 * underlined, the primary 'Go to Home' as well as 'Go to Search'.
 */
export const WaysOnReadAsButtons: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ['Go to Home', 'Go to Search']) {
      const link = canvas.getByRole('link', { name });
      const label = labelIn(link);
      await expect({ name, ...label, offCentre: label.offCentre < 1.5 }).toEqual({
        name,
        offCentre: true,
        underlined: false,
      });
    }
    const [home, search] = ['Go to Home', 'Go to Search'].map((name) =>
      canvas.getByRole('link', { name }).getBoundingClientRect(),
    );
    await expect(Math.abs((home?.height ?? 0) - (search?.height ?? 0))).toBeLessThan(1);
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
