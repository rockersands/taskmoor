import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePeopleClient } from './fixtures';
import { PersonPage } from './PersonPage';

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
  title: 'Admin/Person',
  component: PersonPage,
  args: { userId: 3, client: fakePeopleClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PersonPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Grace, opened by Edit on her row (T-331): a configuration administrator through Approvers who
 * runs two tracks, with a second factor; every action for her on one page.
 */
export const Person: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Grace Hopper' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Through the group Approvers' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'OPS · Operations' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Reset second factor' })).toBeVisible();
  },
};

/** Someone with no role: Member. */
export const AMember: Story = {
  args: { userId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Member: they hold no administrator role and run no track.'),
    ).toBeVisible();
  },
};

/** Ken, deactivated: Reactivate instead of Deactivate, and no password link. */
export const Deactivated: Story = {
  args: { userId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Reactivate' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'New password link' })).toBeNull();
  },
};

/** The signed-in administrator's own page: nothing that acts on themselves. */
export const Yourself: Story = {
  args: { userId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^This is you:/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  },
};

/** A person a read-only directory keeps: where their name changes, and no break-glass mark. */
export const KeptByADirectory: Story = {
  args: { userId: 2, client: fakePeopleClient({ directoryPerson: 2 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Corporate directory keeps this person: their name and email change there, not here.',
      ),
    ).toBeVisible();
  },
};

/** Resetting a second factor asks first, saying what stops working (D13). */
export const ResettingASecondFactor: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Reset second factor' }));
    await expect(
      canvas.getByRole('button', { name: 'Reset second factor of Grace Hopper' }),
    ).toBeVisible();
  },
};

/** A person's data (ASVS 8.3.2) and erasing them, confirmed by their email. */
export const ErasingSomeone: Story = {
  args: { userId: 2, client: fakePeopleClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Data of Bo Rivera' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Erase…' }));
    await userEvent.type(canvas.getByLabelText('Type bo@example.com to confirm'), 'bo@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Erase permanently' }));
    await expect(await canvas.findByText(/they are Former user 2 from now on/)).toBeVisible();
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

/** On a phone, with the erase form open: nothing sticks out sideways. */
export const PersonAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Erase…' }));
    await expect(canvas.getByRole('form', { name: 'Erase Grace Hopper' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A finger reaches every action, both answers of a question included (ADR-033). */
export const PersonOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Grace Hopper' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.people-action',
        '.button-danger-quiet',
        '.people-form .button-primary',
        '.people-form select',
        '.people-form input',
        '.person-sources a',
        '.person-where a',
      ]),
    ).toEqual([]);
    await userEvent.click(canvas.getByRole('button', { name: 'Deactivate' }));
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.danger-confirm .button-danger',
        '.danger-confirm .button-secondary',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};
