import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { DELTA_REPORT, REPORT } from './fixtures';
import { ImportReport } from './ImportReport';

const meta = {
  title: 'Admin/Imports/ImportReport',
  component: ImportReport,
  args: { report: REPORT, downloadUrl: '#report' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 960 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ImportReport>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A full import: totals, kinds, warnings explained, a failure and the mapping. */
export const FullImport: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/The ticket’s type is not offered by its track/)).toBeVisible();
  },
};

/** A delta run: what changed, and what the source no longer has. */
export const DeltaRun: Story = { args: { report: DELTA_REPORT } };

/** A dry run: nothing written. */
export const DryRun: Story = {
  args: {
    report: {
      ...REPORT,
      run: { ...REPORT.run, dryRun: true },
      totals: { ...REPORT.totals, target: null, fidelity: null },
    },
  },
};

/**
 * A dry run of what Spanish Excel saves as plain CSV (T-263): the file was not UTF-8, so the
 * report says it was read as Windows-1252 and shows the first lines to check.
 */
export const CsvReadAsWindows1252: Story = {
  args: {
    report: {
      ...REPORT,
      run: { ...REPORT.run, importSource: 'csv', sourceSystem: 'csv', dryRun: true },
      totals: { ...REPORT.totals, target: null, fidelity: null },
      warnings: [
        {
          kind: 'source',
          code: 'read_as_windows_1252',
          detail: null,
          count: 2,
          examples: ['line 1: Descripción', 'line 2: Árbol'],
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/read as Windows Western European/)).toBeVisible();
    await expect(canvas.getByText(/line 1: Descripción, line 2: Árbol/)).toBeVisible();
  },
};
