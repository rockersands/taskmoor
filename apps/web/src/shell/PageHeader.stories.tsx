import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { EmptyState } from './EmptyState';
import { PageHeader } from './PageHeader';

const meta = {
  title: 'Shell/PageHeader',
  component: PageHeader,
  args: {
    title: 'Boards',
    eyebrow: 'Platform API',
    purpose: 'A board shows tickets as cards in columns, one column per step of the work.',
    about: 'Each column stands for one or more statuses of the workflow.',
    actions: (
      <button type="button" className="button-quiet">
        Board settings
      </button>
    ),
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Title, purpose line, help and actions (ADR-114). */
export const WithEverything: Story = {};

/** The help opens under the title. */
export const HelpOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'What is Boards for?' }));
    // The explanation fades in (except under reduced motion), so wait for it to show.
    await waitFor(() =>
      expect(
        canvas.getByText('Each column stands for one or more statuses of the workflow.'),
      ).toBeVisible(),
    );
  },
};

/** An empty state that explains, on a glass card. */
export const Empty: Story = {
  render: (args) => (
    <>
      <PageHeader {...args} />
      <section className="glass-card" style={{ padding: 24 }}>
        <EmptyState
          title="No boards yet"
          action={
            <a className="button-quiet" href="#/boards">
              Create a board
            </a>
          }
        >
          A board shows the tickets its query finds as cards in columns.
        </EmptyState>
      </section>
    </>
  ),
};

/**
 * TR-28: on a phone a long title wraps, and the help mark stays at the end of its last line
 * rather than drifting to the far edge of the header.
 */
export const LongTitleOnAPhone: Story = {
  args: { title: 'Configuration sets of the platform team', eyebrow: undefined },
  decorators: [
    (Story) => (
      <div style={{ width: 300 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = canvas.getByRole('heading', { level: 1 });
    const help = canvas.getByRole('button', { name: /What is .* for\?/ });
    const range = document.createRange();
    range.selectNodeContents(title);
    const lines = [...range.getClientRects()];
    await expect(new Set(lines.map((line) => Math.round(line.top))).size).toBeGreaterThan(1);
    const lastLine = lines.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    const mark = help.getBoundingClientRect();
    await expect(mark.left - lastLine.right).toBeLessThan(24);
    await expect(mark.top).toBeLessThan(lastLine.bottom);
  },
};
