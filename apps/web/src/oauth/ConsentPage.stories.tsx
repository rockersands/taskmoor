import type { Meta, StoryObj } from '@storybook/react-vite';
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
