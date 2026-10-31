import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AiSettingsPage } from './AiSettingsPage';
import { aiView, fakeAiClient } from './aiFixtures';

const meta = {
  title: 'Admin/AiSettingsPage',
  component: AiSettingsPage,
  args: { client: fakeAiClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AiSettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Anthropic API with a stored key, every feature on its default model. */
export const Configured: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('API key')).toHaveValue('');
    await expect(canvas.getAllByRole('combobox', { name: 'Model' })[0]).toHaveValue(
      'claude-opus-5-5',
    );
  },
};

/** AI off for the workspace: the feature and track controls are hidden. */
export const Off: Story = {
  args: { client: fakeAiClient(aiView({ enabled: false })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'Use AI in this workspace' });
    await expect(canvas.queryByRole('heading', { name: 'Tracks' })).toBeNull();
  },
};

/** Strict mode: one track opted in. */
export const Strict: Story = {
  args: { client: fakeAiClient(aiView({ strict: true, tracks: { '1': true } })) },
};
