import type { Meta, StoryObj } from '@storybook/react-vite';
import { useT } from '../i18n/I18nProvider';
import { namesFor } from './describe';
import { STATUSES, SUPPORT_DEFINITION } from './fixtures';
import { LintPanel } from './LintPanel';
import { type LintIssue, lintDefinition } from './lint';

function Holder({ issues, errors = [] }: { issues: LintIssue[]; errors?: string[] }) {
  const t = useT();
  return (
    <LintPanel
      issues={issues}
      errors={errors.map((path) => t('workflow.shape.missing', { path }))}
      names={namesFor(t, STATUSES, SUPPORT_DEFINITION)}
      onShow={() => {}}
    />
  );
}

const stages = new Map(STATUSES.map((s) => [s.id, s.stage]));

const meta = {
  title: 'Workflows/LintPanel',
  component: Holder,
  args: { issues: lintDefinition(SUPPORT_DEFINITION, stages) },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 900 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Warnings: Story = {};

export const Clean: Story = { args: { issues: [] } };

export const ErrorsAndWarnings: Story = {
  args: {
    issues: [
      { kind: 'missing-target', severity: 'error', transitionId: 2, statusId: 99 },
      { kind: 'no-exit', severity: 'warning', statusId: 5 },
      { kind: 'unsatisfiable-guard', severity: 'warning', transitionId: 1 },
    ],
    errors: ['definition.transitions[0].name'],
  },
};
