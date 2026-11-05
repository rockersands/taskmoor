import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, MEMBER, TRASHED_TICKETS, TRASHED_TRACKS } from './fixtures';
import { type TrashClient, TrashPage } from './TrashPage';

/** An in-memory trash, so restoring and saving behave like the real page. */
function fakeTrashClient(overrides: Partial<TrashClient> = {}): TrashClient {
  let tickets = [...TRASHED_TICKETS];
  let tracks = [...TRASHED_TRACKS];
  let retention = 30;
  return {
    listTickets: async () => ({ items: tickets, next: null }),
    listTracks: async () => tracks,
    restoreTicket: async (id) => {
      tickets = tickets.filter((t) => t.id !== id && t.trash.deletedWith?.id !== id);
    },
    restoreTrack: async (id) => {
      tracks = tracks.filter((t) => t.id !== id);
    },
    loadRetention: async () => retention,
    saveRetention: async (days) => {
      retention = days;
      return days;
    },
    ...overrides,
  };
}

const meta = {
  title: 'Admin/TrashPage',
  component: TrashPage,
  args: { client: fakeTrashClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TrashPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithTicketsAndTracks: Story = {};

export const Empty: Story = {
  args: {
    client: fakeTrashClient({
      listTickets: async () => ({ items: [], next: null }),
      listTracks: async () => [],
    }),
  },
};

export const RestoredATicket: Story = {
  args: { client: fakeTrashClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Restore SHOP-41' }));
    await expect(await canvas.findByText('SHOP-41 is back.')).toBeVisible();
  },
};

export const RestoreRefused: Story = {
  args: {
    client: fakeTrashClient({
      restoreTicket: async () => {
        throw new ApiError(409, { error: 'parent_in_trash' });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Restore OPS-7' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Its parent is still in the trash',
    );
  },
};

/** People with "Delete tickets" see the tickets they may restore, nothing else. */
export const ForATrackAdministrator: Story = {
  args: { client: fakeTrashClient({ listTracks: async () => null }) },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const Loading: Story = {
  args: { client: fakeTrashClient({ listTickets: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeTrashClient({
      listTickets: async () => {
        throw new Error('network');
      },
    }),
  },
};

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

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^SHOP-41/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No tickets in the trash.')).toBeVisible();
    await expect(canvas.getByText(/^A deleted ticket waits here/)).toBeVisible();
  },
};
