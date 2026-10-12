import type { WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, section, ticket } from './fixtures';

const c = section('WF-010', 'board', '01a 3.6, WF-010');

/** A Scrum board-managed workflow: the columns are the statuses. */
const scrum: WorkflowDef = {
  id: 'board-scrum',
  statuses: [
    { id: 'new', name: 'New', stage: 'new' },
    { id: 'active', name: 'Active', stage: 'active' },
    { id: 'closed', name: 'Closed', stage: 'closed' },
  ],
  initial: 'new',
  transitions: [],
  board: { columns: ['new', 'active', 'closed'] },
};

const kanban: WorkflowDef = {
  id: 'board-kanban',
  statuses: [
    { id: 'backlog', name: 'Backlog', stage: 'new' },
    { id: 'selected', name: 'Selected for Development', stage: 'new' },
    { id: 'active', name: 'Active', stage: 'active' },
    { id: 'closed', name: 'Closed', stage: 'closed' },
  ],
  initial: 'backlog',
  transitions: [],
  board: { columns: ['backlog', 'selected', 'active', 'closed'] },
};

const board = (w: WorkflowDef) =>
  w.board?.columns.flatMap((from) =>
    (w.board?.columns ?? []).map((to) =>
      c(`any-card-any-column-${from}-to-${to}`, {
        kind: 'board-move',
        title: `A card moves from ${from} to ${to}`,
        workflow: w,
        ticket: ticket({ status: from, closeReason: from === 'closed' ? 'Completed' : null }),
        actor: actor('alice'),
        column: to,
        expect: {
          status: to,
          closeReason: to === 'closed' ? 'Completed' : null,
        },
      }),
    ),
  ) ?? [];

export const BOARD_CASES: ConformanceCase[] = [
  c('scrum-default-columns', {
    kind: 'lint',
    title: 'Scrum default columns New, Active, Closed are the statuses',
    workflow: scrum,
    boards: [{ id: 'scrum', columns: scrum.board?.columns ?? [] }],
    expect: { warnings: [] },
    verify:
      'a board-managed workflow has no transitions of its own, so the lint treats every column as reachable with an exit',
  }),
  c('kanban-default-columns', {
    kind: 'lint',
    title:
      'Kanban default columns Backlog, Selected for Development, Active, Closed are the statuses',
    workflow: kanban,
    boards: [{ id: 'kanban', columns: kanban.board?.columns ?? [] }],
    expect: { warnings: [] },
  }),
  ...board(scrum),
  ...board(kanban).filter((_, i) => i % 3 === 0),
  c('rightmost-sets-close-reason-completed', {
    kind: 'board-move',
    title: 'The rightmost column sets close reason Completed',
    workflow: scrum,
    ticket: ticket({ status: 'active' }),
    actor: actor('alice'),
    column: 'closed',
    expect: { status: 'closed', closeReason: 'Completed' },
  }),
  c('leaving-rightmost-clears-close-reason', {
    kind: 'board-move',
    title: 'Leaving the rightmost column clears the close reason',
    workflow: scrum,
    ticket: ticket({
      status: 'closed',
      closeReason: 'Completed',
      closedAt: '2026-10-01T00:00:00.000Z',
    }),
    actor: actor('alice'),
    column: 'active',
    expect: { status: 'active', closeReason: null },
  }),
  c('middle-move-keeps-close-reason-empty', {
    kind: 'board-move',
    title: 'A move between middle columns leaves the close reason empty',
    workflow: kanban,
    ticket: ticket({ status: 'selected' }),
    actor: actor('alice'),
    column: 'active',
    expect: { status: 'active', closeReason: null },
  }),
  c('unknown-column-refused', {
    kind: 'board-move',
    title: 'A column that is not on the board is refused',
    workflow: scrum,
    ticket: ticket({ status: 'new' }),
    actor: actor('alice'),
    column: 'review',
    expect: { outcome: 'blocked', status: 'new' },
  }),
  c('board-move-recorded', {
    kind: 'board-move',
    title: 'A board move is recorded in the history like a transition',
    workflow: scrum,
    ticket: ticket({ status: 'new', history: [] }),
    actor: actor('alice'),
    column: 'active',
    expect: { status: 'active' },
  }),
  c('no-transition-layouts', {
    kind: 'board-move',
    title: 'Board moves have no transition layouts, so no fields are asked for',
    workflow: scrum,
    ticket: ticket({ status: 'new' }),
    actor: actor('alice'),
    column: 'closed',
    expect: { status: 'closed', closeReason: 'Completed' },
  }),
  c('adding-a-column-adds-a-status', {
    kind: 'lint',
    title: 'Adding a column creates a status, and the board stays fully mapped',
    workflow: {
      ...scrum,
      statuses: [...scrum.statuses, { id: 'qa', name: 'QA', stage: 'active' }],
      board: { columns: ['new', 'active', 'qa', 'closed'] },
    },
    boards: [{ id: 'scrum', columns: ['new', 'active', 'qa', 'closed'] }],
    expect: { warnings: [] },
  }),
];
