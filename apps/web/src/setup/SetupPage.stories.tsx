import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { SetupPage } from './SetupPage';

/** Stories render without a backend: the page shows its form and waits. */
const meta = {
  title: 'Setup/SetupPage',
  component: SetupPage,
  args: { onDone: () => {} },
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SetupPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup?token=story-token';
  },
};

export const WithoutToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup';
  },
};

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

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  beforeEach: () => {
    window.location.hash = '#/setup?token=story-token';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('form')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
