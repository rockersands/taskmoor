import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { fakeAccountClient, KALO, SIGNED_IN } from './fixtures';
import { ProfileSection } from './ProfileSection';

const meta = {
  title: 'Account/ProfileSection',
  component: ProfileSection,
  args: { user: KALO, client: fakeAccountClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ProfileSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Automatic: Story = {};

export const ChosenZoneAndLocale: Story = {
  args: { user: { ...KALO, timeZone: 'Europe/Lisbon', locale: 'pt-PT' } },
};

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText('Time zone'), 'Europe/Madrid');
    await userEvent.click(canvas.getByRole('button', { name: 'Save profile' }));
    await expect(await canvas.findByText('Profile saved.')).toBeVisible();
  },
};

export const Refused: Story = {
  args: {
    client: fakeAccountClient({
      updateProfile: async () => {
        throw new ApiError(400, { error: 'invalid_locale' });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save profile' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};
