import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CapacityDialog } from './CapacityDialog';

const PERIODS = [
  { start: '2026-11-02', label: 'Nov 2 to Nov 15' },
  { start: '2026-11-16', label: 'Nov 16 to Nov 29' },
  { start: '2026-11-30', label: 'Nov 30 to Dec 13' },
];

/**
 * Setting the capacity of a person in a plan (PLN-009): 10 points every period, and none in the
 * second period, with a note (leave).
 */
const meta = {
  title: 'Plans/CapacityDialog',
  component: CapacityDialog,
  args: {
    subject: { kind: 'person', id: 7, name: 'Ana Ruiz' },
    unit: 'points',
    periods: PERIODS,
    capacity: {
      default: { amount: 10, note: '' },
      periods: [
        { amount: 10, note: '', from: 'default' },
        { amount: 0, note: 'Leave', from: 'period' },
        { amount: 10, note: '', from: 'default' },
      ],
    },
    onSave: fn(async () => true as const),
    onClose: fn(),
  },
} satisfies Meta<typeof CapacityDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The dialog as it opens: every period's amount, then each period's own. */
export const Person: Story = {
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(await dialog.findByRole('dialog', { name: 'Capacity of Ana Ruiz' })).toBeVisible();
    await expect(dialog.getByLabelText('Capacity for every period')).toHaveValue('10');
    await expect(dialog.getByLabelText('Note for Nov 16 to Nov 29')).toHaveValue('Leave');
  },
};

/** A team, in hours, after a value that does not read. */
export const TeamInHoursRefused: Story = {
  args: {
    subject: { kind: 'team', id: 3, name: 'Web' },
    unit: 'hours',
    capacity: {
      default: null,
      periods: PERIODS.map(() => ({ amount: null, note: '', from: null })),
    },
  },
  play: async ({ canvasElement, args }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await userEvent.type(await dialog.findByLabelText('Capacity for every period'), 'ten');
    await userEvent.click(dialog.getByRole('button', { name: 'Save capacity' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('Enter a number from 0');
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

/** A note typed for a period without its own capacity: refused at that capacity, nothing sent. */
export const NoteWithoutCapacity: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await userEvent.type(await dialog.findByLabelText('Note for Nov 30 to Dec 13'), 'Holiday');
    await userEvent.click(dialog.getByRole('button', { name: 'Save capacity' }));
    const amount = dialog.getByLabelText('Capacity for Nov 30 to Dec 13');
    await expect(amount).toHaveAccessibleDescription(
      'A note goes with a capacity: enter one for Nov 30 to Dec 13, or clear its note.',
    );
    await expect(amount).toHaveFocus();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
