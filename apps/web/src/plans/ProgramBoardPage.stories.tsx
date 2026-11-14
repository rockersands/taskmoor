import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import { MoveDialog, ProgramBoardPage } from './ProgramBoardPage';
import { BoardDialog, ProgramBoardsPage } from './ProgramBoardsPage';
import { boardFixture, fakeBoardClient } from './programBoardFixtures';

/**
 * A plan's program board (PLN-008; ADR-122 stage 5): teams by period, cards that move by drag or by
 * their Move button, and their dependencies in words.
 */
const meta = {
  title: 'Plans/ProgramBoardPage',
  component: ProgramBoardPage,
  args: {
    planId: 12,
    boardId: 5,
    filters: {},
    client: fakeBoardClient(),
    now: () => new Date('2026-11-04T09:00:00Z'),
  },
} satisfies Meta<typeof ProgramBoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table', { name: 'Spring PI' });
    await expect(within(table).getByRole('rowheader', { name: 'Web' })).toBeVisible();
    await expect(within(table).getByText('Blocked by 2 tickets, 1 late')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Dependencies' })).toBeVisible();
  },
};

/** One team at a time on a phone, with no sideways scroll. */
export const OnAPhone: Story = {
  args: { client: fakeBoardClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('combobox', { name: 'Team' })).toBeVisible();
    await expect(canvas.queryByRole('table')).toBeNull();
    const doc = canvasElement.ownerDocument.documentElement;
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  },
};

/** A finger reaches every card's Move button and the more link (ADR-033). */
export const OnATouchScreen: Story = {
  args: { client: fakeBoardClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('combobox', { name: 'Team' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.program-card-move',
        '.program-cell-more',
        '.program-board-phone select',
      ]),
    ).toEqual([]);
  },
};

/** A refused move says why, in words. */
export const Refused: Story = {
  args: { client: fakeBoardClient({ refuse: 'version_conflict' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move OPS-7…' }));
    const dialog = await page.findByRole('dialog', { name: 'Move OPS-7' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Team' }), 'Web');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('changed while you moved it');
  },
};

/** An archived board shows its cards and moves none. */
export const Archived: Story = {
  args: {
    client: fakeBoardClient({
      board: boardFixture({ board: { ...boardFixture().board, archived: true } }),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/This program board is archived/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Move / })).toBeNull();
  },
};

/** The plan's boards, active first, for an editor. */
export const Boards: StoryObj<typeof ProgramBoardsPage> = {
  render: () => (
    <ProgramBoardsPage
      planId={12}
      client={fakeBoardClient()}
      now={() => new Date('2026-11-04T09:00:00Z')}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Spring PI' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'New program board' })).toBeVisible();
  },
};

/** Without a Team field: nothing to make, and who to ask. */
export const BoardsWithoutATeamField: StoryObj<typeof ProgramBoardsPage> = {
  render: () => (
    <ProgramBoardsPage planId={12} client={fakeBoardClient({ list: { teamFields: [] } })} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/A program board places cards by a Team field/),
    ).toBeVisible();
  },
};

/** A new board's name, Team field, first day and periods. */
export const NewBoard: StoryObj<typeof BoardDialog> = {
  render: () => (
    <BoardDialog
      board={null}
      teamFields={[{ id: 40, name: 'Team' }]}
      today="2026-11-04"
      onSave={fn(async () => ({ ok: true as const, board: boardFixture().board }))}
      onSaved={fn()}
      onClose={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole('dialog', { name: 'New program board' })).toBeVisible();
  },
};

/** Moving a card by its team and period: the keyboard's and a phone's way. */
export const Move: StoryObj<typeof MoveDialog> = {
  render: () => (
    <MoveDialog
      card={{ key: 'SHOP-2', summary: 'Pay by card' }}
      from={{ team: 3, column: 1 }}
      rows={[
        { team: 3, name: 'Web' },
        { team: 4, name: 'Ops' },
        { team: null, name: 'Other or no team' },
      ]}
      columns={['Not scheduled', 'Nov 2 – Nov 8', 'Nov 9 – Nov 15']}
      teamMovable
      onMove={fn()}
      onClose={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole('dialog', { name: 'Move SHOP-2' });
    // Nothing to send until something changes.
    await expect(within(dialog).getByRole('button', { name: 'Move' })).toBeDisabled();
  },
};
