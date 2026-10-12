import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, MEMBER } from './fixtures';
import { SettingsPage } from './SettingsPage';

const meta = {
  title: 'Admin/SettingsPage',
  component: SettingsPage,
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SiteAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
};

export const Member: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
};
