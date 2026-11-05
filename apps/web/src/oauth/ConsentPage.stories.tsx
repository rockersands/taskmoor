import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ConsentPage } from './ConsentPage';
import { failingLoad, fakeConsentClient, SAMPLE_REQUEST } from './fixtures';

/** The page reads its request id from the hash; each story sets one first. */
const meta = {
  title: 'OAuth/ConsentPage',
  component: ConsentPage,
  args: { client: fakeConsentClient() },
  decorators: [
    (Story) => {
      window.location.hash = '#/oauth/consent?request=story-request-0123456789abcdef';
      return <Story />;
    },
  ],
} satisfies Meta<typeof ConsentPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadAndWrite: Story = {};

export const ReadOnlySite: Story = {
  args: {
    client: fakeConsentClient(
      {},
      { ...SAMPLE_REQUEST, scope: 'read', redirectUri: 'https://assistant.example.com/cb' },
    ),
  },
};

export const Expired: Story = { args: { client: fakeConsentClient({ load: failingLoad(404) }) } };

export const SignedOut: Story = { args: { client: fakeConsentClient({ load: failingLoad(401) }) } };

export const Allows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Allow' }));
    await expect(await canvas.findByText('Sending you back to the app…')).toBeVisible();
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Allow' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
