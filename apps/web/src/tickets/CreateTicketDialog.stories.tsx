import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreateTicketDialog } from './CreateTicketDialog';
import type { CreateClient } from './CreateTicketPage';
import { BUG_FORM, CHORE_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';

/** A backend in memory, with SHOP-7 to start from. */
const client: CreateClient = {
  tracks: async () => TRACKS,
  ticketTypes: async () => ({ defaultTypeId: 3, types: TYPES }),
  form: async (_track, typeId) => (typeId === 3 ? BUG_FORM : CHORE_FORM),
  priorities: async () => PRIORITIES,
  create: async () => ({ key: 'SHOP-8' }),
  template: async () => ({
    track: 'SHOP',
    ticketTypeId: 4,
    values: { summary: 'Rotate the payment keys', labels: 'security quarterly' },
    docs: {},
  }),
};

const meta = {
  title: 'Tickets/CreateTicketDialog',
  component: CreateTicketDialog,
  args: { client, onClose: () => {} },
} satisfies Meta<typeof CreateTicketDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The create form over the page. */
export const Open: Story = {};

/** Started from SHOP-7: its type and fields filled in. */
export const FromATicket: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(await canvas.findByLabelText('Start from a ticket (its key)'), 'SHOP-7');
    await userEvent.click(canvas.getByRole('button', { name: 'Copy its fields' }));
    await expect(await canvas.findByLabelText('Summary (required)')).toHaveValue(
      'Rotate the payment keys',
    );
  },
};
