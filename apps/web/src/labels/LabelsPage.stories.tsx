import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeLabelsClient } from './fixtures';
import { LabelsPage } from './LabelsPage';

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
  title: 'Admin/Labels',
  component: LabelsPage,
  args: { client: fakeLabelsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof LabelsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ticks two words for the front end and types the one they become. */
async function tickTwo(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'front-end' }));
  await userEvent.click(canvas.getByRole('checkbox', { name: 'fe' }));
  await userEvent.type(canvas.getByLabelText('They become'), 'frontend');
}

/** The site's labels, each with how many tickets have it; nothing ticked yet. */
export const Labels: Story = {
  args: { client: fakeLabelsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox', { name: 'old-sprint' })).toBeVisible();
    await expect(canvas.getByText('No label is ticked yet.')).toBeVisible();
  },
};

/** Two labels ticked and the word they become: the merge asks first, saying what changes. */
export const MergeAsksFirst: Story = {
  args: { client: fakeLabelsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await tickTwo(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Merge' }));
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expect(canvas.getByRole('button', { name: 'Merge into frontend' })).toBeVisible();
  },
};

/** A word with a space in it: the field says why, and the merge waits. */
export const NotOneWord: Story = {
  args: { client: fakeLabelsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'ops' }));
    await userEvent.type(canvas.getByLabelText('They become'), 'two words');
    await expect(
      canvas.getByText('A label is one word of up to 255 characters, with no spaces.'),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Rename' })).toBeDisabled();
  },
};

/** More labels than one page: Show more labels reads the next ones. */
export const ManyLabels: Story = {
  args: { client: fakeLabelsClient({ many: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Show more labels' })).toBeVisible();
  },
};

/** Someone who is neither kind of administrator: the page's name and the refusal alone. */
export const Refused: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^Only site and configuration administrators/)).toBeVisible();
  },
};

/** A label as long as a label may be, ticked, on a phone: every line wraps inside the word. */
export const AtPhoneWidth: Story = {
  args: {
    client: (() => {
      const client = fakeLabelsClient();
      const usage = client.usage;
      client.usage = async (query) => {
        const page = await usage(query);
        return { ...page, labels: [{ name: 'x'.repeat(255), ticketCount: 1 }, ...page.labels] };
      };
      return client;
    })(),
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'x'.repeat(255) }));
    await userEvent.type(canvas.getByLabelText('They become'), 'long');
    await userEvent.click(canvas.getByRole('button', { name: 'Rename' }));
    await fitsPhoneWidth(canvas);
  },
};

/** On a touch screen every box, button and field is a finger's size. */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  args: { client: fakeLabelsClient({ many: true }) },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await tickTwo(canvasElement);
    await expect(
      tooSmallForAFinger(canvasElement, [
        'label.form-field-inline',
        '.button-danger-quiet',
        '.form-actions .button-secondary',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(within(canvasElement));
  },
};
