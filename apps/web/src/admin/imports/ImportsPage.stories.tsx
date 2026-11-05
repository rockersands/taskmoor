import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../../session/SessionProvider';
import { ADMIN, MEMBER } from '../fixtures';
import { fakeImportsClient } from './fixtures';
import { ImportsPage } from './ImportsPage';

const meta = {
  title: 'Admin/Imports/ImportsPage',
  component: ImportsPage,
  args: { client: fakeImportsClient(), pollMs: 50 },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ImportsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The wizard, and three earlier runs: a dry run, a full import and a delta from it. */
export const WithRuns: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: '2. Full import' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Delta run from import 2' })).toBeVisible();
  },
};

/** No import yet. */
export const Empty: Story = {
  args: { client: fakeImportsClient({ runs: [] }) },
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
    await expect(await canvas.findByRole('heading', { name: '2. Full import' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No imports yet.')).toBeVisible();
    await expect(canvas.getByText(/^An import brings work over/)).toBeVisible();
  },
};
