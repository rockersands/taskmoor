import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { BulkOperationPage } from './BulkOperationPage';
import { FAILURES, fakeBulkClient, RUNNING } from './fixtures';

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

const meta = {
  title: 'Tickets/BulkOperationPage',
  component: BulkOperationPage,
  args: { id: '7', client: fakeBulkClient(), pollMs: 60_000 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BulkOperationPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Part way through, with three tickets that were not changed and why. */
export const Running: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Bulk edit of 1,200 tickets' }),
    ).toBeVisible();
    await expect(canvas.getByLabelText('643 of 1,200 tickets finished')).toBeVisible();
    await expect(
      canvas.getByText('In status Approved, only the Approvers group can edit this ticket.'),
    ).toBeVisible();
  },
};

export const Done: Story = {
  args: {
    client: fakeBulkClient(
      { ...RUNNING, status: 'done', succeeded: 1200, failed: 0, pending: 0 },
      { failures: [] },
    ),
  },
};

/** Done, but some tickets failed: a warning naming the change and listing each one (PL-23, D14). */
export const DoneWithFailures: Story = {
  args: {
    client: fakeBulkClient({ ...RUNNING, status: 'done', succeeded: 1197, pending: 0 }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      /^The bulk edit finished with problems: 1,197 tickets were changed, and 3 tickets were not\./,
    );
    await expect(canvas.queryByText('Done.')).toBeNull();
  },
};

/**
 * On a touch screen a finger reaches each ticket key, the changed ones and those that were not
 * (S3-WK-7, ADR-033): each stands alone on its line, so each is a finger's height.
 */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  decorators: [atPhoneWidth],
  args: {
    client: fakeBulkClient(
      { ...RUNNING, status: 'done', succeeded: 2, failed: 1, pending: 0, total: 3 },
      {
        failures: FAILURES.slice(0, 1),
        changed: [
          {
            position: 1,
            ref: 'SHOP-41',
            key: 'SHOP-41',
            outcome: 'done',
            statusCode: 200,
            error: null,
          },
          {
            position: 2,
            ref: 'SHOP-42',
            key: 'SHOP-42',
            outcome: 'done',
            statusCode: 200,
            error: null,
          },
        ],
      },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'SHOP-42' });
    await canvas.findByRole('link', { name: 'SHOP-12' });
    await expect(tooSmallForAFinger(canvasElement, ['.bulk-changed a', '.bulk-ticket a'])).toEqual(
      [],
    );
    await fitsPhoneWidth(canvas);
  },
};

export const Cancel: Story = {
  args: { client: fakeBulkClient(RUNNING, { step: 0 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel the rest' }));
    await expect(await canvas.findByText('Cancelling after the tickets in hand.')).toBeVisible();
  },
};

/** At a phone's width: the counts wrap and the tickets not changed stay inside. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Bulk edit of 1,200 tickets' }),
    ).toBeVisible();
    await expect(canvas.getByText(/^How a change to many tickets/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A bulk change that cannot be found gets the shared not-found page (D4): it says so, with Home and Search. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeBulkClient(),
      get: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Bulk change not found' }),
    ).toBeVisible();
    await expect(canvas.getByRole('alert')).toHaveTextContent(/^This bulk change does not exist/);
    await expect(canvas.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Search' })).toBeVisible();
  },
};
