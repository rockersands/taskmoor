import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { NAV_ITEMS } from '../App';
import { AppShell } from './AppShell';

const meta = {
  title: 'Shell/AppShell',
  component: AppShell,
  args: {
    items: NAV_ITEMS,
    activeId: 'home',
    children: (
      <>
        <h1 className="page-title">Home</h1>
        <p className="page-note">Example page content.</p>
      </>
    ),
  },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Desktop is the primary layout: sidebar always visible. */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop' } },
};

export const DesktopCollapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Collapse sidebar' }));
    await expect(canvas.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  },
};

/** Below 768px the sidebar becomes a drawer behind the menu button. */
export const PhoneDrawerOpen: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    // The drawer fades in; wait for the animation to finish.
    await waitFor(() => expect(canvas.getByRole('dialog', { name: 'Navigation' })).toBeVisible());
  },
};
