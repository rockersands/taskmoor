import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
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
  freeMoves = false,
}: {
  impact: Impact | null;
  loading?: boolean;
  failed?: boolean;
  warnings: LintIssue[];
  error?: string | null;
  freeMoves?: boolean;
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
      freeMoves={freeMoves}
      busy={false}
      error={error ? t('workflow.problem.badMapping') : null}
      onPublish={() => {}}
      onCancel={() => {}}
    />
  );
}

const stages = new Map(STATUSES.map((s) => [s.id, s.stage]));

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

/** A draft with no transitions: publishing gives each status its free move (T-246; WF-008). */
export const NoTransitionsYet: Story = {
  args: { impact: { removedStatuses: [], tracks: [] }, warnings: [], freeMoves: true },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'This version has no transitions, so publishing gives each of its statuses a move from any status, as a new workflow gets.',
      ),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

export const Checking: Story = { args: { impact: null, loading: true } };

export const CheckFailed: Story = { args: { impact: null, failed: true } };

export const Refused: Story = { args: { error: 'bad' } };

/** The step on a phone, with the statuses it would drop. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('combobox').length).toBeGreaterThan(0);
    await fitsPhoneWidth(canvas);
  },
};
