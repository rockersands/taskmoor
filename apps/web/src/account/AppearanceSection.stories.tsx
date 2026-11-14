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

/** Whether a colour as the browser writes it lets anything through. */
const opaque = (colour: string) => {
  // rgb(r, g, b) has three numbers; a fourth, in rgba() or after a slash, is the alpha.
  const alpha = colour.match(/[\d.]+/g)?.[3];
  return alpha === undefined || Number(alpha) === 1;
};

/**
 * An unselected radio looks the same on every card, in either skin: it sits on its own solid chip
 * over the miniature, so a light preview and a dark one no longer show through it as a hollow
 * ring on one card and a grey disc on the other.
 */
export const RadiosLookAlikeOnEveryPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const off = ['Light', 'Dark'].map((name) => canvas.getByRole('radio', { name }));
    for (const radio of off) await expect(radio).not.toBeChecked();
    const drawn = off.map((radio) => {
      const style = getComputedStyle(radio);
      return { fill: style.backgroundColor, edge: style.borderTopColor, chip: style.boxShadow };
    });
    await expect(drawn[0]).toEqual(drawn[1]);
    await expect(opaque(drawn[0]?.fill ?? '')).toBe(true);
    await expect(drawn[0]?.chip).not.toBe('none');
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
