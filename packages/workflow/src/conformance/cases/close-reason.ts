import type { ConformanceCase } from '../case';
import { actor, NOW, section, ticket, W1, withTransition } from './fixtures';

const c = section('WF-008', 'close-reason', 'WF-008, CORE-014');

const closedTicket = () =>
  ticket({
    status: 'done',
    closeReason: 'Done',
    closedAt: '2026-10-01T09:00:00.000Z',
    history: [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
      { field: 'status', from: 'review', to: 'done', by: 'alice', transition: 'finish' },
      { field: 'close-reason', from: null, to: 'Done', by: 'alice', transition: 'finish' },
    ],
  });

export const CLOSE_REASON_CASES: ConformanceCase[] = [
  c('finish-with-close-reason-stamps-closed', {
    kind: 'transition',
    title: 'Moving to Done with a close reason sets the closed stamp',
    workflow: W1,
    ticket: ticket({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', fields: { 'close-reason': 'Done' }, now: NOW },
    expect: { outcome: 'ok', status: 'done', closeReason: 'Done', closedAt: NOW },
  }),
  c('finish-records-close-reason-in-history', {
    kind: 'transition',
    title: 'The close reason change is in the history with the status change',
    workflow: W1,
    ticket: ticket({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', fields: { 'close-reason': "Won't do" }, now: NOW },
    expect: {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'review', to: 'done', by: 'alice', transition: 'finish' },
        { field: 'close-reason', from: null, to: "Won't do", by: 'alice', transition: 'finish' },
      ],
    },
  }),
  c('finish-without-close-reason-leaves-no-stamp', {
    kind: 'transition',
    title: 'Moving to Done without entering a close reason leaves the closed stamp empty',
    workflow: W1,
    ticket: ticket({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'finish', now: NOW },
    expect: { outcome: 'ok', status: 'done', closeReason: null, closedAt: null },
    verify:
      'whether a status in the closed stage requires a close reason is a configuration decision (a Field required check does it); the transition itself does not force one',
  }),
  c('reopen-clears-close-reason-and-stamp', {
    kind: 'transition',
    title: 'Reopening clears both the close reason and the closed stamp',
    workflow: W1,
    ticket: closedTicket(),
    actor: actor('alice'),
    request: { transition: 'reopen', now: NOW },
    expect: {
      outcome: 'ok',
      status: 'open',
      closeReason: null,
      closedAt: null,
      added: [
        { field: 'status', from: 'done', to: 'open', by: 'alice', transition: 'reopen' },
        { field: 'close-reason', from: 'Done', to: null, by: 'alice', transition: 'reopen' },
      ],
    },
  }),
  c('close-reason-via-effect', {
    kind: 'transition',
    title: 'An effect can set the close reason, which sets the closed stamp',
    workflow: withTransition(W1, 'cancel', {
      effects: [{ type: 'update-system-field', field: 'close-reason', value: "Won't do" }],
    }),
    ticket: ticket({ status: 'in-progress' }),
    actor: actor('alice'),
    request: { transition: 'cancel', now: NOW },
    expect: { outcome: 'ok', status: 'cancelled', closeReason: "Won't do", closedAt: NOW },
  }),
  c('close-reason-changed-keeps-new-stamp', {
    kind: 'transition',
    title: 'Changing a close reason renews the closed stamp',
    workflow: withTransition(W1, 'cancel', { layout: ['close-reason'] }),
    ticket: closedTicket(),
    actor: actor('alice'),
    request: { transition: 'cancel', fields: { 'close-reason': 'Duplicate' }, now: NOW },
    expect: { outcome: 'ok', closeReason: 'Duplicate', closedAt: NOW },
  }),
  c('close-reason-not-on-layout-not-changed', {
    kind: 'transition',
    title: 'A transition that does not expose the close reason keeps it',
    workflow: W1,
    ticket: closedTicket(),
    actor: actor('alice'),
    request: { transition: 'cancel', fields: { 'close-reason': 'Duplicate' }, now: NOW },
    expect: { outcome: 'ok', closeReason: 'Done', closedAt: '2026-10-01T09:00:00.000Z' },
  }),
  c('clearing-through-layout', {
    kind: 'transition',
    title: 'Clearing the close reason on a layout clears the closed stamp too',
    workflow: withTransition(W1, 'reopen', { layout: ['close-reason'], effects: [] }),
    ticket: closedTicket(),
    actor: actor('alice'),
    request: { transition: 'reopen', fields: { 'close-reason': null }, now: NOW },
    expect: { outcome: 'ok', closeReason: null, closedAt: null },
  }),
  c('stages-drive-colours', {
    kind: 'lint',
    title: 'Stages are part of the definition boards and reports read',
    workflow: W1,
    boards: [{ id: 'main', columns: ['open', 'in-progress', 'review', 'done', 'cancelled'] }],
    expect: { warnings: [] },
  }),
];
