import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePlanClient } from './fixtures';
import { PlansPage } from './PlansPage';

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
  title: 'Plans/PlansPage',
  component: PlansPage,
  args: { client: fakePlanClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PlansPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Multi-track: the person's plans and those shared with them. */
export const Plans: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Data centre move' })).toBeVisible();
  },
};

/** A new plan: a name and its tracks and saved searches. */
export const NewPlan: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New plan' }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'SHOP · Shop' }));
    await expect(canvas.getByText('1 source chosen')).toBeVisible();
  },
};

/** No plan yet: what one is, and the button in the header makes the first. */
export const NoPlans: Story = {
  args: { client: { ...fakePlanClient(), list: async () => [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No plans yet.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'New plan' })).toBeVisible();
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Data centre move' })).toBeVisible();
    await expect(canvas.getByText(/^A plan shows the work/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A finger reaches each plan's name (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('listitem');
    await expect(tooSmallForAFinger(canvasElement, ['.dashboard-row > a'])).toEqual([]);
  },
};
