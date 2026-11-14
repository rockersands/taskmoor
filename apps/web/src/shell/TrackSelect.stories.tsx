import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { type TrackOption, TrackSelect } from './TrackSelect';

const TRACKS: TrackOption[] = [
  { id: 1, key: 'SHOP', name: 'Shop' },
  { id: 2, key: 'OPS', name: 'Operations', color: '#2f6fdb' },
  { id: 3, key: 'PAY', name: 'Payments and refunds across every region', color: '#c4314b' },
];

function Picker() {
  const [track, setTrack] = useState('SHOP');
  return (
    <div className="form-field" style={{ minHeight: '16rem', maxWidth: '20rem' }}>
      <label htmlFor="story-track" className="form-label">
        Track
      </label>
      <TrackSelect
        id="story-track"
        tracks={TRACKS}
        value={track}
        label={(t) => `${t.key} ${t.name}`}
        onChange={setTrack}
      />
    </div>
  );
}

const meta = { title: 'Shell/TrackSelect', component: Picker } satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each track with its mark, key and name; the keyboard works it as any icon select (T-255). */
export const Choosing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('combobox', { name: 'Track' });
    await expect(box).toHaveTextContent('SHOP Shop');
    await userEvent.click(box);
    await expect(canvas.getByRole('option', { name: 'SHOP Shop' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(box).toHaveTextContent('OPS Operations');
  },
};

/** At a small phone's width the long name ends in an ellipsis, never a sideways scroll. */
export const AtPhoneWidth: Story = {
  decorators: [
    (Story) => (
      <div data-testid="phone-width" style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Track' }));
    await userEvent.click(
      canvas.getByRole('option', { name: 'PAY Payments and refunds across every region' }),
    );
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
