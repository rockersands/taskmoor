import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CONFIG_ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { fakeConfigurationClient } from './fixtures';
import { WorkflowMapsPage } from './WorkflowMapsPage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

/** A local-mode track's own workflow map (T-322), for someone who runs the track. */
const meta = {
  title: 'Admin/Track workflow map',
  component: WorkflowMapsPage,
  args: { client: fakeConfigurationClient(), trackId: 4 },
  parameters: { session: TRACK_ADMIN },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? TRACK_ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof WorkflowMapsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** OPS's own map, open at once: its runbooks follow its own workflow. */
export const OwnMap: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('combobox', { name: 'Runbook follows' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Delete map/ })).toBeNull();
  },
};

/** A change that leaves OPS's tickets in statuses the new workflow lacks asks where they go. */
export const OwnMapMapping: Story = {
  args: { client: fakeConfigurationClient({ refuseMapping: true }), trackId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Runbook from the map' }),
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Save the map' }));
    await expect(await canvas.findByRole('heading', { name: 'Save OPS workflows' })).toHaveFocus();
  },
};

/** Someone who runs tracks, on the shared page: the tracks of their own to choose from. */
export const ChooseATrack: Story = {
  args: { client: fakeConfigurationClient(), trackId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Workflow map of OPS · Operations' }),
    ).toBeVisible();
  },
};

/** A track in shared mode owns no map: its page says whose it follows. */
export const SharedTrack: Story = {
  args: { client: fakeConfigurationClient(), trackId: 3 },
  parameters: { session: CONFIG_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^SHOP uses shared configuration/)).toBeVisible();
  },
};

export const OwnMapAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('combobox', { name: 'Runbook follows' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
