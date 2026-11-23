import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { NAV_ITEMS } from '../App';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
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
    // Its head names the product and gives a way out that shows (S3-SP-12).
    const drawer = within(canvas.getByRole('dialog', { name: 'Navigation' }));
    await expect(drawer.getByText('Taskmoor')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeVisible();
  },
};

/**
 * The drawer on a touch screen (S3-SP-12): its close button, at the top beside the product's name,
 * is a finger's size, as are its pages.
 */
export const PhoneDrawerOnATouchScreen: Story = {
  tags: ['touch'],
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const drawer = await canvas.findByRole('dialog', { name: 'Navigation' });
    await waitFor(() => expect(drawer).toBeVisible());
    await expect(
      tooSmallForAFinger(drawer, ['.shell-drawer-head .icon-button', '.nav-link']),
    ).toEqual([]);
  },
};
