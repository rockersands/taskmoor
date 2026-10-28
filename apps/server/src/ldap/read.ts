import { guidText, type LdapEntry } from './client';
import type { DirectorySettings } from './settings';

/**
 * Directory entries as the sync sees them (M1-082, IAM-005): a person or a group with its
 * stable identifier, DN, the values Taskmoor keeps, and its change mark.
 */
export interface DirectoryUser {
  externalId: string;
  dn: string;
  /** The DN normalised for comparison (`normalizeDn`). */
  key: string;
  username: string;
  /** Lower case; null when the entry has no usable address. */
  email: string | null;
  name: string;
  disabled: boolean;
  /** uSNChanged or modifyTimestamp, as the directory wrote it. */
  mark: string | null;
}

export interface DirectoryGroup {
  externalId: string;
  dn: string;
  key: string;
  name: string;
  /** Member DNs, normalised. */
  members: string[];
  mark: string | null;
}

export interface EntryProblem {
  problem: 'no_identifier';
  dn: string;
}

/**
 * DNs compare without case and without spaces around separators, so a member value written
 * as `CN=Ann Lee, OU=People` finds the entry `cn=Ann Lee,ou=People`.
 */
export function normalizeDn(dn: string): string {
  return dn
    .trim()
    .replace(/\s*([,=+])\s*/g, '$1')
    .toLowerCase();
}

const NAME_MAX = 200;
const GROUP_NAME_MAX = 255;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A usable account address: lower case, at most 320 characters, never the service-account domain. */
export function accountEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase();
  if (!email || email.length > 320 || !EMAIL.test(email) || email.endsWith('.invalid')) return null;
  return email;
}

/** The first RDN's value: a name of last resort. */
function rdnValue(dn: string): string {
  const first = dn.split(/(?<!\\),/)[0] ?? dn;
  return first.slice(first.indexOf('=') + 1).trim();
}

function clip(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** The entry's stable identifier as Taskmoor stores it (objectGUID as GUID text). */
export function entryIdentifier(entry: LdapEntry, settings: DirectorySettings): string | null {
  const attribute = settings.attributes.id;
  if (settings.binary.some((b) => b.toLowerCase() === attribute.toLowerCase())) {
    const bytes = entry.bytes(attribute);
    return bytes && bytes.length > 0 ? guidText(bytes) : null;
  }
  return entry.first(attribute)?.trim() || null;
}

/** The attributes a person's search asks for. */
export function userAttributes(settings: DirectorySettings): string[] {
  const a = settings.attributes;
  const disabled =
    settings.disabled === 'account_control'
      ? ['userAccountControl']
      : settings.disabled === 'ppolicy_lock'
        ? ['pwdAccountLockedTime']
        : [];
  const names = [
    a.id,
    a.username,
    a.email,
    a.emailFallback,
    a.name,
    'cn',
    a.givenName,
    a.surname,
    a.changeMark,
    ...disabled,
  ];
  return [...new Set(names.filter((n) => n !== ''))];
}

export function groupAttributes(settings: DirectorySettings): string[] {
  const a = settings.attributes;
  return [...new Set([a.id, a.groupName, a.member, a.changeMark])];
}

/** Active Directory's ACCOUNTDISABLE bit; ppolicy's administrative lock (not a lockout). */
function isDisabled(entry: LdapEntry, settings: DirectorySettings): boolean {
  if (settings.disabled === 'account_control') {
    const flags = Number(entry.first('userAccountControl') ?? '0');
    return Number.isFinite(flags) && (flags & 2) === 2;
  }
  if (settings.disabled === 'ppolicy_lock') {
    return entry.values('pwdAccountLockedTime').some((v) => v.trim() === '000001010000Z');
  }
  return false;
}

export function readUser(
  entry: LdapEntry,
  settings: DirectorySettings,
): DirectoryUser | EntryProblem {
  const a = settings.attributes;
  const externalId = entryIdentifier(entry, settings);
  if (!externalId) return { problem: 'no_identifier', dn: entry.dn };
  const username = entry.first(a.username)?.trim() || rdnValue(entry.dn);
  const email =
    accountEmail(entry.first(a.email)) ??
    (a.emailFallback ? accountEmail(entry.first(a.emailFallback)) : null);
  const joined = [entry.first(a.givenName), entry.first(a.surname)]
    .filter((v) => v && v.trim() !== '')
    .join(' ');
  const name =
    entry.first(a.name)?.trim() || entry.first('cn')?.trim() || joined.trim() || username;
  return {
    externalId,
    dn: entry.dn,
    key: normalizeDn(entry.dn),
    username: clip(username, 256),
    email,
    name: clip(name, NAME_MAX),
    disabled: isDisabled(entry, settings),
    mark: entry.first(a.changeMark) ?? null,
  };
}

export function readGroup(
  entry: LdapEntry,
  settings: DirectorySettings,
): DirectoryGroup | EntryProblem {
  const a = settings.attributes;
  const externalId = entryIdentifier(entry, settings);
  if (!externalId) return { problem: 'no_identifier', dn: entry.dn };
  const name = entry.first(a.groupName)?.trim() || rdnValue(entry.dn);
  return {
    externalId,
    dn: entry.dn,
    key: normalizeDn(entry.dn),
    name: clip(name, GROUP_NAME_MAX),
    members: [...new Set(entry.values(a.member).map(normalizeDn))],
    mark: entry.first(a.changeMark) ?? null,
  };
}

/** Generalized time (`20261028120000Z`, with an optional fraction or offset) as a Date. */
export function parseGeneralizedTime(value: string): Date | null {
  const m =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,]\d+)?(Z|[+-]\d{2}(?:\d{2})?)$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, h, mi = '00', s = '00', zone = 'Z'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3, 5) || '00'}`}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatGeneralizedTime(at: Date): string {
  return `${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}
