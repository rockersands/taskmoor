import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../../session/SessionProvider';
import { ADMIN, MEMBER } from '../fixtures';
import { AuditPage } from './AuditPage';
import { fakeAuditClient, SWEEP_RECORDS } from './fixtures';

const meta = {
  title: 'Admin/AuditPage',
  component: AuditPage,
  args: { client: fakeAuditClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AuditPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A morning's records, the downloads, the chain check and the settings. */
export const Records: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Download as CSV' })).toBeVisible();
  },
};

export const BrokenChain: Story = { args: { client: fakeAuditClient({ brokenAt: 2 }) } };

export const Empty: Story = { args: { client: fakeAuditClient({ records: [] }) } };

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
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
    await expect(await canvas.findByRole('table')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** How many lines the text inside a node takes, by the bottoms of its text's boxes. */
const linesOf = (node: Node) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const bottoms = new Set<number>();
  for (let text = walker.currentNode; text; text = walker.nextNode() as Node) {
    if (text.nodeType !== Node.TEXT_NODE || !text.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) bottoms.add(Math.round(rect.bottom));
  }
  return bottoms.size;
};

/**
 * Beside Administration's list at 1280 px the table has about 640 px (AD-2): the day stands over
 * the time and the address under the name, so a two-word name stays on one line and so does
 * 'Ticket template created'. Every action reads in words (S3-AD-1); a role given names the role
 * and the person (S3-AD-4).
 */
export const BesideTheAdministrationList: Story = {
  args: { client: fakeAuditClient({ records: SWEEP_RECORDS }) },
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (i: number) => within(rows[i] as HTMLElement).getAllByRole('cell');
    await expect(cells(0)[2]).toHaveTextContent('Password link refused');
    await expect(cells(1)[2]).toHaveTextContent('Track role “Developers” given to Noor Haddad');
    await expect(cells(3)[2]).toHaveTextContent('Password changed');
    await expect(cells(4)[3]).toHaveTextContent('Ticket “MOB-12”');
    const template = cells(2);
    await expect(template[2]).toHaveTextContent('Ticket template created');
    await expect(linesOf(template[2] as HTMLElement)).toBe(1);
    // The name alone, without the address under it.
    await expect(linesOf((template[1] as HTMLElement).firstChild as Node)).toBe(1);
    await expect(within(template[1] as HTMLElement).getByText('From 127.0.0.1')).toBeVisible();
    await expect(linesOf(template[0] as HTMLElement)).toBe(2);
    await expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(640);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No records match.')).toBeVisible();
    await expect(canvas.getByText(/^Try a wider filter/)).toBeVisible();
  },
};
