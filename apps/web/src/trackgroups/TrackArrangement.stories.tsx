import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { gripsTooSmall, onARealTouchScreen } from '../test/touch';
import type { TrackGroup, TrackGroupClient } from './client';
import { fakeTrackGroupClient, GROUP_TRACKS, ownGroup, sharedGroup } from './fixtures';
import { ShareGroupDialog } from './ShareGroupDialog';
import { TrackArrangement, type TrackArrangementProps } from './TrackArrangement';

const ARRANGED: TrackGroup[] = [
  ownGroup(1, 'Launch', [1, 3], { sharedWith: 2 }),
  ownGroup(2, 'Back office', [4, 5, 6], { minimized: true }),
  sharedGroup(3, 'Grace’s picks', [2]),
];

/** The page keeps the arrangement the server answers; so does this wrapper. */
function Stateful(props: TrackArrangementProps) {
  const [groups, setGroups] = useState(props.groups);
  return (
    <main style={{ padding: 24 }}>
      <TrackArrangement {...props} groups={groups} onGroups={setGroups} />
    </main>
  );
}

/** The Tracks page in groups (CORE-034, IAM-034; ADR-121). */
const meta = {
  title: 'Tracks/TrackArrangement',
  component: TrackArrangement,
  args: {
    tracks: GROUP_TRACKS,
    groups: ARRANGED,
    client: fakeTrackGroupClient({ groups: ARRANGED }),
    onGroups: () => {},
  },
  render: (args) => <Stateful {...args} />,
} satisfies Meta<typeof TrackArrangement>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An open group as a glass bubble, a minimized one the size of a card, and a shared one. */
export const Arranged: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const launch = canvas.getByRole('region', { name: 'Launch' });
    await expect(within(launch).getByRole('link', { name: /Shop/ })).toBeVisible();
    await expect(within(launch).getByText('Shared with 2 people')).toBeVisible();
    const office = canvas.getByRole('region', { name: 'Back office' });
    await expect(within(office).getByText('3 tracks')).toBeVisible();
    await expect(within(office).queryByRole('link')).toBeNull();
    await expect(canvas.getByText('Shared by Grace Hopper')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Tracks in no group' })).toBeVisible();
  },
};

/** Before any group: the tracks as the directory lists them, each with its grip. */
export const NoGroupsYet: Story = {
  args: { groups: [], client: fakeTrackGroupClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Move Shop' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Tracks in no group' })).toBeNull();
  },
};

/** The keyboard path: Alt and the arrows reorder, the grip's menu moves between groups. */
export const ByKeyboard: Story = {
  args: { client: fakeTrackGroupClient({ groups: ARRANGED }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const shop = canvas.getByRole('button', { name: 'Move Shop' });
    shop.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() =>
      expect(
        within(canvas.getByRole('region', { name: 'Launch' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['PAYPayments', 'SHOPShop']),
    );
    await expect(canvas.getByRole('button', { name: 'Move Shop' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Move to Back office' }));
    await waitFor(() =>
      expect(
        within(canvas.getByRole('region', { name: 'Back office' })).getByText('4 tracks'),
      ).toBeVisible(),
    );
  },
};

/**
 * NFR-007, ADR-033: on a real touch screen at a desktop's width, every group's and track's grip is
 * a finger's size (T-231).
 */
export const GripsOnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    await expect(await gripsTooSmall(canvasElement, ['.move-grip-handle'])).toEqual([]);
  },
};

/** Phones: one column, nothing sideways, the grips 44px under a finger (T-231). */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1' } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await expect(await gripsTooSmall(canvasElement, ['.move-grip-handle'])).toEqual([]);
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

const dialogArgs = (client: TrackGroupClient) => ({
  group: ARRANGED[0] as TrackGroup,
  client,
  onClose: () => {},
  onChanged: () => {},
});

/** Sharing: a person, a role on the tracks the owner may give it on, and who has it now. */
export const ShareDialog: Story = {
  render: () => <ShareGroupDialog mode="share" {...dialogArgs(fakeTrackGroupClient())} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole('dialog', { name: 'Share Launch' });
    await expect(within(dialog).getByText('Grace Hopper: Members, on 2 tracks')).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText('Find a person by name'), 'Al');
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Choose Alan Turing' }),
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Role on its tracks'),
      'Members, on 2 of 2 tracks',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await expect(await within(dialog).findByText(/Shared with Alan Turing\./)).toBeVisible();
  },
};

/** Setting it on someone: a copy of their own. */
export const SetOnDialog: Story = {
  render: () => <ShareGroupDialog mode="setOn" {...dialogArgs(fakeTrackGroupClient())} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole('dialog', { name: 'Set Launch on someone' });
    await expect(within(dialog).queryByRole('heading', { name: 'Shared with' })).toBeNull();
  },
};

/** An owner who runs none of the tracks: no role to give, only the group. */
export const NothingToGive: Story = {
  render: () => (
    <ShareGroupDialog
      mode="share"
      {...dialogArgs(fakeTrackGroupClient({ sharing: { trackCount: 2, roles: [], shares: [] } }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole('dialog', { name: 'Share Launch' });
    await expect(await within(dialog).findByText(/You run none of its tracks/)).toBeVisible();
    await expect(within(dialog).getByText('Not shared with anyone yet.')).toBeVisible();
  },
};

/** Leaving a group shared with you (T-204): what goes with it, asked first. */
export const LeaveDialog: Story = {
  args: { client: fakeTrackGroupClient({ groups: ARRANGED }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Move or change the group Grace’s picks' }),
    );
    await userEvent.click(await canvas.findByRole('menuitem', { name: 'Leave group…' }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', {
      name: 'Leave Grace’s picks?',
    });
    await expect(
      within(dialog).getByText(/the Members role it gave you goes from 1 track/),
    ).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: 'Leave group' })).toBeVisible();
  },
};

/** The same on a phone: the dialog across the screen, its buttons 44px under a finger. */
export const LeaveDialogPhone: Story = {
  ...LeaveDialog,
  globals: { viewport: { value: 'mobile1' } },
};
