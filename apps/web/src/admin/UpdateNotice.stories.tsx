import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, MEMBER } from './fixtures';
import {
  type UpdateCheck,
  type UpdateCheckClient,
  UpdateCheckSection,
  UpdateNotice,
} from './UpdateNotice';

const AVAILABLE: UpdateCheck = {
  version: '1.2.0',
  enabled: true,
  environmentOff: false,
  developmentBuild: false,
  checkedAt: '2026-11-01T09:30:00.000Z',
  latest: '1.4.0',
  updateAvailable: true,
  command: 'bash update.sh 1.4.0',
  releaseUrl: 'https://github.com/Rockersands/taskmoor/releases/tag/v1.4.0',
};
const CURRENT: UpdateCheck = {
  ...AVAILABLE,
  latest: '1.2.0',
  updateAvailable: false,
  command: null,
  releaseUrl: null,
};
const ENVIRONMENT_OFF: UpdateCheck = {
  ...CURRENT,
  enabled: true,
  environmentOff: true,
  latest: null,
  checkedAt: null,
};

const client = (answer: UpdateCheck): UpdateCheckClient => ({
  load: async () => answer,
  setEnabled: async (enabled) => ({ ...answer, enabled }),
});

/** Stories pass the answer in; nothing calls a backend. */
const meta = {
  title: 'Admin/UpdateNotice',
  component: UpdateNotice,
  args: { client: client(AVAILABLE) },
  decorators: [
    (Story) => {
      try {
        window.localStorage.removeItem('taskmoor.updateNotice.putOff');
      } catch {
        // Stories do not depend on it.
      }
      return (
        <SessionProvider session={ADMIN}>
          <main style={{ padding: 24 }}>
            <h1>Board</h1>
            <Story />
          </main>
        </SessionProvider>
      );
    },
  ],
} satisfies Meta<typeof UpdateNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A newer release: the version, the exact command, and no button that would update from here. */
export const Available: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: 'Taskmoor 1.4.0 is available.' }),
    ).toBeVisible();
    await expect(canvas.getByText('bash update.sh 1.4.0')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^update/i })).toBeNull();
  },
};

/** The longest command there is, at the width of a small phone: it wraps, and nothing overflows. */
export const OnAPhone: Story = {
  args: {
    client: client({
      ...AVAILABLE,
      command:
        'helm upgrade taskmoor deploy/helm/taskmoor --reuse-values --set image.tag=1.4.0 --namespace a-rather-long-namespace-name',
    }),
  },
  decorators: [
    (Story) => (
      <div data-testid="phone" style={{ width: 312 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Taskmoor 1.4.0 is available.' });
    const phone = canvas.getByTestId('phone');
    await expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth);
    await expect(canvas.getByRole('button', { name: 'Not now' })).toBeVisible();
  },
};

/** Nothing newer: no notice. */
export const UpToDate: Story = { args: { client: client(CURRENT) } };

/** Anyone else sees nothing and asks nothing. */
export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

/** The status page's card, with a newer release. */
export const CardAvailable: StoryObj<typeof UpdateCheckSection> = {
  render: () => <UpdateCheckSection client={client(AVAILABLE)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Updates' })).toBeVisible();
    await expect(
      canvas.getByRole('checkbox', { name: 'Look for new versions once a day' }),
    ).toBeChecked();
  },
};

/** The card when this version is the newest. */
export const CardCurrent: StoryObj<typeof UpdateCheckSection> = {
  render: () => <UpdateCheckSection client={client(CURRENT)} />,
};

/** The card when TASKMOOR_UPDATE_CHECK=off overrules the setting. */
export const CardOffOnTheServer: StoryObj<typeof UpdateCheckSection> = {
  render: () => <UpdateCheckSection client={client(ENVIRONMENT_OFF)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox')).toBeDisabled();
  },
};
