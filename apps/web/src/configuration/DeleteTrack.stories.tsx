import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import type { Track } from './client';
import { DeleteTrack } from './DeleteTrack';
import { fakeConfigurationClient } from './fixtures';
import { TracksAdminPage } from './TracksAdminPage';

const SHOP: Track = {
  id: 3,
  key: 'SHOP',
  name: 'Shop',
  description: '',
  mode: 'shared',
  workflowMapId: null,
  archived: false,
};

const meta = {
  title: 'Admin/DeleteTrack',
  component: DeleteTrack,
  args: {
    track: SHOP,
    client: fakeConfigurationClient(),
    onDeleted: fn(),
    onProblem: fn(),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <div className="form-actions">
            <Story />
          </div>
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof DeleteTrack>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first step: a danger button named after the track (ADR-114 D13). */
export const Button: Story = {};

/** The question says what goes to the trash with the track, and that Trash can bring it back. */
export const Asking: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete track SHOP' }));
    const question = canvas.getByRole('group', { name: /^SHOP goes to the trash/ });
    await expect(question).toHaveTextContent('restored from Trash');
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expect(args.onDeleted).not.toHaveBeenCalled();
  },
};

/**
 * A track someone else put in the trash meanwhile: the refusal goes to the page with where the
 * track went, and the question stays open until the page reads its list again.
 */
export const Refused: Story = {
  args: {
    client: {
      ...fakeConfigurationClient(),
      deleteTrack: async () => {
        throw new ApiError(409, { error: 'in_trash' });
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete track SHOP' }));
    const question = canvas.getByRole('group', { name: /^SHOP goes to the trash/ });
    await userEvent.click(within(question).getByRole('button', { name: 'Delete track SHOP' }));
    await expect(args.onProblem).toHaveBeenCalledWith(
      'Track SHOP is in the trash already.',
      'trash',
    );
    await expect(question).toBeVisible();
  },
};

/** On the Tracks page: the track leaves the list, with the way to restore it from Trash. */
export const OnTheTracksPage: Story = {
  // A client of its own each time: the delete changes it, and the story runs in both skins.
  render: () => <TracksAdminPage client={fakeConfigurationClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage track SHOP' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Delete track SHOP' }));
    const question = canvas.getByRole('group', { name: /^SHOP goes to the trash/ });
    await userEvent.click(within(question).getByRole('button', { name: 'Delete track SHOP' }));
    await expect(await canvas.findByText('Track SHOP is in the trash.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Restore SHOP from Trash' })).toBeVisible();
  },
};

/** A finger reaches the button and both answers of the question (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(tooSmallForAFinger(canvasElement, ['.button-danger-quiet'])).toEqual([]);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete track SHOP' }));
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.danger-confirm .button-danger',
        '.danger-confirm .button-secondary',
      ]),
    ).toEqual([]);
  },
};
