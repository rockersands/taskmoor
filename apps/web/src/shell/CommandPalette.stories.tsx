import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { type Command, CommandPalette } from './CommandPalette';

const commands: Command[] = [
  { id: 'go-home', labelId: 'nav.home', run: () => {} },
  { id: 'go-tracks', labelId: 'nav.tracks', run: () => {} },
  { id: 'go-boards', labelId: 'nav.boards', run: () => {} },
  { id: 'go-settings', labelId: 'nav.settings', run: () => {} },
];

const meta = {
  title: 'Shell/CommandPalette',
  component: CommandPalette,
  args: { commands },
  decorators: [
    (Story) => (
      <div style={{ padding: 16, minHeight: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Search or jump to/ }));
    // Drawn at the end of the page's body, out of the top bar (OverlayLayer).
    const body = within(document.body);
    await expect(body.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  },
};

export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Search or jump to/ }));
    await userEvent.keyboard('trac');
    await expect(within(document.body).getAllByRole('option')).toHaveLength(1);
  },
};

/** The palette as a site administrator has it on a ticket: more commands than fit. */
const many: Command[] = [
  ...commands,
  ...(
    [
      'nav.inbox',
      'nav.search',
      'nav.dashboards',
      'nav.plans',
      'account.title',
      'palette.appearance.light',
      'palette.appearance.dark',
      'palette.appearance.system',
      'palette.signOut',
    ] as const
  ).map((labelId) => ({ id: labelId, labelId, run: () => {} })),
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    id: `follow-${n}`,
    labelId: 'palette.ticket.follow' as const,
    values: { key: `MOB-${n}` },
    run: () => {},
  })),
];

/** Whether the list's foot fades out. */
const fadesAtFoot = (list: HTMLElement) => getComputedStyle(list).maskImage.includes('gradient');

/**
 * PL-49, ADR-033: on a phone the list holds half the window and can end on a whole command, so
 * its foot fades while more follow (Account, the appearance choices and Sign out lie below). The
 * fade goes once the list is scrolled to its end, and when a filter leaves only a few commands.
 */
export const MoreBelowFades: Story = {
  args: { commands: many },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Search or jump to/ }));
    const list = await within(document.body).findByRole('listbox', { name: 'Commands' });
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    await expect(fadesAtFoot(list)).toBe(true);
    list.scrollTop = list.scrollHeight;
    await waitFor(() => expect(fadesAtFoot(list)).toBe(false));
    list.scrollTop = 0;
    await waitFor(() => expect(fadesAtFoot(list)).toBe(true));
    await userEvent.keyboard('sign');
    await waitFor(() => expect(fadesAtFoot(list)).toBe(false));
  },
};
