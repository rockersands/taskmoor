import type { Meta, StoryObj } from '@storybook/react-vite';
import { writeDocToYDoc } from '@taskmoor/richtext';
import type { ReactElement } from 'react';
import { type ReactNode, useEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { router } from '../../routing/router';
import { SessionProvider } from '../../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../../test/touch';
import { fakeCloneClient } from '../clone/fixtures';
import { fakeToolsClient } from '../tools/fixtures';
import type { TicketClient } from './client';
import { fakeTicketClient, SHOP_41, SHOP_41_SOME_FIELDS } from './fixtures';
import { TicketPage } from './TicketPage';

/** The description's shared document, kept in the page. */
const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

/** The app's links, taken over by the router as the app does, with a way out of the page. */
function InTheApp({ children }: { children: ReactNode }) {
  useEffect(() => router.start(), []);
  return (
    <>
      <nav>
        <a href="#/boards">Boards</a>
      </nav>
      {children}
    </>
  );
}

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
  title: 'Tickets/TicketPage',
  component: TicketPage,
  args: {
    ticket: 'SHOP-41',
    client: fakeTicketClient(),
    tools: fakeToolsClient(),
    comments: fakeCommentClient(),
    attachments: fakeAttachmentClient(),
    clone: fakeCloneClient().client,
    connect: inPage,
    mentions: () => async () => [],
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TicketPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A ticket in progress: details, transitions, links, files, the comments. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        level: 1,
        name: 'SHOP-41 Checkout fails for expired cards',
      }),
    ).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Follow (2)' })).toBeVisible();
  },
};

/** The History tab of the activity. */
export const History: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('tab', { name: 'History' }));
    await expect(await canvas.findByText('Changed Status from New to Active')).toBeVisible();
  },
};

/** SHOP-41 whose All feed comes in two pages, the older behind "Show older activity" (T-309). */
function inTwoPages(): TicketClient {
  const client = fakeTicketClient();
  return {
    ...client,
    activity: async (id, cursor) => {
      const page = await client.activity(id);
      return cursor === undefined
        ? { activity: page.activity.slice(0, 2), timeEntries: [], next: '11' }
        : { activity: page.activity.slice(2), timeEntries: page.timeEntries, next: null };
    },
  };
}

/**
 * The All tab of a busy ticket: the newest activity first, the older a finger-wide button away
 * on a touch screen (T-309).
 */
export const AllInPages: Story = {
  args: { client: inTwoPages() },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('tab', { name: 'All' }));
    const all = within(canvas.getByRole('tabpanel', { name: 'All' }));
    await expect(await all.findByText('Changed Status from New to Active')).toBeVisible();
    await expect(all.queryByText('Logged 2 h')).toBeNull();
    const more = all.getByRole('button', { name: 'Show older activity' });
    await expect(tooSmallForAFinger(canvasElement, ['.ticket-tabpanel .button-secondary'])).toEqual(
      [],
    );
    await userEvent.click(more);
    await expect(await all.findByText('Logged 2 h')).toBeVisible();
    await expect(all.getByText('Commented')).toBeVisible();
    await expect(all.queryByRole('button', { name: 'Show older activity' })).toBeNull();
  },
};

/** Closing asks for a close reason. */
export const Closing: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Status: / }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Closed' }));
    await expect(canvas.getByRole('combobox', { name: 'Close reason' })).toBeVisible();
  },
};

/** Someone who may not edit sees the priority's value, not a control; copying the link says so. */
export const MayNotEdit: Story = {
  args: { client: fakeTicketClient({ ticket: { ...SHOP_41, mayEdit: false } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const facts = within(await canvas.findByRole('region', { name: 'Details' }));
    await expect(facts.queryByRole('combobox', { name: 'Priority' })).toBeNull();
    await expect(facts.getByText('High')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Copy link' }));
    await expect(
      await canvas.findByText(/The (link to SHOP-41 is copied|browser did not allow)/),
    ).toBeVisible();
  },
};

/** A member who may change the labels, the due date and Points: controls there, values elsewhere. */
export const SomeFieldsOnly: Story = {
  args: { client: fakeTicketClient({ ticket: SHOP_41_SOME_FIELDS }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const facts = within(await canvas.findByRole('region', { name: 'Details' }));
    await expect(await facts.findByRole('button', { name: 'Edit labels' })).toBeVisible();
    await expect(facts.getByLabelText('Due date')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Edit summary' })).toBeNull();
    await expect(facts.queryByRole('button', { name: 'Unassign' })).toBeNull();
    await expect(facts.queryByRole('combobox', { name: 'Priority' })).toBeNull();
    await expect(facts.queryByLabelText('Start date')).toBeNull();
  },
};

/** The same on a phone. */
export const SomeFieldsOnlyOnAPhone: Story = {
  ...SomeFieldsOnly,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** Unsaved labels, and a link out of the page: it asks first (NFR-005). */
export const AsksBeforeLeaving: Story = {
  args: { client: fakeTicketClient() },
  decorators: [
    (Story) => (
      <InTheApp>
        <Story />
      </InTheApp>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const facts = within(await canvas.findByRole('region', { name: 'Details' }));
    await userEvent.click(await facts.findByRole('button', { name: 'Edit labels' }));
    await userEvent.type(facts.getByRole('textbox', { name: 'Labels' }), ' typed');
    await userEvent.click(canvas.getByRole('link', { name: 'Boards' }));
    await expect(
      await within(document.body).findByRole('alertdialog', {
        name: 'Discard what you have not saved?',
      }),
    ).toBeVisible();
  },
};

/** The keyboard shortcuts, open. */
export const Shortcuts: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Keyboard shortcuts' }));
    await expect(canvas.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  },
};

export const NotFound: Story = {
  args: { client: fakeTicketClient({ missing: true }) },
};

/** Files from outside the page held over the ticket's title, as a browser reports them. */
function filesOver(element: Element) {
  const transfer = new DataTransfer();
  transfer.items.add(new File(['bytes'], 'screen.png', { type: 'image/png' }));
  for (const type of ['dragenter', 'dragover']) {
    element.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }
}

/**
 * Files held over the ticket (T-162; CORE-021): the whole ticket is outlined, with a card that
 * names it and the size limit; let go anywhere on it, they go to its attachments.
 */
export const FilesOver: Story = {
  args: { attachments: fakeAttachmentClient() },
  beforeEach: () => () => {
    window.dispatchEvent(new Event('dragend'));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('heading', {
      level: 1,
      name: 'SHOP-41 Checkout fails for expired cards',
    });
    await canvas.findByLabelText('Attach files');
    filesOver(title);
    await expect(await canvas.findByText('Drop to attach to SHOP-41')).toBeVisible();
    await expect(canvas.getByText('Up to 1 GB a file')).toBeVisible();
  },
};

/** Files held over a ticket the person may not add files to: the card says why. */
export const FilesOverRefused: Story = {
  args: { attachments: fakeAttachmentClient({ canCreate: false }) },
  beforeEach: () => () => {
    window.dispatchEvent(new Event('dragend'));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('heading', {
      level: 1,
      name: 'SHOP-41 Checkout fails for expired cards',
    });
    await canvas.findByText('6 attachments');
    filesOver(title);
    await expect(
      await canvas.findByText('You may not attach files to this ticket.', {
        selector: '.file-drop-title',
      }),
    ).toBeVisible();
  },
};

/** A ticket at a phone's width: the title, the panels and the fields stay inside. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1 });
    await fitsPhoneWidth(canvas);
  },
};

/** On a touch screen a child's key and a short Activity tab are a finger wide (PL-26). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('tab', { name: 'All' });
    await canvas.findAllByRole('link', { name: /^SHOP-2\d\d$/ });
    await expect(tooSmallForAFinger(canvasElement, ['.ticket-tab', '.ticket-child > a'])).toEqual(
      [],
    );
  },
};

/**
 * On a touch phone the Activity tabs keep one row (CORE-019): 'All' never wraps alone under the
 * others, and the row stays inside the phone's width.
 */
export const ActivityTabsOnOneRow: Story = {
  beforeEach: onARealTouchScreen,
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('tab', { name: 'All' });
    const tabs = canvas.getAllByRole('tab');
    const top = tabs[0]?.getBoundingClientRect().top ?? 0;
    for (const tab of tabs) {
      await expect(tab.getBoundingClientRect().top, tab.textContent ?? '').toBe(top);
    }
    await fitsPhoneWidth(canvas);
  },
};

/** The status menu says where the ticket is now, above the places it can go (PL-47). */
export const StatusMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Status: / }));
    await expect(canvas.getByText(`Now: ${SHOP_41.status.name}`)).toBeVisible();
    await expect(canvas.getByRole('menu')).toBeVisible();
  },
};
