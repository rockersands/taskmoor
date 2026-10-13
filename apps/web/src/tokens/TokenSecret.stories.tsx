import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { TokenSecret } from './TokenSecret';

const meta = {
  title: 'Tokens/TokenSecret',
  component: TokenSecret,
  args: {
    token: 'tmk_EXAMPLE_ONLY_not_a_real_token_000001',
    name: 'Deploy script',
    onDone: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TokenSecret>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShownOnce: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('New token');
    await expect(input).toHaveFocus();
    await expect(input).toHaveAttribute('readonly');
  },
};

export const LongName: Story = {
  args: { name: 'Nightly export of every closed ticket to the finance data warehouse' },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
