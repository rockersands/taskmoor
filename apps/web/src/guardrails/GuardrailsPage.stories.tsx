import type { Meta, StoryObj } from '@storybook/react-vite';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeGuardrailsClient } from './fixtures';
import { GuardrailsPage } from './GuardrailsPage';

const meta = {
  title: 'Admin/Guardrails',
  component: GuardrailsPage,
  args: { client: fakeGuardrailsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof GuardrailsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every limit with its usage; one is above a lowered limit. */
export const Guardrails: Story = {};
