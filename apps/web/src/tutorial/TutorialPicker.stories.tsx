import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { TutorialPicker } from './TutorialPicker';

const meta = {
  title: 'Tutorial/TutorialPicker',
  component: TutorialPicker,
  args: {
    admin: true,
    status: { tracks: 'done', boards: 'active', search: 'skipped' },
    selected: ['boards', 'dashboards'],
    onSelect: fn(),
    onStart: fn(),
  },
} satisfies Meta<typeof TutorialPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every section, for a site administrator, with some progress (ADR-115). */
export const Administrator: Story = {};

/** Without the sections that need a site administrator. */
export const Member: Story = { args: { admin: false, status: {}, selected: [] } };
