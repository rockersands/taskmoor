import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import {
  DEFAULT_WITH_SEEDED_DRAFT,
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

const seededDraft = () => ({
  workflowId: DEFAULT_WORKFLOW.id,
  client: fakeWorkflowsClient({ workflows: [DEFAULT_WITH_SEEDED_DRAFT, SUPPORT_WORKFLOW] }),
});

/** A default workflow's draft from before free moving: the editor offers the free moves (T-234). */
export const DraftWithFirstSteps: Story = {
  args: seededDraft(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Let this draft move freely' }),
    ).toBeVisible();
  },
};

export const DraftWithFirstStepsAtPhoneWidth: Story = {
  args: seededDraft(),
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Let this draft move freely' }),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

export const TransitionSelected: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const transitions = await canvas.findByRole('list', { name: 'Transitions' });
    await userEvent.click(within(transitions).getByRole('button', { name: 'Take' }));
    await expect(await canvas.findByRole('heading', { name: 'Transition: Take' })).toHaveFocus();
  },
};

export const StatusSelected: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const statuses = await canvas.findByRole('list', { name: 'Statuses in this workflow' });
    await userEvent.click(within(statuses).getByRole('button', { name: 'Under review' }));
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

/** The diagram scrolls inside its own card; the page does not scroll sideways. */
export const DiagramAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Diagram' })).toBeVisible();
    await expect(canvas.getByText(/^The statuses of this workflow/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Diagram' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fitsPhoneWidth(canvas);
  },
};

export const TextModeAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Text' }));
    await expect(canvas.getByLabelText('Definition (JSON)')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
