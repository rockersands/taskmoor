import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { AreasPage } from './AreasPage';
import { AREAS, fakeAreaClient, SHOP } from './fixtures';

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

/** Delete on an area tickets are in, answered: the row asks where they go. */
const askWhereTicketsGo = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Delete area Checkout' }));
  await userEvent.click(
    within(canvas.getByRole('group')).getByRole('button', { name: 'Delete area Checkout' }),
  );
  return canvas.findByRole('form', { name: 'Where tickets in Checkout go' });
};

const meta = {
  title: 'Areas/AreasPage',
  component: AreasPage,
  args: { client: fakeAreaClient(), trackKey: 'SHOP' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AreasPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A track's areas as its administrators see them: two in use, one archived. */
export const OfATrack: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Areas' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Archived areas' })).toBeVisible();
  },
};

/** Someone who sees the track and may not change its areas: the list alone. */
export const ReadOnly: Story = {
  args: { client: fakeAreaClient(AREAS, { mayManage: false }) },
};

/** An archived track: its areas stay as they are. */
export const OfAnArchivedTrack: Story = {
  args: { client: fakeAreaClient(AREAS, { track: { ...SHOP, archived: true } }) },
};

export const Empty: Story = { args: { client: fakeAreaClient([]) } };

/** The form for a new area, with its owner and rule. */
export const Adding: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New area' }));
    const form = canvas.getByRole('form', { name: 'New area' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Billing');
    await userEvent.type(within(form).getByRole('searchbox', { name: 'Owner' }), 'ana');
    await userEvent.click(await within(form).findByRole('button', { name: 'Ana Duarte' }));
    await expect(within(form).getByRole('button', { name: 'Save the area' })).toBeEnabled();
  },
};

/** An area's form open to change it, its owner and team chosen. */
export const Changing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change area Checkout' }));
    const form = canvas.getByRole('form', { name: 'Change area Checkout' });
    await expect(within(form).getByText('Sam Rivera')).toBeVisible();
    await expect(within(form).getByText('Payments')).toBeVisible();
  },
};

/** Deleting an area tickets are in: where they go, another area or none (D13). */
export const DeletingOneInUse: Story = {
  play: async ({ canvasElement }) => {
    const form = await askWhereTicketsGo(canvasElement);
    await expect(within(form).getByRole('combobox', { name: 'Move them to' })).toHaveFocus();
  },
};

/** The areas on a phone: the track's name over the title, nothing past the edge. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Areas' })).toBeVisible();
    await canvas.findByText('Owner: Sam Rivera');
    await fitsPhoneWidth(canvas);
  },
};

/** The form on a phone, its pickers and rule in one column. */
export const AddingAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New area' }));
    await expect(canvas.getByRole('form', { name: 'New area' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** Where an area's tickets go, on a phone. */
export const DeletingAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    await askWhereTicketsGo(canvasElement);
    await fitsPhoneWidth(within(canvasElement));
  },
};

/** A finger reaches every action of a row and the choice of where tickets go (ADR-033). */
export const OnATouchScreen: Story = {
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await askWhereTicketsGo(canvasElement);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.admin-new',
        '.people-action',
        '.button-danger-quiet',
        '.people-panel select',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(within(canvasElement));
  },
};
