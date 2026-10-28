import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { fakeWorkflowsClient, SUPPORT_WORKFLOW } from './fixtures';
import { WorkflowsPage } from './WorkflowsPage';

const meta = {
  title: 'Admin/WorkflowsPage',
  component: WorkflowsPage,
  args: { client: fakeWorkflowsClient(), onOpen: () => {} },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof WorkflowsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Workflows: Story = {};

export const WithADraft: Story = {
  args: {
    client: fakeWorkflowsClient({
      workflows: [
        {
          ...SUPPORT_WORKFLOW,
          tracks: [],
          draft: { ...SUPPORT_WORKFLOW.published, version: 3, publishedAt: null },
        },
      ],
    }),
  },
};

export const CreatingAWorkflow: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Create a workflow' }));
    await expect(canvas.getByRole('form', { name: 'New workflow' })).toBeVisible();
    await userEvent.keyboard('Releases');
    await expect(canvas.getByLabelText('Initial status')).toBeVisible();
  },
};

export const ConfirmingDelete: Story = {
  args: {
    client: fakeWorkflowsClient({ workflows: [{ ...SUPPORT_WORKFLOW, tracks: [] }] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Support' }));
    await expect(canvas.getByRole('button', { name: 'Delete workflow' })).toHaveFocus();
  },
};

export const Forbidden: Story = {
  args: {
    client: {
      ...fakeWorkflowsClient(),
      list: async () => {
        throw new ApiError(403, { error: 'forbidden' });
      },
    },
  },
};
