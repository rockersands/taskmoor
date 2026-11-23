import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { notSized, onARealTouchScreen } from '../test/touch';
import { ADMIN, MEMBER } from './fixtures';
import { NetworkAccessPage } from './NetworkAccessPage';
import { fakeNetworkClient, OFFICE_LIST } from './networkFixtures';

const meta = {
  title: 'Admin/NetworkAccessPage',
  component: NetworkAccessPage,
  args: { client: fakeNetworkClient(OFFICE_LIST) },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof NetworkAccessPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The office network, with travelling staff allowed from anywhere. */
export const OfficeOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('checkbox', { name: 'Only allow these addresses' }),
    ).toBeChecked();
  },
};

export const Off: Story = { args: { client: fakeNetworkClient() } };

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
    await expect(
      await canvas.findByRole('checkbox', { name: 'Only allow these addresses' }),
    ).toBeChecked();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * On a phone (a real touch screen at a phone's width) the switch and each group's box are 28 px, the touch size of a box
 * beside its label (ADR-033, AD-22).
 */
export const CheckBoxesOnAPhone: Story = {
  tags: ['touch'],
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'Only allow these addresses' });
    await canvas.findByRole('checkbox', { name: 'Travelling staff' });
    await expect(notSized(canvasElement, '.form-field-inline input[type="checkbox"]', 28)).toEqual(
      [],
    );
    await fitsPhoneWidth(canvas);
  },
};
