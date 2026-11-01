import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeImportsClient, runView } from './fixtures';
import { ImportRunPanel } from './ImportRunPanel';

const meta = {
  title: 'Admin/Imports/ImportRunPanel',
  component: ImportRunPanel,
  args: { client: fakeImportsClient(), runId: 2, pollMs: 50 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 960 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ImportRunPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A finished import with its report. */
export const Finished: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Report of import 2' })).toBeVisible();
  },
};

/** A run on its tickets, which never finishes here: the progress and the cancel. */
export const Running: Story = {
  args: {
    client: fakeImportsClient({
      runs: [runView({ id: 9, status: 'running', currentKind: 'ticket', finishedAt: null })],
      ticks: 1_000_000,
    }),
    runId: 9,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Cancel the import' })).toBeVisible();
  },
};
