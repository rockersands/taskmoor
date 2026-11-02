import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { fakePersonalDataClient, SIGNED_IN } from './fixtures';
import { PersonalDataSection } from './PersonalDataSection';

const meta = {
  title: 'Account/PersonalDataSection',
  component: PersonalDataSection,
  args: { client: fakePersonalDataClient(), timeZone: null, pollMs: 50 },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PersonalDataSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One download ready, one expired. */
export const ReadyAndExpired: Story = {};

/** Asking for a new one: it is prepared, then offered. */
export const Asking: Story = {
  args: { client: fakePersonalDataClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Prepare a download' }));
    await expect(await canvas.findByText(/being prepared/)).toBeVisible();
    await expect(
      await canvas.findByRole('link', { name: /Download the data asked for .*2026/ }),
    ).toBeVisible();
  },
};

/** Someone else's data, as a site administrator sees it on the People page. */
export const SomeoneElse: Story = { args: { client: fakePersonalDataClient('Bo Rivera') } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
