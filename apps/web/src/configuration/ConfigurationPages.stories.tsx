import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeConfigurationClient } from './fixtures';
import { TracksAdminPage } from './TracksAdminPage';
import { WorkflowMapsPage } from './WorkflowMapsPage';

const meta = {
  title: 'Admin/Configuration',
  component: TracksAdminPage,
  args: { client: fakeConfigurationClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TracksAdminPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Tracks, one open with its workflow map, its sprints and who does what in it. */
export const Tracks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage track SHOP' }));
    await expect(await canvas.findByText('Grace Hopper: Members')).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Sprints in SHOP' })).toBeChecked();
  },
};

/** Turning sprints off while one runs is refused, naming it, with a way to the board (AGL-010). */
export const SprintRunning: Story = {
  args: { client: fakeConfigurationClient({ runningSprint: 'Shop Sprint 4' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage track SHOP' }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Sprints in SHOP' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Shop Sprint 4');
    await expect(
      canvas.getByRole('link', { name: 'Complete it on the board of SHOP' }),
    ).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Sprints in SHOP' })).toBeChecked();
  },
};

/** A track whose board is Kanban has no sprints: no box, and why, with a way to the board's kind. */
export const SprintsNeedScrum: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage track OPS' }));
    await expect(await canvas.findByText(/^No sprints in OPS: its board is Kanban/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Settings of the board of OPS' })).toBeVisible();
    await expect(canvas.queryByRole('checkbox', { name: 'Sprints in OPS' })).toBeNull();
  },
};

/** A map switch that leaves tickets behind is refused with the count. */
export const MappingNeeded: Story = {
  args: { client: fakeConfigurationClient({ refuseMapping: true }) },
};

/** Workflow maps, one open with a type that has its own workflow. */
export const WorkflowMaps: Story = {
  render: () => <WorkflowMapsPage client={fakeConfigurationClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Bugs apart' }));
    await expect(await canvas.findByRole('combobox', { name: 'Bug follows' })).toBeVisible();
  },
};
