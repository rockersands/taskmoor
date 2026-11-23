import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
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
  args: {
    client: fakeNotificationsClient(
      {},
      { ...defaultPreferences(), quietHours: { start: 22, end: 7 } },
    ),
  },
  play: async ({ canvasElement }) => {
    const boxes = await within(canvasElement).findAllByRole('checkbox');
    await expect(boxes.flatMap((box) => drawnAsTheAppsCheckBox(box, canvasElement))).toEqual([]);
  },
};

/** A tap anywhere in a cell of the matrix reaches its check box, drawn at 28 px (ADR-033, AC-12). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
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

/**
 * The boxes under the Email choices line up with its radios (D23): the controls start at one edge
 * and their words at another, with one size and gap, so the column reads as one list.
 */
async function choicesLineUp(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const controls = [
    ...(await canvas.findAllByRole('radio')),
    canvas.getByRole('checkbox', { name: 'Hold email during quiet hours' }),
    canvas.getByRole('checkbox', { name: 'Tell me about changes I make myself' }),
  ];
  const placed = controls.map((control) => {
    const box = control.getBoundingClientRect();
    const words = control.nextElementSibling?.getBoundingClientRect();
    return JSON.stringify({
      control: Math.round(box.left),
      size: Math.round(box.width),
      words: Math.round(words?.left ?? Number.NaN),
    });
  });
  await expect(new Set(placed).size).toBe(1);
}

export const ChoicesLineUp: Story = {
  play: async ({ canvasElement }) => choicesLineUp(canvasElement),
};

/** On a touch screen too, where every one of them is drawn at 28 px. */
export const ChoicesLineUpOnTouch: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => choicesLineUp(canvasElement),
};
