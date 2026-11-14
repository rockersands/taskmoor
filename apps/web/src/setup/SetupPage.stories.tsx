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

/**
 * One card, as on every stand-alone form (AC-16, D24): its groups are wells inside it, and
 * 'Finish setup' ends the card, inside its edges, rather than standing on the canvas below.
 */
export const FinishSetupInsideTheCard: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup?token=story-token';
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('form', { name: 'Set up Taskmoor' });
    const button = within(form).getByRole('button', { name: 'Finish setup' });
    const card = form.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(form).paddingLeft);
    await expect(padding).toBeGreaterThan(0);
    await expect(box.left).toBeGreaterThanOrEqual(card.left + padding - 0.5);
    await expect(box.right).toBeLessThanOrEqual(card.right - padding + 0.5);
    await expect(box.bottom).toBeLessThanOrEqual(card.bottom - padding + 0.5);
    // The card is the glass; the groups inside it are wells with no blur of their own.
    await expect(getComputedStyle(form).backdropFilter).not.toBe('none');
    for (const group of form.querySelectorAll('fieldset')) {
      await expect(getComputedStyle(group).backdropFilter).toBe('none');
    }
  },
};

export const WithoutToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup';
  },
  play: async ({ canvasElement }) => {
    // The same card as Unsubscribe and Consent, not flat text on the canvas.
    await expect(canvasElement.querySelector('.glass-card .page-note')).not.toBeNull();
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
