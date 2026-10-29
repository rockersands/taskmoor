import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { ConfigurationSetsPage } from './ConfigurationSetsPage';
import { fakeSetsClient } from './fixtures';

const meta = {
  title: 'Admin/Configuration sets',
  component: ConfigurationSetsPage,
  args: { client: fakeSetsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ConfigurationSetsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type sets and field rule sets. */
export const Sets: Story = {};

/** The default rule set open: every field with its rule. */
export const RuleSetOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default field rules' }),
    );
    await expect(await canvas.findByRole('group', { name: 'Customer' })).toBeVisible();
  },
};
