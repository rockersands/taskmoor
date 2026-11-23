import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { notSized, onARealTouchScreen } from '../test/touch';
import { AiSettingsPage } from './AiSettingsPage';
import { aiView, fakeAiClient } from './aiFixtures';
import { MEMBER } from './fixtures';

const meta = {
  title: 'Admin/AiSettingsPage',
  component: AiSettingsPage,
  args: { client: fakeAiClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AiSettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Anthropic API with a stored key, every feature on its default model. */
export const Configured: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('API key')).toHaveValue('');
    await expect(canvas.getAllByRole('combobox', { name: 'Model' })[0]).toHaveValue(
      'claude-opus-5-5',
    );
  },
};

/** AI off for the workspace: the feature and track controls are hidden. */
export const Off: Story = {
  args: { client: fakeAiClient(aiView({ enabled: false })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'Use AI on this site' });
    await expect(canvas.queryByRole('heading', { name: 'Tracks' })).toBeNull();
  },
};

/**
 * The settings card is as wide as the keys card under it (T-219's form widths); it was narrower,
 * x 605-1083 against 605-1243 at 1280.
 */
export const CardsAsWide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 900 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('form', { name: 'AI settings' });
    const keys = canvas.getByRole('heading', { name: 'Keys' }).closest('section') as HTMLElement;
    await expect(Math.round(form.getBoundingClientRect().width)).toBe(
      Math.round(keys.getBoundingClientRect().width),
    );
  },
};

/** Strict mode: one track opted in. */
export const Strict: Story = {
  args: { client: fakeAiClient(aiView({ strict: true, tracks: { '1': true } })) },
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
    await expect(await canvas.findByLabelText('API key')).toHaveValue('');
    await fitsPhoneWidth(canvas);
  },
};

/** The settings could not be read: the header stays, with the failure under it. */
export const LoadFailed: Story = {
  args: {
    client: {
      ...fakeAiClient(),
      load: async () => {
        throw new Error('network');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
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

/**
 * On a phone (a real touch screen at a phone's width) every check box is 28 px, the touch size of a box beside its label
 * (ADR-033, AD-22): the site switch, strict mode, each feature and each track.
 */
export const CheckBoxesOnAPhone: Story = {
  tags: ['touch'],
  args: { client: fakeAiClient(aiView({ strict: true, tracks: { '1': true } })) },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('checkbox', { name: 'Use AI on this site' });
    await expect(notSized(canvasElement, '.form-field-inline input[type="checkbox"]', 28)).toEqual(
      [],
    );
    await fitsPhoneWidth(canvas);
  },
};
