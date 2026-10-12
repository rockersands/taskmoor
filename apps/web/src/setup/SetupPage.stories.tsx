import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionProvider } from '../session/SessionProvider';
import { SetupPage } from './SetupPage';

/** Stories render without a backend: the page shows its form and waits. */
const meta = {
  title: 'Setup/SetupPage',
  component: SetupPage,
  args: { onDone: () => {} },
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SetupPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup?token=story-token';
  },
};

export const WithoutToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/setup';
  },
};
