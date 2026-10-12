import type { Meta, StoryObj } from '@storybook/react-vite';
import { NAV_ITEMS } from '../App';
import { NavList } from './NavList';

const meta = {
  title: 'Shell/NavList',
  component: NavList,
  args: { items: NAV_ITEMS, activeId: 'boards', showLabels: true },
  decorators: [
    (Story) => (
      <aside className="shell-sidebar" style={{ width: 232, position: 'static', height: 'auto' }}>
        <Story />
      </aside>
    ),
  ],
} satisfies Meta<typeof NavList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const CollapsedRail: Story = {
  args: { showLabels: false },
  decorators: [
    (Story) => (
      <div className="shell" data-collapsed="true" style={{ display: 'block', minHeight: 0 }}>
        <aside className="shell-sidebar" style={{ width: 60, position: 'static', height: 'auto' }}>
          <Story />
        </aside>
      </div>
    ),
  ],
};
