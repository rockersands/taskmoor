import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { PermissionExplainerPage } from './PermissionExplainerPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeExplainClient, fakeVisibilityClient } from './visibilityFixtures';

const meta = {
  title: 'Admin/VisibilityPolicies',
  component: VisibilityPage,
  args: { client: fakeVisibilityClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof VisibilityPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A policy in use with two levels, and one no track uses. */
export const Policies: Story = {};

/** No policy yet: what one is for. */
export const Empty: Story = { args: { client: fakeVisibilityClient([]) } };

/** The explainer, asked about a ticket a level hides. */
export const Explainer: Story = {
  render: () => <PermissionExplainerPage client={fakeExplainClient()} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const form = await page.findByRole('form', { name: 'Ask why' });
    await userEvent.type(within(form).getByLabelText('Ticket key (optional)'), 'SHOP-9');
    await userEvent.click(within(form).getByRole('button', { name: 'Explain' }));
    await expect(await page.findByText(/SHOP-9 is at the level Security/)).toBeVisible();
  },
};
