import { ApiError } from '../api/client';
import type {
  DirectoriesClient,
  Directory,
  DirectoryInput,
  DirectoryKind,
  DirectoryRun,
  KindPreset,
  TestResult,
} from './client';

/** Synthetic directories for stories and tests (M1-082); every name and address is made up. */
export const PRESETS: Record<DirectoryKind, KindPreset> = {
  active_directory: {
    userFilter: '(&(objectCategory=person)(objectClass=user))',
    groupFilter: '(objectClass=group)',
    attributes: {
      id: 'objectGUID',
      username: 'sAMAccountName',
      email: 'mail',
      emailFallback: 'userPrincipalName',
      name: 'displayName',
      givenName: 'givenName',
      surname: 'sn',
      changeMark: 'uSNChanged',
      groupName: 'cn',
      member: 'member',
    },
  },
  openldap: {
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))',
    attributes: {
      id: 'entryUUID',
      username: 'uid',
      email: 'mail',
      emailFallback: '',
      name: 'displayName',
      givenName: 'givenName',
      surname: 'sn',
      changeMark: 'modifyTimestamp',
      groupName: 'cn',
      member: 'member',
    },
  },
  generic: {
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))',
    attributes: {
      id: 'entryUUID',
      username: 'uid',
      email: 'mail',
      emailFallback: '',
      name: 'displayName',
      givenName: 'givenName',
      surname: 'sn',
      changeMark: 'modifyTimestamp',
      groupName: 'cn',
      member: 'member',
    },
  },
};

export const SUCCEEDED: DirectoryRun = {
  id: 41,
  mode: 'incremental',
  trigger: 'schedule',
  status: 'succeeded',
  requestedBy: null,
  confirmRemovals: false,
  createdAt: '2026-10-28T09:00:00.000Z',
  startedAt: '2026-10-28T09:00:01.000Z',
  finishedAt: '2026-10-28T09:00:03.000Z',
  stats: { usersCreated: 2, usersDeactivated: 1, groupsUpdated: 3, warnings: 1, durationMs: 2100 },
  warnings: [{ code: 'no_email', dn: 'CN=Scanner,OU=Devices,DC=corp,DC=example' }],
  error: null,
};

export const FAILED: DirectoryRun = {
  ...SUCCEEDED,
  id: 52,
  mode: 'full',
  status: 'failed',
  stats: { durationMs: 900 },
  warnings: [],
  error:
    'safety_stop: the run would remove 812 of 1200 people; check the filters, or run a full sync confirming removals',
};

export const HEAD_OFFICE: Directory = {
  id: 1,
  name: 'Head office',
  kind: 'active_directory',
  url: 'ldaps://dc1.corp.example:636',
  startTls: false,
  caCertificates: [
    {
      fingerprint:
        '9C:4E:12:A0:77:3B:D5:61:8F:02:CE:44:19:B7:6A:E3:50:2D:98:C1:0F:7A:E6:35:B2:48:91:DD:06:3C:5F:A4',
      subject: 'CN=Corp Root CA',
      notAfter: '2030-01-31T00:00:00.000Z',
    },
  ],
  bindDn: 'CN=Taskmoor,OU=Services,DC=corp,DC=example',
  hasBindPassword: true,
  baseDn: 'DC=corp,DC=example',
  userBaseDn: 'OU=Staff,DC=corp,DC=example',
  userFilter: PRESETS.active_directory.userFilter,
  groupBaseDn: null,
  groupFilter: PRESETS.active_directory.groupFilter,
  attributes: PRESETS.active_directory.attributes,
  attributeOverrides: {},
  mode: 'read_only',
  position: 1,
  enabled: true,
  syncIntervalMinutes: 60,
  fullSyncHours: 24,
  nextSyncAt: '2026-10-28T10:00:00.000Z',
  lastFullSyncAt: '2026-10-28T02:00:00.000Z',
  accounts: 1180,
  groups: 214,
  lastRun: SUCCEEDED,
};

export const LAB: Directory = {
  ...HEAD_OFFICE,
  id: 2,
  name: 'Research lab',
  kind: 'openldap',
  url: 'ldap://ldap.lab.example:389',
  startTls: true,
  caCertificates: [],
  bindDn: 'cn=taskmoor,ou=services,dc=lab,dc=example',
  baseDn: 'dc=lab,dc=example',
  userBaseDn: null,
  userFilter: PRESETS.openldap.userFilter,
  groupFilter: PRESETS.openldap.groupFilter,
  attributes: { ...PRESETS.openldap.attributes, email: 'mailPrimaryAddress' },
  attributeOverrides: { email: 'mailPrimaryAddress' },
  mode: 'read_write',
  position: 2,
  enabled: false,
  syncIntervalMinutes: 30,
  fullSyncHours: 12,
  accounts: 0,
  groups: 0,
  lastRun: FAILED,
};

/** An in-memory backend for the page: lists, adds, edits, orders, syncs and deletes. */
export function fakeDirectoriesClient(
  initial: Directory[] = [HEAD_OFFICE, LAB],
  test: TestResult = {
    ok: true,
    users: { count: 1000, more: true, sample: [] },
    groups: { count: 214, more: false, sample: [] },
  },
): DirectoriesClient {
  let directories = initial.map((d) => ({ ...d }));
  let nextId = 10;
  const find = (id: number) => {
    const found = directories.find((d) => d.id === id);
    if (!found) throw new ApiError(404, { error: 'not_found' });
    return found;
  };
  const fromInput = (input: DirectoryInput, id: number, position: number): Directory => ({
    id,
    name: input.name,
    kind: input.kind,
    url: input.url,
    startTls: input.startTls,
    caCertificates: [],
    bindDn: input.bindDn,
    hasBindPassword: true,
    baseDn: input.baseDn,
    userBaseDn: input.userBaseDn,
    userFilter: input.userFilter,
    groupBaseDn: input.groupBaseDn,
    groupFilter: input.groupFilter,
    attributes: { ...PRESETS[input.kind].attributes, ...input.attributes },
    attributeOverrides: input.attributes,
    mode: input.mode,
    position,
    enabled: input.enabled,
    syncIntervalMinutes: input.syncIntervalMinutes,
    fullSyncHours: input.fullSyncHours,
    nextSyncAt: null,
    lastFullSyncAt: null,
    accounts: 0,
    groups: 0,
    lastRun: null,
  });
  return {
    list: async () => ({ directories: directories.map((d) => ({ ...d })), presets: PRESETS }),
    create: async (input) => {
      if (directories.some((d) => d.name.toLowerCase() === input.name.toLowerCase())) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const created = fromInput(input, nextId++, directories.length + 1);
      directories = [...directories, created];
      return created;
    },
    update: async (id, changes) => {
      const current = find(id);
      const { caCertificates: _c, bindPassword: _p, attributes, ...rest } = changes;
      const next: Directory = {
        ...current,
        ...rest,
        ...(attributes
          ? {
              attributeOverrides: attributes,
              attributes: { ...PRESETS[current.kind].attributes, ...attributes },
            }
          : {}),
      };
      directories = directories.map((d) => (d.id === id ? next : d));
      return next;
    },
    remove: async (id) => {
      find(id);
      directories = directories.filter((d) => d.id !== id);
    },
    order: async (ids) => {
      directories = ids.map((id, i) => ({ ...find(id), position: i + 1 }));
    },
    sync: async (id, mode, confirmRemovals = false) => {
      const directory = find(id);
      if (!directory.enabled) throw new ApiError(409, { error: 'directory_disabled' });
      const run: DirectoryRun = {
        ...SUCCEEDED,
        id: nextId++,
        mode,
        trigger: 'manual',
        status: 'succeeded',
        confirmRemovals,
        stats: { usersUpdated: 1 },
        warnings: [],
      };
      directories = directories.map((d) => (d.id === id ? { ...d, lastRun: run } : d));
      return run;
    },
    runs: async (id) => {
      const directory = find(id);
      return directory.lastRun ? [directory.lastRun] : [];
    },
    test: async () => test,
  };
}
