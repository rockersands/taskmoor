import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useT } from '../i18n/I18nProvider';
import { namesFor } from './describe';
import { S, STATUSES, SUPPORT_DEFINITION } from './fixtures';
import { StatusInspector } from './StatusInspector';

function Holder({ statusId }: { statusId: number }) {
  const t = useT();
  const definition = {
    ...SUPPORT_DEFINITION,
    statusPermissions: { [String(S.Approved)]: { edit: [{ role: '1' }], transition: [] } },
  };
  return (
    <StatusInspector
      statusId={statusId}
      stage={STATUSES.find((s) => s.id === statusId)?.stage}
      definition={definition}
      names={namesFor(t, STATUSES, definition)}
      onMakeInitial={() => {}}
      onAddTransition={() => {}}
      onRemove={() => {}}
    />
  );
}

const meta = {
  title: 'Workflows/StatusInspector',
  component: Holder,
  args: { statusId: S.Open as number },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 560 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InitialStatus: Story = {};

export const RestrictedStatus: Story = { args: { statusId: S.Approved as number } };

export const ConfirmingRemoval: Story = {
  args: { statusId: S['Under review'] as number },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove Under review from the workflow' }),
    );
    await expect(canvas.getByText(/It also removes 3 transitions/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Remove status' })).toHaveFocus();
  },
};
