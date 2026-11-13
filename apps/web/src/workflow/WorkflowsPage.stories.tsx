import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeWorkflowsClient, SUPPORT_WORKFLOW } from './fixtures';
import { WorkflowsPage } from './WorkflowsPage';

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

export const ImportingAWorkflow: Story = {
  args: { client: fakeWorkflowsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Import a workflow' }));
    await expect(canvas.getByRole('form', { name: 'Import a workflow file' })).toBeVisible();
    await expect(canvas.getByLabelText('Import as')).toHaveValue('new');
  },
};

export const ConfirmingDelete: Story = {
  args: {
    client: fakeWorkflowsClient({ workflows: [{ ...SUPPORT_WORKFLOW, tracks: [] }] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Support' }));
    // Asks first, saying what will happen; the focus on Cancel, the safe choice (D13).
    const question = canvas.getByRole('group', { name: /^Delete Support with all its versions\?/ });
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expect(within(question).getByRole('button', { name: 'Delete Support' })).toBeVisible();
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

/** None yet: what a workflow is, and the button above makes the first. */
export const NoWorkflowsYet: Story = {
  args: { client: { ...fakeWorkflowsClient(), list: async () => [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No workflows yet.')).toBeVisible();
    await expect(
      canvas.getByText(/^A workflow moves tickets between statuses\. Create/),
    ).toBeVisible();
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Support')).toBeVisible();
    await expect(canvas.getByText(/^Statuses, and the transitions/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A finger reaches each workflow's name (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: 'Support' });
    await expect(tooSmallForAFinger(canvasElement, ['.workflow-name-link'])).toEqual([]);
  },
};
