import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { MAPPING_IMPACT } from './fixtures';
import { MigrationProgress, StatusMappingPanel } from './StatusMappingPanel';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

const meta = {
  title: 'Admin/Status mapping',
  component: StatusMappingPanel,
  args: {
    impact: MAPPING_IMPACT,
    title: 'Switch SHOP to Bugs apart',
    confirmLabel: 'Switch and move the tickets',
    onConfirm: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      // Inside an Administration page, whose styles the step's choices take.
      <main className="admin-page" style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof StatusMappingPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each ticket type and status the new workflows lack, with a status of the new workflow for it. */
export const ChooseWhereTicketsGo: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Switch SHOP to Bugs apart' })).toHaveFocus();
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Move the 12 Bug tickets in In review to' }),
      'Fixing',
    );
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Move the 3 Bug tickets in Waiting to' }),
      'Open',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Switch and move the tickets' }));
    await expect(args.onConfirm).toHaveBeenCalledWith({ '5': { '3': 11, '4': 10 } });
  },
};

/** Confirming with a status not chosen says so, and marks the choices still open. */
export const ChoiceMissing: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Switch and move the tickets' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Choose a status for each');
    await expect(
      canvas.getByRole('combobox', { name: 'Move the 3 Bug tickets in Waiting to' }),
    ).toHaveAttribute('aria-invalid', 'true');
    await expect(args.onConfirm).not.toHaveBeenCalled();
  },
};

/** The tickets changed after the preview: the step reads again and asks again. */
export const ChangedSinceRead: Story = {
  args: { changed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'Tickets changed since this was read',
    );
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByTestId('phone-width');
    await expect(
      canvas.getByRole('combobox', { name: 'Move the 12 Bug tickets in In review to' }),
    ).toBeVisible();
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};

/** Tickets moving in the background: the bar fills as the migration is read again. */
export const TicketsMoving: Story = {
  render: () => (
    <MigrationProgress
      migration={{ id: 77, status: 'running', total: 600, migrated: 500 }}
      read={async (id) => ({ id, status: 'done', total: 600, migrated: 600 })}
      every={50}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('progressbar', { name: 'Tickets moved: 600 of 600' }),
    ).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('All 600 tickets have moved.');
  },
};

/** The progress could not be read: the tickets keep moving, and the page says so. */
export const ProgressUnread: Story = {
  render: () => (
    <MigrationProgress
      migration={{ id: 77, status: 'running', total: 600, migrated: 500 }}
      read={async () => {
        throw new Error('offline');
      }}
      every={50}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('They keep moving');
    await expect(
      canvas.getByRole('progressbar', { name: 'Tickets moved: 500 of 600' }),
    ).toBeVisible();
  },
};
