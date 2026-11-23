import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';

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
  title: 'Admin/Permissions',
  component: PermissionsPage,
  args: { client: fakePermissionsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PermissionsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Roles, policies and global permissions. */
export const Permissions: Story = {};

/**
 * The default policy open: its grants by permission, and the form to give one, opened from the
 * policy's New button as Global permissions' is (D11).
 */
export const PolicyOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'New permission in Default access policy' }),
    );
    await expect(
      await canvas.findByRole('form', { name: 'Give a permission in Default access policy' }),
    ).toBeVisible();
  },
};

/**
 * Removing a grant asks first, saying who loses what and in which tracks (D13, T-267); on a phone
 * the question takes the grant's whole row and nothing sticks out.
 */
export const RemovingAGrantAsksOnAPhone: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Role Members from See the track' }),
    );
    const question = canvas.getByRole('group', {
      name: 'Role Members loses See the track in SHOP, OPS, the 2 tracks that use this policy.',
    });
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await fitsPhoneWidth(canvas);
  },
};

/** All three parts on a phone, each on its card with its rows as wells. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Roles' })).toBeVisible();
    await expect(canvas.getByText(/^Roles, access policies and/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * On a phone every card puts its New button the same way: under its heading, at the start, and
 * not beside a short heading while a long one pushes it below (S3-AC-7). On a wide screen each
 * button sits at the end of its heading's row.
 */
export const NewButtonsOneWayOnAPhone: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Roles' });
    const pairs: [string, string][] = [
      ['Roles', 'New role'],
      ['Access policies', 'New access policy'],
      ['Global permissions', 'New global permission'],
    ];
    for (const [title, label] of pairs) {
      const heading = canvas.getByRole('heading', { name: title }).getBoundingClientRect();
      const button = canvas.getByRole('button', { name: label }).getBoundingClientRect();
      await expect(button.top).toBeGreaterThanOrEqual(heading.bottom - 1);
      await expect(Math.round(button.left)).toBe(Math.round(heading.left));
    }
    await fitsPhoneWidth(canvas);
  },
};

export const NewButtonsBesideTheHeadingOnADesktop: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 960 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Roles' });
    for (const [title, label] of [
      ['Roles', 'New role'],
      ['Access policies', 'New access policy'],
      ['Global permissions', 'New global permission'],
    ] as const) {
      const heading = canvas.getByRole('heading', { name: title }).getBoundingClientRect();
      const button = canvas.getByRole('button', { name: label }).getBoundingClientRect();
      await expect(button.top).toBeLessThan(heading.bottom);
      await expect(button.left).toBeGreaterThan(heading.right);
    }
  },
};
