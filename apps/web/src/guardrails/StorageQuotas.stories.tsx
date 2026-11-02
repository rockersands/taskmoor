import type { Meta, StoryObj } from '@storybook/react-vite';
import { fakeStorageClient, STORAGE } from './fixtures';
import { StorageQuotas } from './StorageQuotas';

const meta = {
  title: 'Admin/Storage quotas',
  component: StorageQuotas,
  args: { client: fakeStorageClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof StorageQuotas>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Both quotas set; the heaviest uploader is close to theirs. */
export const WithQuotas: Story = {};

/** The default: no quota at all, usage shown alone. */
export const NoQuotas: Story = {
  args: { client: fakeStorageClient({ ...STORAGE, workspaceQuota: null, personQuota: null }) },
};

/** A fresh workspace: nothing uploaded yet. */
export const Empty: Story = {
  args: {
    client: fakeStorageClient({
      ...STORAGE,
      workspaceQuota: null,
      personQuota: null,
      usage: { bytes: 0, files: 0, topPerson: null },
    }),
  },
};
