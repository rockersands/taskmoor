import type { Meta, StoryObj } from '@storybook/react-vite';
import { REDIRECT_URI } from './fixtures';
import { RedirectUriField } from './RedirectUriField';

const meta = {
  title: 'Admin/RedirectUriField',
  component: RedirectUriField,
  args: { uri: REDIRECT_URI },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof RedirectUriField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Address: Story = {};

export const LongAddress: Story = {
  args: {
    uri: 'https://tasks.a-long-internal-host-name.departments.example.org/api/v1/auth/oidc/callback',
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
