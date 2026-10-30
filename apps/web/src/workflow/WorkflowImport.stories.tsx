import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { Imported } from './client';
import { fakeWorkflowsClient, S, STATUSES, SUPPORT_WORKFLOW } from './fixtures';
import { ImportReport, ImportWorkflowForm } from './WorkflowImport';

/** An import with something of each kind of outcome (M1-127); every name is made up. */
const WITH_PROBLEMS: Imported = {
  workflow: { ...SUPPORT_WORKFLOW, id: 9, name: 'Support copy', draft: null },
  report: {
    statuses: [
      { name: 'Open', stage: 'new', statusId: S.Open as number, outcome: 'matched' },
      { name: 'Waiting', stage: 'active', statusId: 77, outcome: 'created' },
      {
        name: 'Approved',
        stage: 'active',
        statusId: S.Approved as number,
        outcome: 'matched',
        stageHere: 'closed',
      },
    ],
    problems: [
      {
        kind: 'group',
        name: 'Agents',
        rule: 'user-in-group',
        outcome: 'guard_never_passes',
        transition: { id: 1, name: 'Wait' },
      },
      {
        kind: 'field',
        name: 'risk-score',
        rule: 'field-required',
        outcome: 'transition_disabled',
        transition: { id: 2, name: 'Approve' },
      },
      {
        kind: 'user',
        name: 'ines@example.com',
        rule: 'update-field',
        outcome: 'removed',
        onCreate: true,
      },
      { kind: 'role', name: 'Leads', rule: 'edit', outcome: 'narrowed', status: 'Waiting' },
      {
        kind: 'permission',
        name: 'approve_budgets',
        rule: 'permission',
        outcome: 'kept',
        transition: { id: 3, name: 'Close' },
      },
    ],
  },
};

const meta = {
  title: 'Workflows/WorkflowImport',
  component: ImportReport,
  args: { imported: WITH_PROBLEMS, draft: false },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 900 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ImportReport>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReportWithProblems: Story = {};

export const ReportOfADraft: Story = {
  args: {
    draft: true,
    imported: {
      workflow: { ...SUPPORT_WORKFLOW, draft: { ...SUPPORT_WORKFLOW.published, version: 3 } },
      report: { statuses: WITH_PROBLEMS.report.statuses.slice(0, 1), problems: [] },
    },
  },
};

export const Form: Story = {
  render: () => (
    <ImportWorkflowForm
      client={fakeWorkflowsClient()}
      workflows={[
        {
          id: 2,
          name: 'Support',
          description: '',
          isDefault: false,
          publishedVersion: 2,
          draftVersion: null,
          trackCount: 0,
        },
      ]}
      statuses={STATUSES}
      refuse={() => false}
      onImported={() => {}}
      onCancel={() => {}}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Import' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Choose a workflow file.');
  },
};
