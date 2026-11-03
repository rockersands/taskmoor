import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ThemeToggle } from './ThemeToggle';

const meta = {
  title: 'Shell/ThemeToggle',
  component: ThemeToggle,
  args: { onChoose: fn() },
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One press for the other mode (ADR-114). */
export const Default: Story = {};
