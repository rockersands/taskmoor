import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeImportsClient, RUNS } from './fixtures';
import { ImportWizard } from './ImportWizard';

const meta = {
  title: 'Admin/Imports/ImportWizard',
  component: ImportWizard,
  args: { client: fakeImportsClient(), pollMs: 50 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 960 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ImportWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A backup in the imports folder, its options, then a dry run to its report and people. */
export const DryRunOfABackup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'File in the imports folder' }),
      'jira-backup-2026-10-30.zip',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Dry run' }));
    await expect(await canvas.findByRole('group', { name: '3. People' })).toBeVisible();
  },
};

/** A Jira Cloud site with its address and token. */
export const CloudSite: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: 'Jira Cloud site' }));
    await expect(canvas.getByLabelText('API token')).toBeVisible();
  },
};

/** A delta run from an earlier full import: choose the later backup. */
export const DeltaFromABackup: Story = {
  args: { delta: RUNS[1] ?? null },
};
