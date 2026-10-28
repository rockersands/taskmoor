import type { Meta, StoryObj } from '@storybook/react-vite';
import { useT } from '../i18n/I18nProvider';
import type { Impact } from './client';
import { namesFor } from './describe';
import { S, STATUSES, SUPPORT_DEFINITION } from './fixtures';
import { type LintIssue, lintDefinition } from './lint';
import { PublishPanel } from './PublishPanel';

function Holder({
  impact,
  loading = false,
  failed = false,
  warnings,
  error = null,
}: {
  impact: Impact | null;
  loading?: boolean;
  failed?: boolean;
  warnings: LintIssue[];
  error?: string | null;
}) {
  const t = useT();
  return (
    <PublishPanel
      version={3}
      impact={impact}
      loading={loading}
      failed={failed}
      warnings={warnings}
      names={namesFor(t, STATUSES, SUPPORT_DEFINITION)}
      draftStatusIds={SUPPORT_DEFINITION.statuses.map((s) => s.statusId)}
      busy={false}
      error={error ? t('workflow.problem.badMapping') : null}
      onPublish={() => {}}
      onCancel={() => {}}
    />
  );
}

const stages = new Map(STATUSES.map((s) => [s.id, s.stage]));

const meta = {
  title: 'Workflows/PublishPanel',
  component: Holder,
  args: {
    impact: {
      removedStatuses: [
        { statusId: S['In Review'] as number, ticketCount: 120 },
        { statusId: S.Backlog as number, ticketCount: 0 },
      ],
      tracks: [
        { id: 1, key: 'PAY', name: 'Payments' },
        { id: 3, key: 'HELP', name: 'Help desk' },
      ],
    },
    warnings: lintDefinition(SUPPORT_DEFINITION, stages),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DroppingStatuses: Story = {};

export const NothingDropped: Story = {
  args: { impact: { removedStatuses: [], tracks: [] }, warnings: [] },
};

export const Checking: Story = { args: { impact: null, loading: true } };

export const CheckFailed: Story = { args: { impact: null, failed: true } };

export const Refused: Story = { args: { error: 'bad' } };
