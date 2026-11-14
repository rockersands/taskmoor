import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { CrossTrackReleasePage } from './CrossTrackReleasePage';
import { fakeCrossTrackClient } from './crossTrackFixtures';

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
  title: 'Releases/CrossTrackReleasePage',
  component: CrossTrackReleasePage,
  args: { id: 5, client: fakeCrossTrackClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CrossTrackReleasePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Its owner's view: the linked releases, one out of step, and one hidden, only counted. */
export const Owner: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Spring launch' })).toBeVisible();
    await expect(canvas.getByText('Out of step')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Move date' })).toBeVisible();
  },
};

/** Someone who sees a linked track: no move, no edit and no delete. */
export const Viewer: Story = {
  args: { client: fakeCrossTrackClient({ mayManage: false }) },
};

/** All its releases have shipped. */
export const Shipped: Story = {
  args: { client: fakeCrossTrackClient({ shipped: true }) },
};

/** One that does not exist, or is not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeCrossTrackClient(),
      get: async () => {
        throw new Error('down');
      },
    },
  },
};

/** The edit dialog, with ending when its work completes. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit' }));
    await expect(await within(document.body).findByRole('dialog')).toBeVisible();
  },
};

/** The dialog that links one more release. */
export const Linking: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Link a release' }));
    const dialog = await within(document.body).findByRole('dialog');
    await expect(await within(dialog).findByLabelText('Release')).toBeVisible();
  },
};

/** At a phone's width: the linked releases as cards, nothing sticking out. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Spring launch' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * Deleting one whose name is one long word, at a phone's width (PLN-007, D13, ADR-033): the answer
 * "Delete <name>" wraps inside the question instead of pushing the page sideways.
 */
export const DeletingALongNameAtPhoneWidth: Story = {
  args: {
    client: fakeCrossTrackClient({ name: 'PlataformaDeMigracionInfraestructura2027Global' }),
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete' }));
    const question = canvas.getByRole('group', { name: /PlataformaDeMigracion/ });
    const answer = within(question).getByRole('button', {
      name: 'Delete PlataformaDeMigracionInfraestructura2027Global',
    });
    await expect(answer.getBoundingClientRect().right).toBeLessThanOrEqual(
      question.getBoundingClientRect().right,
    );
    await fitsPhoneWidth(canvas);
  },
};

/** A finger reaches the choice to end when its work completes (ADR-033). */
export const EditOnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit' }));
    const dialog = await within(document.body).findByRole('dialog');
    await expect(tooSmallForAFinger(dialog, ['label.form-field-inline'])).toEqual([]);
  },
};

/** A finger reaches each linked release and each ticket (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Spring launch' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.release-table a',
        '.release-legend a',
        '.cross-track-table button',
      ]),
    ).toEqual([]);
  },
};
