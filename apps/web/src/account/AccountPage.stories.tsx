import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { fakeNotificationsClient } from '../notifications/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePersonalTokensClient } from '../tokens/fixtures';
import { AccountPage } from './AccountPage';
import { fakeAccountClient, fakePersonalDataClient, SIGNED_IN, sampleSessions } from './fixtures';

/** Stories pass an in-memory account backend; nothing calls a server. */
const meta = {
  title: 'Account/AccountPage',
  component: AccountPage,
  args: {
    client: fakeAccountClient(),
    tokens: fakePersonalTokensClient(),
    notifications: fakeNotificationsClient(),
    personalData: fakePersonalDataClient(),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AccountPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSessions: Story = { args: { section: 'security' } };

export const OnlyThisDevice: Story = {
  args: {
    section: 'security',
    client: fakeAccountClient({}, { sessions: sampleSessions().filter((s) => s.current) }),
  },
};

export const SessionsLoading: Story = {
  args: {
    section: 'security',
    client: fakeAccountClient({ listSessions: () => new Promise(() => {}) }),
  },
};

export const SessionsFailed: Story = {
  args: {
    section: 'security',
    client: fakeAccountClient({
      listSessions: async () => {
        throw new Error('network');
      },
    }),
  },
};

/** Profile, the first section. */
export const Profile: Story = {};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** Each section at its own address (D17): the notifications, as emails link to them. */
export const Notifications: Story = { args: { section: 'notifications' } };

/** On a phone the notifications stack per event, channels beneath (D23). */
export const NotificationsPhone: Story = {
  args: { section: 'notifications' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Security: Story = { args: { section: 'security' } };

export const Tokens: Story = { args: { section: 'tokens' } };

export const YourData: Story = { args: { section: 'data' } };

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
  args: { section: 'notifications' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await canvas.findByRole('table');
    await fitsPhoneWidth(canvas);
  },
};

/** The width of a phone, 375 px: five sections need about 450. */
const atPhone375 = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 375 }}>
    <Story />
  </div>
);

/**
 * On a phone every section shows (D17): the row wraps onto a second line instead of scrolling
 * inside itself, where 'Your data' waited unseen past the edge (the third sweep). The current
 * section, the last here, is marked where it stands.
 */
export const SectionsAtPhoneWidth: Story = {
  decorators: [atPhone375],
  args: { section: 'data' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await canvas.findByRole('navigation', { name: 'Account sections' });
    await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
    const shown = bar.getBoundingClientRect();
    const links = within(bar).getAllByRole('link');
    await expect(links).toHaveLength(5);
    for (const link of links) {
      const tab = link.getBoundingClientRect();
      await expect(tab.left).toBeGreaterThanOrEqual(shown.left);
      await expect(tab.right).toBeLessThanOrEqual(shown.right + 1);
    }
    await expect(within(bar).getByRole('link', { name: 'Your data' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Nothing fades: what shows is all there is.
    await expect(getComputedStyle(bar).maskImage).toBe('none');
    await fitsPhoneWidth(canvas);
  },
};
