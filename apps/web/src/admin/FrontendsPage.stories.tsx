import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { FrontendsPage } from './FrontendsPage';
import { ADMIN, MEMBER } from './fixtures';
import { FRONTENDS, fakeFrontendsClient } from './frontendsFixtures';

const meta = {
  title: 'Admin/FrontendsPage',
  component: FrontendsPage,
  args: { client: fakeFrontendsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof FrontendsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two registered frontends, one a release behind, and one from the environment. */
export const Registered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'https://board.example.org' }),
    ).toBeVisible();
    await expect(canvas.getByText('An update is available.')).toBeVisible();
  },
};

/** Nothing registered and nothing in the environment; the server serves no app itself. */
export const Empty: Story = {
  args: {
    client: fakeFrontendsClient({
      ...FRONTENDS,
      self: { ...FRONTENDS.self, servedVersion: null },
      environment: [],
      frontends: [],
    }),
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
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
    await expect(
      await canvas.findByRole('heading', { name: 'https://board.example.org' }),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No frontend is registered yet.')).toBeVisible();
    await expect(canvas.getByText(/before it may use this server/)).toBeVisible();
  },
};
