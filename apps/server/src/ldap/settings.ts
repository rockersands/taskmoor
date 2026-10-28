import type { JsonValue } from '@taskmoor/db';
import { openSecret, type PepperRing } from '@taskmoor/iam';
import { FilterParser } from 'ldapts';

/**
 * How Taskmoor reads a directory (M1-082, IAM-005, ADR-019): the kinds it knows, their
 * attribute and filter defaults, the transport rule, and a directory row turned into the
 * settings the client and the sync use.
 */
export const DIRECTORY_KINDS = ['active_directory', 'openldap', 'generic'] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];
export type DirectoryMode = 'read_only' | 'read_write';

/** Which attribute holds what. Administrators may rename any of them per directory. */
export interface AttributeMap {
  /** The entry's stable identifier: survives renames and moves. */
  id: string;
  username: string;
  email: string;
  /** Read when `email` is empty (Active Directory: the user principal name). */
  emailFallback: string;
  name: string;
  givenName: string;
  surname: string;
  /** What moves when an entry changes: incremental runs ask for entries past the cursor. */
  changeMark: string;
  groupName: string;
  /** DN-valued: people and nested groups. */
  member: string;
}
export const ATTRIBUTE_KEYS = [
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
] as const satisfies readonly (keyof AttributeMap)[];

/** How a kind tells that an entry is disabled. */
export type DisabledRule = 'account_control' | 'ppolicy_lock' | 'none';
/** How a kind's incremental cursor works. */
export type CursorKind = 'usn' | 'timestamp';

export interface KindPreset {
  attributes: AttributeMap;
  userFilter: string;
  groupFilter: string;
  disabled: DisabledRule;
  cursor: CursorKind;
  /** Attributes that come as bytes. */
  binary: string[];
}

export const PRESETS: Record<DirectoryKind, KindPreset> = {
  active_directory: {
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
    userFilter: '(&(objectCategory=person)(objectClass=user))',
    groupFilter: '(objectClass=group)',
    // userAccountControl's ACCOUNTDISABLE bit.
    disabled: 'account_control',
    cursor: 'usn',
    binary: ['objectGUID'],
  },
  openldap: {
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
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))',
    // The password policy overlay's administrative lock (pwdAccountLockedTime 000001010000Z).
    disabled: 'ppolicy_lock',
    cursor: 'timestamp',
    binary: [],
  },
  generic: {
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
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))',
    // Leave disabled people out with the user filter: they are then deactivated as removed.
    disabled: 'none',
    cursor: 'timestamp',
    binary: [],
  },
};

/** An attribute description: a name or an OID, without options. */
export const ATTRIBUTE_NAME = /^([A-Za-z][A-Za-z0-9-]{0,63}|\d+(\.\d+)+)$/;

/** True when ldapts can parse the filter; a filter is one parenthesised expression. */
export function validFilter(filter: string): boolean {
  const trimmed = filter.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return false;
  // One balanced expression: values escape parentheses (\28, \29), so every one counts.
  let depth = 0;
  for (const [i, ch] of [...trimmed].entries()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0 || (depth === 0 && i < [...trimmed].length - 1)) return false;
  }
  if (depth !== 0) return false;
  try {
    FilterParser.parseString(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** The attribute map of a kind with an administrator's overrides. */
export function attributeMap(kind: DirectoryKind, overrides: unknown): AttributeMap {
  const out: AttributeMap = { ...PRESETS[kind].attributes };
  if (typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)) {
    for (const key of ATTRIBUTE_KEYS) {
      const value = (overrides as Record<string, unknown>)[key];
      if (
        typeof value === 'string' &&
        (value === '' ? key === 'emailFallback' : ATTRIBUTE_NAME.test(value))
      ) {
        out[key] = value;
      }
    }
  }
  return out;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Directory URLs are ldap:// or ldaps:// with a host and at most a port. */
export function parseDirectoryUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ldap:' && parsed.protocol !== 'ldaps:') return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Passwords never cross the network in clear: a directory is reached over LDAPS or upgraded
 * with StartTLS. Plain LDAP is accepted on the loopback interface (development and tests) or
 * with TASKMOOR_LDAP_ALLOW_PLAIN=true. Returns why a transport is refused, or null.
 */
export function transportProblem(url: string, startTls: boolean): string | null {
  const parsed = parseDirectoryUrl(url);
  if (!parsed) return 'invalid_url';
  if (parsed.protocol === 'ldaps:') return startTls ? 'start_tls_with_ldaps' : null;
  if (startTls) return null;
  if (LOOPBACK.has(parsed.hostname) || process.env.TASKMOOR_LDAP_ALLOW_PLAIN === 'true') {
    return null;
  }
  return 'plain_ldap';
}

/** A directory row, as the database returns it. */
export interface DirectoryRow {
  id: number;
  workspace_id: number;
  name: string;
  kind: DirectoryKind;
  url: string;
  start_tls: boolean;
  ca_certificates: string[];
  bind_dn: string;
  bind_password_sealed: string;
  base_dn: string;
  user_base_dn: string | null;
  user_filter: string;
  group_base_dn: string | null;
  group_filter: string;
  attribute_map: JsonValue;
  mode: DirectoryMode;
  position: number;
  enabled: boolean;
  sync_interval_minutes: number;
  full_sync_hours: number;
  next_sync_at: Date | null;
  last_full_sync_at: Date | null;
  sync_cursor: JsonValue | null;
  created_at: Date;
  updated_at: Date;
}

export const DIRECTORY_COLUMNS = [
  'id',
  'workspace_id',
  'name',
  'kind',
  'url',
  'start_tls',
  'ca_certificates',
  'bind_dn',
  'bind_password_sealed',
  'base_dn',
  'user_base_dn',
  'user_filter',
  'group_base_dn',
  'group_filter',
  'attribute_map',
  'mode',
  'position',
  'enabled',
  'sync_interval_minutes',
  'full_sync_hours',
  'next_sync_at',
  'last_full_sync_at',
  'sync_cursor',
  'created_at',
  'updated_at',
] as const;

/** What the client and the sync need to reach a directory. */
export interface DirectorySettings {
  id: number;
  name: string;
  kind: DirectoryKind;
  url: string;
  startTls: boolean;
  caCertificates: string[];
  bindDn: string;
  /** The service account's password, opened from its seal; never logged or returned. */
  bindPassword: string;
  baseDn: string;
  userBaseDn: string;
  userFilter: string;
  groupBaseDn: string;
  groupFilter: string;
  attributes: AttributeMap;
  disabled: DisabledRule;
  cursor: CursorKind;
  binary: string[];
  mode: DirectoryMode;
}

/** Thrown when a sealed bind password cannot be opened (the pepper it was sealed with is gone). */
export class SealedSecretError extends Error {
  constructor() {
    super('The bind password cannot be opened: set it again');
  }
}

export function directorySettings(
  row: DirectoryRow,
  peppers: PepperRing | undefined,
  bindPassword?: string,
): DirectorySettings {
  const password = bindPassword ?? openSecret(row.bind_password_sealed, peppers);
  if (password === null) throw new SealedSecretError();
  const preset = PRESETS[row.kind];
  const attributes = attributeMap(row.kind, row.attribute_map);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    startTls: row.start_tls,
    caCertificates: row.ca_certificates,
    bindDn: row.bind_dn,
    bindPassword: password,
    baseDn: row.base_dn,
    userBaseDn: row.user_base_dn ?? row.base_dn,
    userFilter: row.user_filter,
    groupBaseDn: row.group_base_dn ?? row.base_dn,
    groupFilter: row.group_filter,
    attributes,
    disabled: preset.disabled,
    cursor: attributes.changeMark.toLowerCase() === 'usnchanged' ? 'usn' : preset.cursor,
    binary: attributes.id.toLowerCase() === 'objectguid' ? ['objectGUID'] : preset.binary,
    mode: row.mode,
  };
}
