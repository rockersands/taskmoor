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

export const SavesAChoice: Story = {
  // Choosing the skin the story already renders in keeps the axe run on that skin.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = document.documentElement.dataset.skin === 'dark' ? 'Dark' : 'Light';
    await userEvent.click(canvas.getByRole('radio', { name }));
    await expect(await canvas.findByText('Appearance saved to your account.')).toBeVisible();
  },
};
