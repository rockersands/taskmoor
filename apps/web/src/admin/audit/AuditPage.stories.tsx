import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../../session/SessionProvider';
import { ADMIN, MEMBER } from '../fixtures';
import { AuditPage } from './AuditPage';
import { fakeAuditClient } from './fixtures';

const meta = {
  title: 'Admin/AuditPage',
  component: AuditPage,
  args: { client: fakeAuditClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AuditPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A morning's records, the downloads, the chain check and the settings. */
export const Records: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Download as CSV' })).toBeVisible();
  },
};

export const BrokenChain: Story = { args: { client: fakeAuditClient({ brokenAt: 2 }) } };

export const Empty: Story = { args: { client: fakeAuditClient({ records: [] }) } };

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No records match.')).toBeVisible();
    await expect(canvas.getByText(/^Try a wider filter/)).toBeVisible();
  },
};
