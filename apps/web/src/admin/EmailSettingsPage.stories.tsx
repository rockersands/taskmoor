import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { type EmailSettings, EmailSettingsPage } from './EmailSettingsPage';
import { ADMIN, CONFIG_ADMIN } from './fixtures';

const client = (settings: Partial<EmailSettings> = {}) => {
  let stored: EmailSettings = {
    batchWindowSeconds: 120,
    digestHour: 8,
    smtpConfigured: true,
    ...settings,
  };
  return {
    load: async () => ({ ...stored }),
    save: async (change: Partial<EmailSettings>) => {
      stored = { ...stored, ...change };
      return { ...stored };
    },
  };
};

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

const meta = {
  title: 'Admin/Email',
  component: EmailSettingsPage,
  args: { client: client() },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof EmailSettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A mail server is set up; changes wait two minutes and digests go out at 08:00. */
export const SetUp: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Set up')).toBeVisible();
    await expect(canvas.getByLabelText('Digest hour')).toHaveDisplayValue('08:00');
  },
};

/** No server yet: email waits unsent, and the page says how it goes out. */
export const NotSetUp: Story = {
  args: { client: client({ smtpConfigured: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Not set up')).toBeVisible();
    await expect(canvas.getByText(/^Email waits unsent/)).toBeVisible();
  },
};

/** A configuration administrator is told only that the page is not theirs. */
export const Refused: Story = {
  parameters: { session: CONFIG_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^Only site administrators/)).toBeVisible();
  },
};

/** The settings could not be read: the header stays, with the failure under it. */
export const LoadFailed: Story = {
  args: {
    client: {
      load: async () => {
        throw new Error('network');
      },
      save: async () => {
        throw new Error('network');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Save email settings' })).toBeVisible();
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
