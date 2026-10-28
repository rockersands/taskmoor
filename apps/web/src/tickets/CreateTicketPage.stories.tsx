import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { type CreateClient, CreateTicketPage } from './CreateTicketPage';
import { BUG_FORM, CHORE_FORM, LOCKED_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';

/** A backend in memory: Bugs need a due date and a severity, as the form says. */
function fakeClient(overrides: Partial<CreateClient> = {}): CreateClient {
  let number = 0;
  return {
    tracks: async () => TRACKS,
    ticketTypes: async () => ({ defaultTypeId: 3, types: TYPES }),
    form: async (_track, typeId) => (typeId === 3 ? BUG_FORM : CHORE_FORM),
    priorities: async () => PRIORITIES,
    create: async (body) => {
      const missing: Record<string, string> = {};
      if (body.ticketTypeId === 3 && !body.dueDate) missing.dueDate = 'required';
      if (body.ticketTypeId === 3 && !(body.fields as Record<string, unknown> | undefined)?.[7]) {
        missing['fields.7'] = 'required';
      }
      if (Object.keys(missing).length > 0) {
        throw new ApiError(400, { error: 'invalid_fields', fields: missing });
      }
      number += 1;
      return { key: `SHOP-${number}` };
    },
    ...overrides,
  };
}

const meta = {
  title: 'Tickets/CreateTicketPage',
  component: CreateTicketPage,
  args: { client: fakeClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CreateTicketPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BugForm: Story = {};

/** Submitting without the required fields puts the refusals at each of them. */
export const WithRefusals: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Summary (required)'), 'Checkout fails');
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    await expect(await canvas.findAllByText('This field is required.')).toHaveLength(2);
  },
};

export const ChoreForm: Story = {
  args: { client: fakeClient({ ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }) }) },
};

/** Fields only some may set (M1-029): shown read-only, each with the reason. */
export const LockedFields: Story = {
  args: {
    client: fakeClient({
      ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
      form: async () => LOCKED_FORM,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const due = await canvas.findByLabelText('Due date');
    await expect(due).toBeDisabled();
    await expect(due).toHaveAccessibleDescription('Only the Approvers group can set this field.');
    await expect(canvas.getByLabelText('Labels')).toBeDisabled();
    await expect(canvas.getByLabelText('Summary (required)')).toBeEnabled();
  },
};

export const NoTracks: Story = {
  args: { client: fakeClient({ tracks: async () => [] }) },
};
