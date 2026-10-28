import { api } from '../api/client';

/** LDAP and Active Directory directories (M1-082, IAM-005): `/api/v1/directories`. */
export type DirectoryKind = 'active_directory' | 'openldap' | 'generic';
export type DirectoryMode = 'read_only' | 'read_write';

export const DIRECTORY_KINDS: readonly DirectoryKind[] = [
  'active_directory',
  'openldap',
  'generic',
];

/** Which attribute holds what; a directory may rename any of them. */
export interface AttributeMap {
  id: string;
  username: string;
  email: string;
  emailFallback: string;
  name: string;
  givenName: string;
  surname: string;
  changeMark: string;
  groupName: string;
  member: string;
}

export const ATTRIBUTE_KEYS: readonly (keyof AttributeMap)[] = [
  'id',
  'username',
  'email',
  'emailFallback',
  'name',
  'givenName',
  'surname',
  'changeMark',
  'groupName',
  'member',
];

/** A CA certificate the directory's TLS certificate must chain to. */
export interface CertificateSummary {
  fingerprint: string;
  subject: string;
  notAfter: string;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RunWarning {
  code: string;
  dn?: string;
  detail?: string;
}

/** A sync of one directory, waiting, running or finished. */
export interface DirectoryRun {
  id: number;
  mode: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  requestedBy: number | null;
  confirmRemovals: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Counts by name: usersCreated, usersDeactivated, groupsCreated, durationMs ... */
  stats: Record<string, number>;
  warnings: RunWarning[];
  error: string | null;
}

/** A directory as administrators see it; the service account's password is never returned. */
export interface Directory {
  id: number;
  name: string;
  kind: DirectoryKind;
  url: string;
  startTls: boolean;
  caCertificates: CertificateSummary[];
  bindDn: string;
  hasBindPassword: boolean;
  baseDn: string;
  userBaseDn: string | null;
  userFilter: string;
  groupBaseDn: string | null;
  groupFilter: string;
  /** The attribute names in use: the kind's defaults with the overrides. */
  attributes: AttributeMap;
  attributeOverrides: Partial<AttributeMap>;
  mode: DirectoryMode;
  /** Precedence: where two directories hold an address, the lower position manages it. */
  position: number;
  enabled: boolean;
  syncIntervalMinutes: number;
  fullSyncHours: number;
  nextSyncAt: string | null;
  lastFullSyncAt: string | null;
  /** Accounts and groups the directory manages now. */
  accounts: number;
  groups: number;
  lastRun: DirectoryRun | null;
}

/** A kind's defaults, which a new directory starts from. */
export interface KindPreset {
  userFilter: string;
  groupFilter: string;
  attributes: AttributeMap;
}

export interface DirectoryList {
  directories: Directory[];
  presets: Record<DirectoryKind, KindPreset>;
}

/** What creating or editing a directory sends; an edit names only what changed. */
export interface DirectoryInput {
  name: string;
  kind: DirectoryKind;
  url: string;
  startTls: boolean;
  /** PEM text; left out, the saved certificates stay. */
  caCertificates?: string[];
  bindDn: string;
  /** Write-only: left out, the saved password stays. */
  bindPassword?: string;
  baseDn: string;
  userBaseDn: string | null;
  userFilter: string;
  groupBaseDn: string | null;
  groupFilter: string;
  attributes: Partial<AttributeMap>;
  mode: DirectoryMode;
  enabled: boolean;
  syncIntervalMinutes: number;
  fullSyncHours: number;
}

export interface SampledPerson {
  dn: string;
  username?: string;
  email?: string | null;
  name?: string;
  disabled?: boolean;
  problem?: string;
}

export interface SampledGroup {
  dn: string;
  name?: string;
  members?: number;
  problem?: string;
}

/** What trying settings found: the first thousand people and groups at most, with a sample. */
export type TestResult =
  | {
      ok: true;
      users: { count: number; more: boolean; sample: SampledPerson[] };
      groups: { count: number; more: boolean; sample: SampledGroup[] };
    }
  | {
      ok: false;
      error:
        | 'unreachable'
        | 'tls_failed'
        | 'bind_refused'
        | 'password_unreadable'
        | 'search_failed';
      detail?: string;
    };

export interface DirectoriesClient {
  list: () => Promise<DirectoryList>;
  create: (input: DirectoryInput) => Promise<Directory>;
  update: (id: number, changes: Partial<DirectoryInput>) => Promise<Directory>;
  remove: (id: number) => Promise<void>;
  /** Every directory's id, first in precedence first. */
  order: (ids: number[]) => Promise<void>;
  /** Asks for a run; `confirmRemovals` lets a full one remove more than the safety limit. */
  sync: (
    id: number,
    mode: 'full' | 'incremental',
    confirmRemovals?: boolean,
  ) => Promise<DirectoryRun>;
  runs: (id: number) => Promise<DirectoryRun[]>;
  /** Tries settings without saving them; with `id`, what is left out comes from that directory. */
  test: (input: Partial<DirectoryInput> & { id?: number }) => Promise<TestResult>;
}

export const directoriesClient: DirectoriesClient = {
  list: () => api<DirectoryList>('/directories'),
  create: async (input) =>
    (await api<{ directory: Directory }>('/directories', { method: 'POST', body: input }))
      .directory,
  update: async (id, changes) =>
    (await api<{ directory: Directory }>(`/directories/${id}`, { method: 'PATCH', body: changes }))
      .directory,
  remove: async (id) => {
    await api<null>(`/directories/${id}`, { method: 'DELETE' });
  },
  order: async (ids) => {
    await api<null>('/directories/order', { method: 'PUT', body: { ids } });
  },
  sync: async (id, mode, confirmRemovals = false) =>
    (
      await api<{ run: DirectoryRun }>(`/directories/${id}/sync`, {
        method: 'POST',
        body: confirmRemovals ? { mode, confirmRemovals } : { mode },
      })
    ).run,
  runs: async (id) => (await api<{ runs: DirectoryRun[] }>(`/directories/${id}/runs`)).runs,
  test: (input) => api<TestResult>('/directories/test', { method: 'POST', body: input }),
};

/** True while a run waits or runs: the page looks again shortly. */
export function busy(run: DirectoryRun | null): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}
