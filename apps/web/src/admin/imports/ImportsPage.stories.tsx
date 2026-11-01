import type { Meta, StoryObj } from '@storybook/react-vite';
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
