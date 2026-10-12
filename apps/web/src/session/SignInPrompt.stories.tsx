import type { Meta, StoryObj } from '@storybook/react-vite';
import { RequireSession, SessionProvider } from './SessionProvider';

function Guarded() {
  return (
    <RequireSession>
      <h1 className="page-title">Settings</h1>
    </RequireSession>
  );
}

const meta = {
  title: 'Session/RequireSession',
  component: Guarded,
  decorators: [
    (Story) => (
      <main style={{ padding: 32 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Guarded>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anonymous: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const SignedIn: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'signed-in', user: { id: 1, name: 'Kalo' } }}>
        <Story />
      </SessionProvider>
    ),
  ],
};
