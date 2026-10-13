import type { Meta, StoryObj } from '@storybook/react-vite';
import { useT } from '../i18n/I18nProvider';
import { POLICY, personalTokens, RIVER_OWNER, ROBOT_OWNER, sampleToken } from './fixtures';
import { TokenItem } from './TokenItem';

const [inUse, dueSoon, neverUsed, revoked, expired] = personalTokens();

const meta = {
  title: 'Tokens/TokenItem',
  component: TokenItem,
  args: {
    token: inUse ?? sampleToken({ id: 1, name: 'Token' }),
    reminderDays: POLICY.reminderDays,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 760 }}>
        <ul className="token-list">
          <Story />
        </ul>
      </main>
    ),
  ],
} satisfies Meta<typeof TokenItem>;

export default meta;
type Story = StoryObj<typeof meta>;

function RevokeButton() {
  const t = useT();
  return (
    <button type="button" className="button-secondary">
      {t('tokens.revoke')}
    </button>
  );
}

const revoke = <RevokeButton />;

export const InUse: Story = { args: { actions: revoke } };

export const DueForRotation: Story = {
  args: { ...(dueSoon ? { token: dueSoon } : {}), actions: revoke },
};

export const NeverUsed: Story = { args: { ...(neverUsed ? { token: neverUsed } : {}) } };

export const Revoked: Story = { args: { ...(revoked ? { token: revoked } : {}) } };

export const Expired: Story = { args: { ...(expired ? { token: expired } : {}) } };

export const InTheInventory: Story = {
  args: {
    token: sampleToken({ id: 51, name: 'Sync job', owner: RIVER_OWNER, scopes: ['read', 'write'] }),
    showOwner: true,
    actions: revoke,
  },
};

export const ReplacedServiceAccountToken: Story = {
  args: {
    token: sampleToken({
      id: 61,
      name: 'Release key',
      owner: ROBOT_OWNER,
      scopes: ['read', 'write', 'admin'],
      replacedBy: 62,
      expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
    }),
    showOwner: true,
    timeZone: 'Pacific/Auckland',
  },
};

export const OwnerDeactivated: Story = {
  args: {
    token: sampleToken({
      id: 70,
      name: 'Left behind',
      owner: { ...RIVER_OWNER, active: false },
    }),
    showOwner: true,
  },
};

export const Phone: Story = {
  args: { showOwner: true, actions: revoke },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
