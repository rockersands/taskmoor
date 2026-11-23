import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { fakeTicketTypesClient } from './fixtures';
import { TicketTypesPage } from './TicketTypesPage';

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

const meta = {
  title: 'Admin/Ticket types',
  component: TicketTypesPage,
  args: { client: fakeTicketTypesClient() },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TicketTypesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The levels top first, each with its types. Initiative's tickets parent outcomes, so it is not
 * offered for removal and says why.
 */
export const Levels: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/^Initiative cannot be removed now: 3 parent links would break/),
    ).toBeVisible();
  },
};

/** A type open: its name, description, level and the eight icons. */
export const TypeOpen: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage ticket type Bug' }));
    await expect(canvas.getByRole('group', { name: 'Icon' })).toBeVisible();
    await expect(canvas.getByLabelText('Bug')).toBeChecked();
  },
};

/** A new level for the type to move to, with what the move would break said under the choice. */
export const LevelRefused: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage ticket type Bug' }));
    await userEvent.selectOptions(canvas.getByLabelText('Level'), 'Outcome');
    await expect(
      await canvas.findByText(/^This level would be refused: 30 parent links would break/),
    ).toBeVisible();
  },
};

/** Both forms open: a new ticket type and a new level. */
export const NewForms: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New ticket type' }));
    await userEvent.click(canvas.getByRole('button', { name: 'New level' }));
    await expect(canvas.getByRole('form', { name: 'Add a ticket type' })).toBeVisible();
    await expect(canvas.getByLabelText('Where it goes')).toBeVisible();
  },
};

/** Removing a level asks first, saying which types fall to the standard level (CORE-007). */
export const RemoveQuestion: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const remove = await canvas.findByRole('button', { name: 'Remove level Portfolio' });
    await waitFor(() => expect(remove).not.toBeDisabled());
    await userEvent.click(remove);
    await expect(canvas.getByRole('group', { name: /^Remove Portfolio\?/ })).toBeVisible();
  },
};

/** A move that would break parent links is refused, with the count. */
export const MoveRefused: Story = {
  args: { client: fakeTicketTypesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move level Portfolio down' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};

/** Someone who may not use the page is told so, and nothing else (T-144). */
export const Refused: Story = {
  parameters: { session: MEMBER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'Only site and configuration administrators manage ticket types and levels.',
      ),
    ).toBeVisible();
  },
};

/** The page on a phone's width, a type open: nothing sticks out sideways. */
export const AtPhoneWidth: Story = {
  args: { client: fakeTicketTypesClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage ticket type Spike' }));
    await expect(canvas.getByRole('group', { name: 'Icon' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** On a phone, with the touch rules on: the type's level and icons under one another. */
export const OnAPhone: Story = {
  args: { client: fakeTicketTypesClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage ticket type Spike' }));
    await expect(canvas.getByLabelText('Idea')).toBeChecked();
  },
};
