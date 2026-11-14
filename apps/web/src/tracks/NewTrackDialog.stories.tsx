import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeConfigurationClient } from '../configuration/fixtures';
import { NewTrackDialog } from './NewTrackDialog';

/** Making a track from the Tracks directory, in its dialog. */
const meta = {
  title: 'Tracks/NewTrackDialog',
  component: NewTrackDialog,
  args: {
    client: fakeConfigurationClient(),
    modes: ['shared', 'local'],
    onClose: () => {},
    onAdded: () => {},
  },
} satisfies Meta<typeof NewTrackDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

/**
 * The form fills its dialog (AC-16): the fields reach the dialog's inside edge, as its intro line
 * does, rather than stopping at the people page's reading width with a fifth of the dialog empty.
 */
export const FormFillsTheDialog: Story = {
  play: async () => {
    // The dialog is drawn at the end of the page's body, outside the story's own element.
    const dialog = await within(document.body).findByRole('dialog', { name: 'New track' });
    const style = getComputedStyle(dialog);
    const box = dialog.getBoundingClientRect();
    const inside = {
      left:
        box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      right:
        box.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
    };
    // A desktop's dialog: wider than the reading width the form had before.
    await expect(inside.right - inside.left).toBeGreaterThan(560);
    for (const label of ['Key', 'Track name']) {
      const field = within(dialog).getByLabelText(label).getBoundingClientRect();
      await expect(Math.abs(field.left - inside.left)).toBeLessThanOrEqual(1);
      await expect(Math.abs(field.right - inside.right)).toBeLessThanOrEqual(1);
    }
  },
};
