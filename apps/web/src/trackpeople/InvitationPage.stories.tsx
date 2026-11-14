import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { fakeInvitationClient } from './fixtures';
import { InvitationPage } from './InvitationPage';

/** Where an invitation link lands, at a desktop's width (the page's other stories are with Track people). */
const meta = {
  title: 'Track people/InvitationPage',
  component: InvitationPage,
  args: { client: fakeInvitationClient() },
  beforeEach: () => {
    window.sessionStorage.clear();
    window.location.hash = '#/invite?token=story-token';
  },
  decorators: [
    (Story) => (
      // A desktop's column, whatever the test window's width: the stand-alone 40 rem fits.
      <div style={{ width: 1000 }}>
        <SessionProvider session={{ status: 'anonymous' }}>
          <Story />
        </SessionProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof InvitationPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The new person's form fills its card (AC-16, D24): the name and password fields and Continue
 * span the card's inside, as the choice above them does, rather than Account's reading width.
 */
export const FormFillsItsCard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByLabelText('Your name');
    const card = name.closest('.glass-card') as HTMLElement;
    const style = getComputedStyle(card);
    const inside = {
      left: card.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft),
      right: card.getBoundingClientRect().right - Number.parseFloat(style.paddingRight),
    };
    await expect(inside.right - inside.left).toBeGreaterThan(560);
    for (const control of [name, canvas.getByRole('button', { name: 'Continue' })]) {
      const box = control.getBoundingClientRect();
      await expect(Math.abs(box.left - inside.left)).toBeLessThanOrEqual(1.5);
      await expect(Math.abs(box.right - inside.right)).toBeLessThanOrEqual(1.5);
    }
  },
};
