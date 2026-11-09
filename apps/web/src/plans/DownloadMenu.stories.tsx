import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { DownloadMenu } from './DownloadMenu';

/** Downloading a plan's view (PLN-014): CSV and, on the Timeline, an image. */
const meta = {
  title: 'Plans/DownloadMenu',
  component: DownloadMenu,
  args: {
    items: [
      { key: 'csv', label: 'CSV', make: fn(async () => 'Spring-launch-timeline-2026-11-04.csv') },
      {
        key: 'image',
        label: 'Image (PNG)',
        failed: 'This browser could not draw the image, so nothing was downloaded.',
        make: async () => {
          throw new Error('image_failed');
        },
      },
    ],
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, minHeight: 220 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DownloadMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, with what the file leaves out beneath it. */
export const WithNotes: Story = {
  args: {
    notes: [
      'The file holds the first 10,000 tickets, as this view does. Filter the plan for the rest.',
      'First 400 of 10,000 rows: filter the plan for the rest.',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(canvas.getByText(/^First 400 of 10,000 rows/)).toBeVisible();
  },
};

/** Open, then a file made: it says which. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Download' }));
    await expect(await canvas.findByRole('menuitem', { name: 'CSV' })).toBeVisible();
    await expect(canvas.getByRole('menuitem', { name: 'Image (PNG)' })).toBeVisible();
  },
};

export const Downloaded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Download' }));
    await userEvent.click(await canvas.findByRole('menuitem', { name: 'CSV' }));
    await expect(await canvas.findByText(/^Downloaded Spring-launch/)).toBeVisible();
  },
};

/** The browser could not draw it: said in words, and no file comes. */
export const ImageFailed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Download' }));
    await userEvent.click(await canvas.findByRole('menuitem', { name: 'Image (PNG)' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('could not draw the image');
  },
};

/** A finger reaches the button and each file (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Download' }));
    await canvas.findByRole('menuitem', { name: 'CSV' });
    await expect(
      tooSmallForAFinger(canvasElement, ['.plan-download button', '.user-menu-item']),
    ).toEqual([]);
  },
};
