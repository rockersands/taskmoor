import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { AppearanceSection } from './AppearanceSection';
import { fakeAccountClient, KALO } from './fixtures';

/** Stories save to an in-memory account; a choice repaints the page in that skin. */
const meta = {
  title: 'Account/AppearanceSection',
  component: AppearanceSection,
  args: { client: fakeAccountClient(), user: { ...KALO, appearance: 'system' } },
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'signed-in', user: KALO }}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AppearanceSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FollowsTheDevice: Story = {};

/**
 * An unselected radio looks the same on every card, in either skin: it sits on the card's own
 * fill beside the name, under the miniature. Drawn over the miniature it showed the preview's
 * colours around it, a hollow ring on the dark preview and a solid disc on the light one, even
 * on a chip of its own (the third sweep).
 */
export const RadiosLookAlikeOnEveryPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const off = ['Light', 'Dark'].map((name) => canvas.getByRole('radio', { name }));
    for (const radio of off) await expect(radio).not.toBeChecked();
    for (const radio of [...off, canvas.getByRole('radio', { name: 'System' })]) {
      const card = radio.closest('.appearance-option') as HTMLElement;
      const preview = (card.querySelector('.skin-preview') as HTMLElement).getBoundingClientRect();
      const dot = radio.getBoundingClientRect();
      // Below the miniature, beside the name.
      await expect(dot.top).toBeGreaterThanOrEqual(preview.bottom);
      const name = card.querySelector('.appearance-name') as HTMLElement;
      await expect(dot.right).toBeLessThanOrEqual(name.getBoundingClientRect().left);
    }
  },
};

export const SavesAChoice: Story = {
  // Choosing the skin the story already renders in keeps the axe run on that skin.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = document.documentElement.dataset.skin === 'dark' ? 'Dark' : 'Light';
    await userEvent.click(canvas.getByRole('radio', { name }));
    await expect(await canvas.findByText('Appearance saved to your account.')).toBeVisible();
  },
};
