import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePrioritiesClient } from './fixtures';
import { PrioritiesPage } from './PrioritiesPage';

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
  title: 'Admin/Priorities',
  component: PrioritiesPage,
  args: { client: fakePrioritiesClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PrioritiesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The three lists: priorities with the icon of their place, the sets, the close reasons. */
export const Priorities: Story = {
  args: { client: fakePrioritiesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Drop everything.')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Priority sets' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Close reasons' })).toBeVisible();
  },
};

/** A priority on tickets asks which one takes its place before it goes. */
export const PriorityInUse: Story = {
  args: { client: fakePrioritiesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete priority High' }));
    await userEvent.click(
      within(canvas.getByRole('group')).getByRole('button', { name: 'Delete priority High' }),
    );
    const form = await canvas.findByRole('form', { name: 'What takes the place of High' });
    await expect(within(form).getByLabelText('Instead, give them')).toHaveFocus();
  },
};

/** A close reason a workflow sets names the workflow, and what a replacement does to it. */
export const CloseReasonAWorkflowSets: Story = {
  args: { client: fakePrioritiesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Delete close reason Duplicate' }),
    );
    await userEvent.click(
      within(canvas.getByRole('group')).getByRole('button', {
        name: 'Delete close reason Duplicate',
      }),
    );
    await expect(
      await canvas.findByText(/^The workflow Support flow sets Duplicate\./),
    ).toBeVisible();
  },
};

/** New priority, open: the form sits above the list. */
export const AddingAPriority: Story = {
  args: { client: fakePrioritiesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New priority' }));
    await expect(canvas.getByRole('form', { name: 'Add a priority' })).toBeVisible();
  },
};

/** Someone who is neither kind of administrator: the page's name and the refusal alone. */
export const Refused: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^Only site and configuration administrators/)).toBeVisible();
  },
};

export const AtPhoneWidth: Story = {
  args: { client: fakePrioritiesClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage priority set Support' }),
    );
    await expect(canvas.getByRole('form', { name: 'Change priority set Support' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Change priority Urgent' }));
    await expect(canvas.getByRole('form', { name: 'Change priority Urgent' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
