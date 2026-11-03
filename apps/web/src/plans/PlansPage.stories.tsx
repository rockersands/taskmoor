import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePlanClient } from './fixtures';
import { PlansPage } from './PlansPage';

const meta = {
  title: 'Plans/PlansPage',
  component: PlansPage,
  args: { client: fakePlanClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PlansPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Multi-track: the person's plans and those shared with them. */
export const Plans: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Data centre move' })).toBeVisible();
  },
};

/** A new plan: a name and its tracks and saved searches. */
export const NewPlan: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New plan' }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'SHOP · Shop' }));
    await expect(canvas.getByText('1 source chosen')).toBeVisible();
  },
};
