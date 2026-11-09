import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakePlanClient } from './fixtures';
import { PlanShareActions } from './PlanShareActions';

/** The header's actions on every tab of a plan (PLN-014): a link to the view, and a copy. */
const meta = {
  title: 'Plans/PlanShareActions',
  component: PlanShareActions,
  args: {
    plan: { id: 12, name: 'Spring launch', hiddenSources: 0 },
    client: fakePlanClient(),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <div className="page-header-actions plan-page">
          <Story />
        </div>
      </main>
    ),
  ],
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline?zoom=months';
  },
} satisfies Meta<typeof PlanShareActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Actions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Duplicate plan' })).toBeVisible();
  },
};

/** The browser refuses the clipboard, as on plain http: the link in a field, selected. */
export const ClipboardRefused: Story = {
  beforeEach: () => {
    window.location.hash = '#/plans/12/timeline?zoom=months';
    const held = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    return () => {
      if (held) Object.defineProperty(navigator, 'clipboard', held);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Copy link' }));
    const field = await canvas.findByLabelText<HTMLInputElement>('Link to this view');
    await expect(field.value).toContain('zoom=months');
    await expect(field).toHaveAttribute('readonly');
  },
};

/** A finger reaches both (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await expect(tooSmallForAFinger(canvasElement, ['button'])).toEqual([]);
  },
};
