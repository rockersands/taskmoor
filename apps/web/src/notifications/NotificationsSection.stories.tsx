import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { defaultPreferences, fakeNotificationsClient } from './fixtures';
import { NotificationsSection } from './NotificationsSection';

/** Stories save to in-memory settings; nothing calls a server. */
const meta = {
  title: 'Account/NotificationsSection',
  component: NotificationsSection,
  args: { client: fakeNotificationsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof NotificationsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EverythingOn: Story = {};

export const DigestWithQuietHours: Story = {
  args: {
    client: fakeNotificationsClient(
      {},
      {
        ...defaultPreferences(),
        emailDelivery: 'daily',
        quietHours: { start: 22, end: 7 },
        ownChanges: true,
      },
    ),
  },
};

export const Loading: Story = {
  args: { client: fakeNotificationsClient({ preferences: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeNotificationsClient({
      preferences: () => Promise.reject(new Error('backend down')),
    }),
  },
};

export const TurnsAnEmailOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Email: Ticket updated' }));
    await expect(await canvas.findByText('Notification settings saved.')).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Email: Ticket updated' })).not.toBeChecked();
  },
};

/** The look of a check box drawn by forms.css, read from a bare one put beside the section. */
function drawnAsTheAppsCheckBox(box: Element, beside: Element): string[] {
  const probe = document.createElement('input');
  probe.type = 'checkbox';
  probe.checked = (box as HTMLInputElement).checked;
  beside.append(probe);
  try {
    const want = getComputedStyle(probe);
    const got = getComputedStyle(box);
    return (['appearance', 'backgroundColor', 'borderColor', 'boxShadow'] as const)
      .filter((property) => got[property] !== want[property])
      .map((property) => `${box.getAttribute('aria-label') ?? box.id}: ${property}`);
  } finally {
    probe.remove();
  }
}

/** Every check box here is the app's one check box, as on the rest of Account (TR-24, AC-11). */
export const OneCheckBoxLook: Story = {
  args: DigestWithQuietHours.args,
  play: async ({ canvasElement }) => {
    const boxes = await within(canvasElement).findAllByRole('checkbox');
    await expect(boxes.flatMap((box) => drawnAsTheAppsCheckBox(box, canvasElement))).toEqual([]);
  },
};

/** A tap anywhere in a cell of the matrix reaches its check box, drawn at 28 px (ADR-033, AC-12). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const boxes = await within(canvasElement).findAllByRole('checkbox');
    await expect(tooSmallForAFinger(canvasElement, ['.notification-cell'])).toEqual([]);
    const sizes = boxes.map((box) => {
      const { width, height } = box.getBoundingClientRect();
      return `${Math.round(width)} x ${Math.round(height)}`;
    });
    await expect(new Set(sizes)).toEqual(new Set(['28 x 28']));
  },
};
