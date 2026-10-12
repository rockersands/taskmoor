import type { StatusPermissions, WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, item, NOW, section, W1 } from './fixtures';

const c = section('WF-007', 'status-permissions', 'WF-007');

const PERMISSIONS: (keyof StatusPermissions)[] = [
  'edit',
  'comment',
  'attach',
  'assign',
  'transition',
];

/** In Review only role approvers (or group release-managers) may do anything; Open is unrestricted. */
const restricted: WorkflowDef = {
  ...W1,
  statusPermissions: {
    review: Object.fromEntries(
      PERMISSIONS.map((p) => [p, [{ role: 'approvers' }, { group: 'release-managers' }]]),
    ) as StatusPermissions,
  },
};

export const STATUS_PERMISSION_CASES: ConformanceCase[] = [
  ...PERMISSIONS.flatMap((permission) => [
    c(`${permission}-allowed-by-role`, {
      kind: 'permission',
      title: `In Review role approvers may ${permission}`,
      workflow: restricted,
      item: item({ status: 'review' }),
      actor: actor('alice', { roles: ['approvers'] }),
      permission,
      expect: { allowed: true },
    }),
    c(`${permission}-allowed-by-group`, {
      kind: 'permission',
      title: `In Review group release-managers may ${permission}`,
      workflow: restricted,
      item: item({ status: 'review' }),
      actor: actor('alice', { groups: ['release-managers'] }),
      permission,
      expect: { allowed: true },
    }),
    c(`${permission}-denied-with-reason`, {
      kind: 'permission',
      title: `In Review others may not ${permission}, and the reason says why`,
      workflow: restricted,
      item: item({ status: 'review' }),
      actor: actor('alice', { roles: ['developers'] }),
      permission,
      expect: {
        allowed: false,
        reason: `in status review only role approvers, group release-managers may ${permission}`,
      },
    }),
    c(`${permission}-unrestricted-status`, {
      kind: 'permission',
      title: `In Open anyone may ${permission}`,
      workflow: restricted,
      item: item({ status: 'open' }),
      actor: actor('alice'),
      permission,
      expect: { allowed: true },
    }),
  ]),
  c('transition-hidden-from-non-holder', {
    kind: 'available',
    title: 'Transitions out of a restricted status are not listed for others',
    workflow: restricted,
    item: item({ status: 'review' }),
    actor: actor('alice', { roles: ['developers'] }),
    expect: { transitions: [] },
  }),
  c('transition-listed-for-holder', {
    kind: 'available',
    title: 'Transitions out of a restricted status are listed for the role',
    workflow: restricted,
    item: item({ status: 'review' }),
    actor: actor('alice', { roles: ['approvers'] }),
    expect: { transitions: ['back', 'finish', 'cancel'] },
  }),
  c('transition-blocked-rest-403', {
    kind: 'transition',
    title: 'REST is refused the transition with the permission reason',
    workflow: restricted,
    item: item({ status: 'review' }),
    actor: actor('alice', { roles: ['developers'] }),
    request: { transition: 'finish', channel: 'rest', now: NOW },
    expect: { outcome: 'blocked', by: 'permission', name: 'transition' },
  }),
  c('transition-allowed-for-holder', {
    kind: 'transition',
    title: 'The role holder transitions out of the restricted status',
    workflow: restricted,
    item: item({ status: 'review' }),
    actor: actor('alice', { roles: ['approvers'] }),
    request: { transition: 'finish', now: NOW },
    expect: { outcome: 'ok', status: 'done' },
  }),
  c('restriction-only-in-that-status', {
    kind: 'transition',
    title: 'The restriction on Review does not touch Open',
    workflow: restricted,
    item: item({ status: 'open' }),
    actor: actor('alice', { roles: ['developers'] }),
    request: { transition: 'start', now: NOW },
    expect: { outcome: 'ok', status: 'in-progress' },
  }),
  c('partial-restriction-edit-only', {
    kind: 'permission',
    title: 'A status may restrict edit alone and leave comments open',
    workflow: { ...W1, statusPermissions: { done: { edit: [{ role: 'admins' }] } } },
    item: item({ status: 'done' }),
    actor: actor('alice'),
    permission: 'comment',
    expect: { allowed: true },
  }),
  c('partial-restriction-edit-denied', {
    kind: 'permission',
    title: 'The same status denies edit to non-admins',
    workflow: { ...W1, statusPermissions: { done: { edit: [{ role: 'admins' }] } } },
    item: item({ status: 'done' }),
    actor: actor('alice'),
    permission: 'edit',
    expect: { allowed: false, reason: 'in status done only role admins may edit' },
  }),
];
