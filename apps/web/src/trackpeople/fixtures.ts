import { ApiError } from '../api/client';
import type {
  Invitation,
  InvitationClient,
  InvitationLink,
  InviteResult,
  ManagedTrack,
  Named,
  RoleHolders,
  TrackPeopleClient,
  TrackRole,
} from './client';

export const SHOP: ManagedTrack = { id: 3, key: 'SHOP', name: 'Shop', mode: 'shared' };
/** A track with its own configuration, whose Manage page leads to its own sets (T-163a). */
export const OPS: ManagedTrack = { id: 4, key: 'OPS', name: 'Operations', mode: 'local' };

export const ROLES: TrackRole[] = [
  { id: 7, name: 'Administrators', description: '', runsTrack: true, givable: true },
  { id: 8, name: 'Members', description: '', runsTrack: false, givable: true },
  { id: 9, name: 'Viewers', description: '', runsTrack: false, givable: true },
];

const WAITING: Invitation = {
  id: 21,
  email: 'nia@example.com',
  role: { id: 8, name: 'Members' },
  invitedBy: 'Kalo Reyes',
  delivery: 'email',
  sendFailed: false,
  lastSentAt: '2026-11-01T10:00:00Z',
  expiresAt: '2026-11-08T10:00:00Z',
  state: 'open',
  external: false,
};

export interface FakeTrackPeopleOptions {
  canInvite?: boolean;
  invitingGiven?: boolean;
  emailAvailable?: boolean;
  /** The manager lost the right to give the role that runs the track. */
  appointLocked?: boolean;
  invitations?: Invitation[];
  /** The server refuses the permission to create tracks, as it does for whoever cannot give it. */
  refuseCreateTracks?: boolean;
  /** Whether the track's followers hear of checklist changes to begin with (NTF-015). */
  checklistNotices?: boolean;
  /** Saving checklist notices fails: the track was archived meanwhile. */
  refuseNotices?: boolean;
}

export interface FakeTrackPeopleClient extends TrackPeopleClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for stories and tests: it answers as the API would. */
export function fakeTrackPeopleClient(options: FakeTrackPeopleOptions = {}): FakeTrackPeopleClient {
  const calls: FakeTrackPeopleClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const roles = ROLES.map((r) =>
    r.runsTrack && options.appointLocked ? { ...r, givable: false } : r,
  );
  let holders: RoleHolders[] = [
    { roleId: 7, roleName: 'Administrators', users: [{ id: 1, name: 'Kalo Reyes' }], groups: [] },
    {
      roleId: 8,
      roleName: 'Members',
      users: [{ id: 2, name: 'Bo Lind' }],
      groups: [{ id: 5, name: 'Support' }],
    },
  ];
  let invitations = options.invitations ?? [WAITING];
  const people: Named[] = [
    { id: 2, name: 'Bo Lind' },
    { id: 4, name: 'Ana Duarte' },
  ];
  let next = 100;
  let notices = options.checklistNotices ?? false;
  return {
    calls,
    managedTracks: async () => [SHOP, OPS],
    track: async (id) => ({ ...(id === OPS.id ? OPS : SHOP), checklistNotices: notices }),
    setChecklistNotices: async (trackId, on) => {
      log('setChecklistNotices', trackId, on);
      if (options.refuseNotices) throw new ApiError(409, { error: 'track_archived' });
      notices = on;
      return notices;
    },
    roles: async () => roles,
    roleHolders: async () => structuredClone(holders),
    setRole: async (trackId, roleId, kind, actorId, on, roleOptions) => {
      log('setRole', trackId, roleId, kind, actorId, on, ...(roleOptions ? [roleOptions] : []));
      const role = roles.find((r) => r.id === roleId);
      if (role && !role.givable) {
        throw new ApiError(403, { error: 'forbidden', permission: 'appoint_track_admins' });
      }
      if (roleOptions?.createTracks && options.refuseCreateTracks) {
        throw new ApiError(403, { error: 'forbidden', permission: 'create_local_tracks' });
      }
      const name = people.find((p) => p.id === actorId)?.name ?? 'Someone';
      const entry = holders.find((h) => h.roleId === roleId);
      if (!entry) {
        if (on) {
          holders = [
            ...holders,
            { roleId, roleName: role?.name ?? '', users: [{ id: actorId, name }], groups: [] },
          ];
        }
        return;
      }
      if (!on && role?.runsTrack && entry.users.length + entry.groups.length === 1) {
        throw new ApiError(409, { error: 'last_track_admin' });
      }
      const list = kind === 'users' ? entry.users : entry.groups;
      if (on) list.push({ id: actorId, name });
      else
        list.splice(
          list.findIndex((a) => a.id === actorId),
          1,
        );
    },
    findPeople: async (_key, query) =>
      people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    invitations: async () => ({
      invitations: structuredClone(invitations),
      canInvite: options.canInvite ?? true,
      invitingGiven: options.invitingGiven ?? true,
      emailAvailable: options.emailAvailable ?? true,
    }),
    invite: async (trackId, body) => {
      log('invite', trackId, body);
      if (body.createTracks && options.refuseCreateTracks) {
        throw new ApiError(403, { error: 'forbidden', permission: 'create_local_tracks' });
      }
      const results: InviteResult[] = body.addresses.map((raw) => {
        if (!raw.includes('@')) return { email: raw, status: 'invalid' };
        const email = raw.toLowerCase();
        if (invitations.some((i) => i.email === email)) {
          return { email, status: 'already_invited' };
        }
        const id = ++next;
        const role = roles.find((r) => r.id === body.roleId) as TrackRole;
        invitations = [
          ...invitations,
          {
            ...WAITING,
            id,
            email,
            role: { id: role.id, name: role.name },
            delivery: body.delivery,
            external: email.endsWith('@personal.example'),
          },
        ];
        return {
          email,
          status: 'invited',
          external: email.endsWith('@personal.example'),
          ...(body.delivery === 'link'
            ? { link: `https://taskmoor.example.com/#/invite?token=link-${id}` }
            : {}),
        };
      });
      for (const userId of body.userIds) {
        const name = people.find((p) => p.id === userId)?.name ?? '';
        results.push({ userId, name, status: 'added' });
      }
      return results;
    },
    resend: async (trackId, id, delivery) => {
      log('resend', trackId, id, delivery);
      return delivery === 'link'
        ? { link: `https://taskmoor.example.com/#/invite?token=again-${id}` }
        : {};
    },
    revoke: async (trackId, id) => {
      log('revoke', trackId, id);
      invitations = invitations.filter((i) => i.id !== id);
    },
  };
}

export const LINK: InvitationLink = {
  email: 'nia@example.com',
  track: { key: 'SHOP', name: 'Shop' },
  roleName: 'Members',
  invitedBy: 'Kalo Reyes',
  expiresAt: '2026-11-08T10:00:00Z',
  secondFactorRequired: false,
};

export interface FakeInvitationClient extends InvitationClient {
  calls: { action: string; args: unknown[] }[];
}

export function fakeInvitationClient(link: Partial<InvitationLink> = {}): FakeInvitationClient {
  const calls: FakeInvitationClient['calls'] = [];
  return {
    calls,
    inspect: async () => ({ ...LINK, ...link }),
    redeem: async (token, name, password) => {
      calls.push({ action: 'redeem', args: [token, name, password.length] });
    },
    accept: async (token) => {
      calls.push({ action: 'accept', args: [token] });
      return { track: { key: 'SHOP' } };
    },
  };
}
