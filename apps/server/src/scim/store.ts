import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { canonicalTimeZone, validLocale, validTimeZone } from '../directory';
import { invalidValue } from './errors';
import { type Resource, schemasOf } from './resource';
import { GROUP_TYPE, USER_TYPE } from './schemas';

/**
 * SCIM resources over Taskmoor's own tables (IAM-006, ADR-038).
 *
 * - A User is a person's account (`app_user`, never a service account): its email, name,
 *   locale, time zone and active state live there, so the rest of Taskmoor sees what the
 *   identity provider set. The userName, externalId and every other attribute (name parts,
 *   phone numbers, the enterprise extension, ...) live in `scim_user`, so the provider reads
 *   back what it wrote. A person no provider has touched shows the email as userName. A
 *   removed account (SCIM DELETE) no longer exists for SCIM.
 * - A Group is one the provider created: `user_group` with a `scim_group` row. Groups made in
 *   Taskmoor stay out of SCIM's reach, so a provider cannot add itself to the administrators.
 *   Members are people SCIM can see; other members (service accounts, nested groups) stay as
 *   they are whatever the provider sends.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** User attributes kept in `app_user` columns or computed; the rest go to `scim_user`. */
const USER_COLUMN_ATTRIBUTES = [
  'id',
  'externalId',
  'meta',
  'schemas',
  'userName',
  'displayName',
  'active',
  'locale',
  'timezone',
  'password',
  'groups',
];

export const NAME_MAX = 200;
const emailField = z.string().trim().toLowerCase().email().max(320);

export function userQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('app_user as a')
    .leftJoin('scim_user as s', 's.user_id', 'a.id')
    .select([
      'a.id',
      'a.email',
      'a.name',
      'a.locale',
      'a.time_zone',
      'a.deactivated_at',
      'a.created_at',
      'a.updated_at',
      'a.is_site_admin',
      'a.break_glass',
      's.user_name',
      's.external_id',
      's.attributes',
      's.updated_at as scim_updated_at',
      's.removed_at',
    ])
    .where('a.workspace_id', '=', workspaceId)
    .where('a.kind', '=', 'person');
}
export type UserRow = Awaited<ReturnType<ReturnType<typeof userQuery>['executeTakeFirstOrThrow']>>;

/** People SCIM can see: every person whose account SCIM has not removed. */
export function visibleUsers(db: Db, workspaceId: number) {
  return userQuery(db, workspaceId).where('s.removed_at', 'is', null);
}

export function groupQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('user_group as g')
    .innerJoin('scim_group as sg', 'sg.group_id', 'g.id')
    .select(['g.id', 'g.name', 'g.created_at', 'sg.external_id', 'sg.updated_at'])
    .where('g.workspace_id', '=', workspaceId);
}
export type GroupRow = Awaited<
  ReturnType<ReturnType<typeof groupQuery>['executeTakeFirstOrThrow']>
>;

export interface Named {
  id: number;
  name: string;
}

/** The members SCIM can see of each group, by group id, in user id order. */
export async function groupMembers(
  db: Db,
  workspaceId: number,
  groupIds: readonly number[],
): Promise<Map<number, Named[]>> {
  const out = new Map<number, Named[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return out;
  const rows = await db
    .selectFrom('group_member as m')
    .innerJoin('app_user as a', 'a.id', 'm.user_id')
    .leftJoin('scim_user as s', 's.user_id', 'a.id')
    .select(['m.group_id', 'a.id', 'a.name'])
    .where('m.workspace_id', '=', workspaceId)
    .where('m.group_id', 'in', [...groupIds])
    .where('a.kind', '=', 'person')
    .where('s.removed_at', 'is', null)
    .orderBy('m.group_id')
    .orderBy('a.id')
    .execute();
  for (const r of rows) out.get(r.group_id)?.push({ id: r.id, name: r.name });
  return out;
}

/** The SCIM groups each person is a direct member of, by user id. */
export async function userGroups(
  db: Db,
  workspaceId: number,
  userIds: readonly number[],
): Promise<Map<number, Named[]>> {
  const out = new Map<number, Named[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return out;
  const rows = await db
    .selectFrom('group_member as m')
    .innerJoin('user_group as g', 'g.id', 'm.group_id')
    .innerJoin('scim_group as sg', 'sg.group_id', 'g.id')
    .select(['m.user_id', 'g.id', 'g.name'])
    .where('m.workspace_id', '=', workspaceId)
    .where('m.user_id', 'in', [...userIds])
    .orderBy('m.user_id')
    .orderBy('g.id')
    .execute();
  for (const r of rows) out.get(r.user_id)?.push({ id: r.id, name: r.name });
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const later = (a: Date, b: Date | null) => (b && b > a ? b : a);

/**
 * The emails a provider stored, with the account's email among them and primary: it is the
 * address Taskmoor signs the person in and writes to.
 */
function emailsWith(stored: unknown, accountEmail: string): Resource[] {
  const list = (Array.isArray(stored) ? stored : []).filter(isRecord);
  const own = list.find(
    (e) => typeof e.value === 'string' && e.value.toLowerCase() === accountEmail.toLowerCase(),
  );
  if (!own) {
    return [
      { value: accountEmail, type: 'work', primary: true },
      ...list.map(({ primary: _drop, ...rest }) => rest),
    ];
  }
  return list.map((e) =>
    e === own ? { ...e, primary: true } : (({ primary: _drop, ...rest }) => rest)(e),
  );
}

/** A person as a SCIM User resource. */
export function userResource(row: UserRow, groups: readonly Named[], base: string): Resource {
  const extra = isRecord(row.attributes) ? (row.attributes as Resource) : {};
  const resource: Resource = {
    id: String(row.id),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name ?? row.email,
    ...extra,
    displayName: row.name,
    active: row.deactivated_at === null,
    emails: emailsWith(extra.emails, row.email),
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.time_zone ? { timezone: row.time_zone } : {}),
    ...(groups.length > 0
      ? {
          groups: groups.map((g) => ({
            value: String(g.id),
            $ref: `${base}/Groups/${g.id}`,
            display: g.name,
            type: 'direct',
          })),
        }
      : {}),
    meta: {
      resourceType: 'User',
      created: row.created_at.toISOString(),
      lastModified: later(row.updated_at, row.scim_updated_at).toISOString(),
      location: `${base}/Users/${row.id}`,
    },
  };
  return { schemas: schemasOf(resource, USER_TYPE), ...resource };
}

/** A provider's group as a SCIM Group resource. */
export function groupResource(row: GroupRow, members: readonly Named[] | null, base: string) {
  const resource: Resource = {
    id: String(row.id),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.name,
    ...(members && members.length > 0
      ? {
          members: members.map((m) => ({
            value: String(m.id),
            $ref: `${base}/Users/${m.id}`,
            display: m.name,
            type: 'User',
          })),
        }
      : {}),
    meta: {
      resourceType: 'Group',
      created: row.created_at.toISOString(),
      lastModified: later(row.created_at, row.updated_at).toISOString(),
      location: `${base}/Groups/${row.id}`,
    },
  };
  return { schemas: schemasOf(resource, GROUP_TYPE), ...resource };
}

/** What a User resource sets in Taskmoor. */
export interface UserValues {
  userName: string;
  externalId: string | null;
  email: string;
  name: string;
  active: boolean;
  locale: string | null;
  timeZone: string | null;
  attributes: Resource;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The account email: the primary address, else the work one, else the first, else the
 * userName when it is an address (Entra ID's usual setup).
 */
function pickEmail(resource: Resource): string {
  const emails = (Array.isArray(resource.emails) ? resource.emails : []).filter(isRecord);
  const chosen =
    emails.find((e) => e.primary === true) ??
    emails.find((e) => typeof e.type === 'string' && e.type.toLowerCase() === 'work') ??
    emails[0];
  const candidate = text(chosen?.value) ?? text(resource.userName);
  const parsed = emailField.safeParse(candidate);
  if (!parsed.success) throw invalidValue('A user needs an email address in emails or userName');
  return parsed.data;
}

/** The name people see: displayName, else the formatted name, else given and family name. */
function pickName(resource: Resource, userName: string): string {
  const name = isRecord(resource.name) ? resource.name : {};
  const joined = [text(name.givenName), text(name.familyName)].filter(Boolean).join(' ');
  const chosen = text(resource.displayName) ?? text(name.formatted) ?? (text(joined) || userName);
  if ([...chosen].length > NAME_MAX) throw invalidValue(`displayName is longer than ${NAME_MAX}`);
  return chosen;
}

/** Checks a canonical User resource and splits it into columns and kept attributes. */
export function userValues(resource: Resource): UserValues {
  const userName = text(resource.userName);
  if (!userName) throw invalidValue('userName is required');
  const locale = text(resource.locale) ?? null;
  if (locale !== null && !validLocale(locale)) throw invalidValue(`locale ${locale} is not valid`);
  const zone = text(resource.timezone) ?? null;
  if (zone !== null && !validTimeZone(zone)) throw invalidValue(`timezone ${zone} is not valid`);
  const attributes: Resource = {};
  for (const [key, value] of Object.entries(resource)) {
    if (!USER_COLUMN_ATTRIBUTES.includes(key)) attributes[key] = value;
  }
  return {
    userName,
    externalId: text(resource.externalId) ?? null,
    email: pickEmail(resource),
    name: pickName(resource, userName),
    active: resource.active !== false,
    locale,
    timeZone: zone === null ? null : canonicalTimeZone(zone),
    attributes,
  };
}

/** The visible person whose userName this is (case-insensitive), other than `except`. */
export async function userNameHolder(
  db: Db,
  workspaceId: number,
  userName: string,
  except: number | null,
): Promise<number | null> {
  let query = visibleUsers(db, workspaceId).where(
    sql<string>`lower(coalesce(s.user_name, a.email))`,
    '=',
    userName.toLowerCase(),
  );
  if (except !== null) query = query.where('a.id', '<>', except);
  const row = await query.executeTakeFirst();
  return row?.id ?? null;
}

/** JSON for a jsonb column. */
export const json = (value: Resource | JsonValue) => JSON.stringify(value);

/** Postgres unique_violation, with the constraint that refused. */
export function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}
