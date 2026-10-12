import type { WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, item, section } from './fixtures';

const c = section('WF-010', 'board', '01a 3.6, WF-010');

/** A Scrum board-managed workflow: the columns are the statuses. */
const scrum: WorkflowDef = {
  id: 'board-scrum',
  statuses: [
    { id: 'to-do', name: 'To Do', category: 'todo' },
    { id: 'in-progress', name: 'In Progress', category: 'in-progress' },
    { id: 'done', name: 'Done', category: 'done' },
  ],
  initial: 'to-do',
  transitions: [],
  board: { columns: ['to-do', 'in-progress', 'done'] },
};

const kanban: WorkflowDef = {
  id: 'board-kanban',
  statuses: [
    { id: 'backlog', name: 'Backlog', category: 'todo' },
    { id: 'selected', name: 'Selected for Development', category: 'todo' },
    { id: 'in-progress', name: 'In Progress', category: 'in-progress' },
    { id: 'done', name: 'Done', category: 'done' },
  ],
  initial: 'backlog',
  transitions: [],
  board: { columns: ['backlog', 'selected', 'in-progress', 'done'] },
};

const board = (w: WorkflowDef) =>
  w.board?.columns.flatMap((from) =>
    (w.board?.columns ?? []).map((to) =>
      c(`any-card-any-column-${from}-to-${to}`, {
        kind: 'board-move',
        title: `A card moves from ${from} to ${to}`,
        workflow: w,
        item: item({ status: from, resolution: from === 'done' ? 'Done' : null }),
        actor: actor('alice'),
        column: to,
        expect: {
          status: to,
          resolution: to === 'done' ? 'Done' : null,
        },
      }),
    ),
  ) ?? [];

export const BOARD_CASES: ConformanceCase[] = [
  c('scrum-default-columns', {
    kind: 'lint',
    title: 'Scrum default columns To Do, In Progress, Done are the statuses',
    workflow: scrum,
    boards: [{ id: 'scrum', columns: scrum.board?.columns ?? [] }],
    expect: { warnings: [] },
    verify:
      'a board-managed workflow has no transitions of its own, so the lint treats every column as reachable with an exit',
  }),
  c('kanban-default-columns', {
    kind: 'lint',
    title:
      'Kanban default columns Backlog, Selected for Development, In Progress, Done are the statuses',
    workflow: kanban,
    boards: [{ id: 'kanban', columns: kanban.board?.columns ?? [] }],
    expect: { warnings: [] },
  }),
  ...board(scrum),
  ...board(kanban).filter((_, i) => i % 3 === 0),
  c('rightmost-sets-resolution-done', {
    kind: 'board-move',
    title: 'The rightmost column sets resolution Done',
    workflow: scrum,
    item: item({ status: 'in-progress' }),
    actor: actor('alice'),
    column: 'done',
    expect: { status: 'done', resolution: 'Done' },
  }),
  c('leaving-rightmost-clears-resolution', {
    kind: 'board-move',
    title: 'Leaving the rightmost column clears the resolution',
    workflow: scrum,
    item: item({ status: 'done', resolution: 'Done', resolvedAt: '2026-10-01T00:00:00.000Z' }),
    actor: actor('alice'),
    column: 'in-progress',
    expect: { status: 'in-progress', resolution: null },
  }),
  c('middle-move-keeps-resolution-empty', {
    kind: 'board-move',
    title: 'A move between middle columns leaves the resolution empty',
    workflow: kanban,
    item: item({ status: 'selected' }),
    actor: actor('alice'),
    column: 'in-progress',
    expect: { status: 'in-progress', resolution: null },
  }),
  c('unknown-column-refused', {
    kind: 'board-move',
    title: 'A column that is not on the board is refused',
    workflow: scrum,
    item: item({ status: 'to-do' }),
    actor: actor('alice'),
    column: 'review',
    expect: { outcome: 'blocked', status: 'to-do' },
  }),
  c('board-move-recorded', {
    kind: 'board-move',
    title: 'A board move is recorded in the history like a transition',
    workflow: scrum,
    item: item({ status: 'to-do', history: [] }),
    actor: actor('alice'),
    column: 'in-progress',
    expect: { status: 'in-progress' },
  }),
  c('no-transition-screens', {
    kind: 'board-move',
    title: 'Board moves have no transition screens, so no fields are asked for',
    workflow: scrum,
    item: item({ status: 'to-do' }),
    actor: actor('alice'),
    column: 'done',
    expect: { status: 'done', resolution: 'Done' },
  }),
  c('adding-a-column-adds-a-status', {
    kind: 'lint',
    title: 'Adding a column creates a status, and the board stays fully mapped',
    workflow: {
      ...scrum,
      statuses: [...scrum.statuses, { id: 'qa', name: 'QA', category: 'in-progress' }],
      board: { columns: ['to-do', 'in-progress', 'qa', 'done'] },
    },
    boards: [{ id: 'scrum', columns: ['to-do', 'in-progress', 'qa', 'done'] }],
    expect: { warnings: [] },
  }),
];
