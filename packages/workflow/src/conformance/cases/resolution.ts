import type { ConformanceCase } from '../case';
import { actor, item, NOW, section, W1, withTransition } from './fixtures';

const c = section('WF-008', 'resolution', 'WF-008, CORE-014');

const resolvedItem = () =>
  item({
    status: 'done',
    resolution: 'Done',
    resolvedAt: '2026-10-01T09:00:00.000Z',
    history: [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
      { field: 'status', from: 'review', to: 'done', by: 'alice', transition: 'finish' },
      { field: 'resolution', from: null, to: 'Done', by: 'alice', transition: 'finish' },
    ],
  });

export const RESOLUTION_CASES: ConformanceCase[] = [
  c('finish-with-resolution-stamps-resolved', {
    kind: 'transition',
    title: 'Moving to Done with a resolution sets Resolved',
    workflow: W1,
    item: item({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', fields: { resolution: 'Done' }, now: NOW },
    expect: { outcome: 'ok', status: 'done', resolution: 'Done', resolvedAt: NOW },
  }),
  c('finish-records-resolution-in-history', {
    kind: 'transition',
    title: 'The resolution change is in the history with the status change',
    workflow: W1,
    item: item({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', fields: { resolution: "Won't do" }, now: NOW },
    expect: {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'review', to: 'done', by: 'alice', transition: 'finish' },
        { field: 'resolution', from: null, to: "Won't do", by: 'alice', transition: 'finish' },
      ],
    },
  }),
  c('finish-without-resolution-leaves-unresolved', {
    kind: 'transition',
    title: 'Moving to Done without entering a resolution leaves Resolved empty',
    workflow: W1,
    item: item({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', now: NOW },
    expect: { outcome: 'ok', status: 'done', resolution: null, resolvedAt: null },
    verify:
      'whether a Done-category status requires a resolution is a scheme decision (a Field required validator does it); the transition itself does not force one',
  }),
  c('reopen-clears-resolution-and-resolved', {
    kind: 'transition',
    title: 'Reopening clears both the resolution and Resolved',
    workflow: W1,
    item: resolvedItem(),
    actor: actor('alice'),
    request: { transition: 'reopen', now: NOW },
    expect: {
      outcome: 'ok',
      status: 'open',
      resolution: null,
      resolvedAt: null,
      added: [
        { field: 'status', from: 'done', to: 'open', by: 'alice', transition: 'reopen' },
        { field: 'resolution', from: 'Done', to: null, by: 'alice', transition: 'reopen' },
      ],
    },
  }),
  c('resolution-via-post-function', {
    kind: 'transition',
    title: 'A post function can set the resolution, which stamps Resolved',
    workflow: withTransition(W1, 'cancel', {
      postFunctions: [{ type: 'update-system-field', field: 'resolution', value: "Won't do" }],
    }),
    item: item({ status: 'in-progress' }),
    actor: actor('alice'),
    request: { transition: 'cancel', now: NOW },
    expect: { outcome: 'ok', status: 'cancelled', resolution: "Won't do", resolvedAt: NOW },
  }),
  c('resolution-changed-keeps-new-stamp', {
    kind: 'transition',
    title: 'Changing a resolution restamps Resolved',
    workflow: withTransition(W1, 'cancel', { layout: ['resolution'] }),
    item: resolvedItem(),
    actor: actor('alice'),
    request: { transition: 'cancel', fields: { resolution: 'Duplicate' }, now: NOW },
    expect: { outcome: 'ok', resolution: 'Duplicate', resolvedAt: NOW },
  }),
  c('resolution-not-on-layout-not-changed', {
    kind: 'transition',
    title: 'A transition that does not expose the resolution keeps it',
    workflow: W1,
    item: resolvedItem(),
    actor: actor('alice'),
    request: { transition: 'cancel', fields: { resolution: 'Duplicate' }, now: NOW },
    expect: { outcome: 'ok', resolution: 'Done', resolvedAt: '2026-10-01T09:00:00.000Z' },
  }),
  c('clearing-through-layout', {
    kind: 'transition',
    title: 'Clearing the resolution on a layout clears Resolved too',
    workflow: withTransition(W1, 'reopen', { layout: ['resolution'], postFunctions: [] }),
    item: resolvedItem(),
    actor: actor('alice'),
    request: { transition: 'reopen', fields: { resolution: null }, now: NOW },
    expect: { outcome: 'ok', resolution: null, resolvedAt: null },
  }),
  c('status-categories-drive-colours', {
    kind: 'lint',
    title: 'Status categories are part of the definition boards and reports read',
    workflow: W1,
    boards: [{ id: 'main', columns: ['open', 'in-progress', 'review', 'done', 'cancelled'] }],
    expect: { warnings: [] },
  }),
];
