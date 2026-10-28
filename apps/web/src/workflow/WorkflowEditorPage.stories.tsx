import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import {
  DEFAULT_WORKFLOW,
  fakeWorkflowsClient,
  S,
  SUPPORT_DEFINITION,
  SUPPORT_WORKFLOW,
} from './fixtures';
import { WorkflowEditorPage } from './WorkflowEditorPage';

/** Support, with a draft that drops Draft (2 tickets) and adds Closed. */
const withDraft = () =>
  fakeWorkflowsClient({
    workflows: [
      {
        ...SUPPORT_WORKFLOW,
        draft: {
          version: 3,
          definition: {
            ...SUPPORT_DEFINITION,
            statuses: [
              ...SUPPORT_DEFINITION.statuses.filter((s) => s.statusId !== S.Draft),
              { statusId: S.Closed as number },
            ],
          },
          createdAt: '2026-10-27T15:00:00.000Z',
          publishedAt: null,
        },
      },
    ],
    ticketsIn: { [S.Draft as number]: 2 },
  });

const meta = {
  title: 'Admin/WorkflowEditorPage',
  component: WorkflowEditorPage,
  args: { workflowId: SUPPORT_WORKFLOW.id, client: fakeWorkflowsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof WorkflowEditorPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Support has a status no transition reaches: the checks name it. */
export const Diagram: Story = {};

export const DefaultWorkflow: Story = { args: { workflowId: DEFAULT_WORKFLOW.id } };

export const TransitionSelected: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Take' }));
    await expect(await canvas.findByRole('heading', { name: 'Transition: Take' })).toHaveFocus();
  },
};

export const StatusSelected: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Under review' }));
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Under review from the workflow' }),
    );
    await expect(canvas.getByRole('button', { name: 'Remove status' })).toHaveFocus();
  },
};

export const TextMode: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Text' }));
    await expect(canvas.getByLabelText('Definition (JSON)')).toBeVisible();
  },
};

export const PublishStep: Story = {
  args: { client: withDraft() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Publish' }));
    await expect(await canvas.findByLabelText('Move the 2 tickets in Draft to')).toBeVisible();
  },
};

export const History: Story = {
  args: { client: withDraft() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Version history' }));
    await expect(
      await canvas.findByRole('button', { name: 'Restore version 1 as the draft' }),
    ).toBeVisible();
  },
};
