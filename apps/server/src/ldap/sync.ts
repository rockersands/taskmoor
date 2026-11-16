import type { Database, JsonValue } from '@taskmoor/db';
import type { PepperRing } from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';
import {
  dropLapsedCreateTracks,
  type LapsedCreateTracks,
  lapsedPayload,
} from '../authz/create-tracks';
import { emitMany } from '../events/bus';
import type { DomainEventInput } from '../events/catalogue';
import { deactivateAccount, lockNesting, reactivateAccount } from './accounts';
import { DirectoryClient, idFilter, type LdapEntry, memberFilter } from './client';
import { breakCycles, type Edge } from './nesting';
import {
  type DirectoryGroup,
  type DirectoryUser,
  type EntryProblem,
  entryIdentifier,
  formatGeneralizedTime,
  groupAttributes,
  normalizeDn,
  parseGeneralizedTime,
  readGroup,
  readUser,
  userAttributes,
} from './read';
import {
  DIRECTORY_COLUMNS,
  type DirectoryRow,
  type DirectorySettings,
  directorySettings,
} from './settings';

/**
 * Directory sync (M1-082; IAM-005; ADR-019): people and groups, nested to any depth, from an
 * LDAP or Active Directory directory into Taskmoor's accounts and groups.
 *
 * - A full run reads every person and group under the configured bases and filters. An
 *   incremental run reads what changed since the cursor (Active Directory: uSNChanged above the
 *   domain controller's highestCommittedUSN read before the last run; others: modifyTimestamp
 *   from shortly before the newest change seen), plus the identifiers of every entry in scope,
 *   which shows deletions and entries that entered or left the filters without changing.
 * - People are matched by the entry's stable identifier; a new entry links the existing account
 *   with its address (clearing its local password: the directory checks it from now on) or
 *   creates one. Break-glass accounts, service accounts and accounts a directory of higher
 *   precedence manages are left alone. Disabled entries and entries that left the directory
 *   deactivate their account and end its sessions; only accounts the sync deactivated come
 *   back. The last active site administrator is never deactivated.
 * - Groups are the directory's own (`ldap_group`); their members and nested groups follow it.
 *   Members outside the filters are ignored. Nesting that would loop is dropped edge by edge
 *   (`nesting.ts`) and reported.
 * - Changes are written in chunks, each a transaction with its events: one per account or
 *   group changed, no actor, the directory and the run named. A run that would remove more than
 *   half of the directory's people or groups stops before changing anything, unless an
 *   administrator confirmed it.
 */
type Db = Kysely<Database>;
type Trx = Transaction<Database>;

export interface SyncDeps {
  peppers?: PepperRing | undefined;
  /** Diagnostics; never given a secret. */
  log?: (message: string, details: Record<string, unknown>) => void;
  /** Ends the run at its next chunk (the worker is stopping). */
  signal?: AbortSignal;
}

export type SyncStats = Record<string, number>;

export interface SyncWarning {
  code: string;
  dn?: string;
  detail?: string;
}

interface Cursor {
  kind: 'usn' | 'timestamp';
  /** The USN or generalized time the next incremental run starts from. */
  value: string;
  /** Active Directory: the domain controller the USN belongs to. */
  server?: string | null;
  /** Entries in scope that the sync skipped (no address, protected account ...). */
  skipped?: string[];
}

interface RunRow {
  id: number;
  workspace_id: number;
  directory_id: number;
  mode: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  confirm_removals: boolean;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
}

interface Context {
  db: Db;
  ws: number;
  directory: DirectoryRow;
  settings: DirectorySettings;
  run: RunRow;
  mode: 'full' | 'incremental';
  stats: SyncStats;
  warnings: SyncWarning[];
  skipped: Set<string>;
  now: Date;
  signal: AbortSignal | undefined;
  /**
   * People who left a group this run: taken out of it, inside a group taken out of another, or in
   * a group deleted. The run's last step checks whether they still run a track (T-087b, T-259).
   */
  leftGroups: Set<number>;
}

/** People or groups per transaction. */
const CHUNK = 500;
const MAX_WARNINGS = 200;
/** Listed member ids per event; the counts are complete. */
const EVENT_IDS = 1000;
/** A removal above this share of the known entries needs an administrator's confirmation. */
const SAFETY_SHARE = 0.5;
const SAFETY_MINIMUM = 10;
/** modifyTimestamp cursors start this long before the newest change seen. */
const TIMESTAMP_OVERLAP_MS = 10 * 60 * 1000;
const MAX_SKIPPED = 10_000;

export class SafetyStop extends Error {
  constructor(what: string, removed: number, known: number) {
    super(
      `safety_stop: the run would remove ${removed} of ${known} ${what}; check the filters, or run a full sync confirming removals`,
    );
  }
}

function count(ctx: Context, name: string, by = 1): void {
  ctx.stats[name] = (ctx.stats[name] ?? 0) + by;
}

function warn(ctx: Context, code: string, dn?: string, detail?: string): void {
  count(ctx, 'warnings');
  if (ctx.warnings.length < MAX_WARNINGS) {
    ctx.warnings.push({ code, ...(dn ? { dn } : {}), ...(detail ? { detail } : {}) });
  }
}

const by = (ctx: Context) => ({ workspaceId: ctx.ws, actorId: null, ip: null });
const tag = (ctx: Context) => ({ directoryId: ctx.directory.id, runId: ctx.run.id });
const cap = (ids: number[]) => ids.slice(0, EVENT_IDS);

async function heartbeat(db: Db, runId: number): Promise<void> {
  await db
    .updateTable('ldap_sync_run')
    .set({ heartbeat_at: new Date() })
    .where('id', '=', runId)
    .execute();
}

/** Between chunks: stop when the worker is stopping, else show the run is alive. */
async function checkpoint(ctx: Context): Promise<void> {
  if (ctx.signal?.aborted) throw new Error('worker_stopped');
  await heartbeat(ctx.db, ctx.run.id);
}

// ---- Reading ----

function isProblem<T>(value: T | EntryProblem): value is EntryProblem {
  return (value as EntryProblem).problem !== undefined;
}

async function collect<T>(
  ctx: Context,
  pages: AsyncGenerator<LdapEntry[]>,
  read: (entry: LdapEntry) => T | EntryProblem,
  into: T[],
): Promise<void> {
  for await (const page of pages) {
    for (const entry of page) {
      const value = read(entry);
      if (isProblem(value)) warn(ctx, value.problem, value.dn);
      else into.push(value);
    }
  }
}

async function readIds(
  client: DirectoryClient,
  base: string,
  filter: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const settings = client.settings;
  for await (const page of client.search(base, filter, [settings.attributes.id], {
    pageSize: 1000,
  })) {
    for (const entry of page) {
      const id = entryIdentifier(entry, settings);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Entries by identifier, a hundred per search. */
async function readByIds<T>(
  ctx: Context,
  client: DirectoryClient,
  base: string,
  filter: string,
  ids: string[],
  attributes: string[],
  read: (entry: LdapEntry) => T | EntryProblem,
  ranged: string[] = [],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    await collect(
      ctx,
      client.search(base, idFilter(client.settings, filter, slice), attributes, { ranged }),
      read,
      out,
    );
  }
  return out;
}

// ---- People ----

interface UserLink {
  user_id: number;
  external_id: string;
  dn: string;
  username: string;
  disabled: boolean;
  deactivated_by_sync: boolean;
  removed_at: Date | null;
  email: string;
  name: string;
  deactivated_at: Date | null;
  is_site_admin: boolean;
  break_glass: boolean;
}

async function loadUserLinks(db: Db, directoryId: number): Promise<UserLink[]> {
  return db
    .selectFrom('ldap_user as l')
    .innerJoin('app_user as a', 'a.id', 'l.user_id')
    .select([
      'l.user_id',
      'l.external_id',
      'l.dn',
      'l.username',
      'l.disabled',
      'l.deactivated_by_sync',
      'l.removed_at',
      'a.email',
      'a.name',
      'a.deactivated_at',
      'a.is_site_admin',
      'a.break_glass',
    ])
    .where('l.directory_id', '=', directoryId)
    .execute();
}

/** Removes the accounts whose entries are gone: deactivated (unless protected) and out of the groups. */
async function removeUsers(ctx: Context, links: UserLink[]): Promise<void> {
  for (let i = 0; i < links.length; i += CHUNK) {
    await ctx.db.transaction().execute(async (trx) => {
      const events: DomainEventInput[] = [];
      for (const link of links.slice(i, i + CHUNK)) {
        const outcome = await deactivateAccount(trx, ctx.ws, link.user_id, ctx.now);
        if (outcome.refused) warn(ctx, `kept_${outcome.refused}`, link.dn);
        await trx
          .updateTable('ldap_user')
          .set({
            removed_at: ctx.now,
            deactivated_by_sync: link.deactivated_by_sync || outcome.deactivated,
            synced_at: ctx.now,
          })
          .where('user_id', '=', link.user_id)
          .execute();
        await trx
          .deleteFrom('group_member')
          .where('user_id', '=', link.user_id)
          .where('group_id', 'in', (eb) =>
            eb
              .selectFrom('ldap_group')
              .select('group_id')
              .where('directory_id', '=', ctx.directory.id),
          )
          .execute();
        // Deactivated, or out of the directory's groups, the person may run no track: a
        // permission to create tracks that came with a role goes (T-087b; IAM-033).
        const lapsed = [
          ...outcome.lapsed,
          ...(await dropLapsedCreateTracks(trx, ctx.ws, [link.user_id])),
        ];
        count(ctx, 'usersRemoved');
        if (outcome.deactivated) count(ctx, 'usersDeactivated');
        events.push({
          type: 'directory.user_removed',
          subjectId: link.user_id,
          payload: {
            ...tag(ctx),
            username: link.username,
            dn: link.dn,
            deactivated: outcome.deactivated,
            endedSessions: outcome.endedSessions,
            ...lapsedPayload(lapsed),
          },
        });
      }
      await emitMany(trx, by(ctx), events);
    });
    await checkpoint(ctx);
  }
}

/** Emails other accounts hold, among these. */
async function emailHolders(db: Db, ws: number, emails: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < emails.length; i += 1000) {
    const rows = await db
      .selectFrom('app_user')
      .select(['id', sql<string>`lower(email)`.as('email')])
      .where('workspace_id', '=', ws)
      .where(sql<string>`lower(email)`, 'in', emails.slice(i, i + 1000))
      .execute();
    for (const r of rows) out.set(r.email, r.id);
  }
  return out;
}

/** Brings linked accounts in line with their entries; `reclaimed` gives a link a new identifier. */
async function updateUsers(
  ctx: Context,
  updates: { entry: DirectoryUser; link: UserLink; reclaimed: boolean }[],
): Promise<DirectoryUser[]> {
  const revived: DirectoryUser[] = [];
  const newEmails = updates
    .filter((u) => u.entry.email && u.entry.email !== u.link.email.toLowerCase())
    .map((u) => u.entry.email as string);
  const holders = await emailHolders(ctx.db, ctx.ws, newEmails);
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const work = slice.filter(({ entry, link, reclaimed }) => {
      const emailChange = entry.email !== null && entry.email !== link.email.toLowerCase();
      const active = link.deactivated_at === null;
      return (
        reclaimed ||
        link.removed_at !== null ||
        emailChange ||
        entry.name !== link.name ||
        entry.dn !== link.dn ||
        entry.username !== link.username ||
        entry.disabled !== link.disabled ||
        (entry.disabled && active && !link.break_glass) ||
        (!entry.disabled && !active && link.deactivated_by_sync)
      );
    });
    if (work.length === 0) continue;
    await ctx.db.transaction().execute(async (trx) => {
      const events: DomainEventInput[] = [];
      for (const { entry, link, reclaimed } of work) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const account: { email?: string; name?: string } = {};
        if (entry.email !== null && entry.email !== link.email.toLowerCase()) {
          const holder = holders.get(entry.email);
          if (holder !== undefined && holder !== link.user_id) {
            warn(ctx, 'email_taken', entry.dn, entry.email);
          } else {
            account.email = entry.email;
            changes.email = { from: link.email, to: entry.email };
          }
        }
        if (entry.name !== link.name) {
          account.name = entry.name;
          changes.name = { from: link.name, to: entry.name };
        }
        if (entry.dn !== link.dn) changes.dn = { from: link.dn, to: entry.dn };
        if (entry.username !== link.username) {
          changes.username = { from: link.username, to: entry.username };
        }
        if (reclaimed) changes.externalId = { from: link.external_id, to: entry.externalId };
        if (entry.disabled !== link.disabled) {
          changes.disabled = { from: link.disabled, to: entry.disabled };
        }
        if (link.removed_at !== null) {
          changes.restored = { from: false, to: true };
          revived.push(entry);
        }
        let deactivatedBySync = link.deactivated_by_sync;
        let endedSessions = 0;
        let lapsed: LapsedCreateTracks[] = [];
        const active = link.deactivated_at === null;
        if (entry.disabled && active) {
          const outcome = await deactivateAccount(trx, ctx.ws, link.user_id, ctx.now);
          if (outcome.refused) warn(ctx, `kept_${outcome.refused}`, entry.dn);
          if (outcome.deactivated) {
            deactivatedBySync = true;
            endedSessions = outcome.endedSessions;
            lapsed = outcome.lapsed;
            changes.active = { from: true, to: false };
            count(ctx, 'usersDeactivated');
          }
        } else if (!entry.disabled && !active && link.deactivated_by_sync) {
          if (await reactivateAccount(trx, link.user_id, ctx.now)) {
            changes.active = { from: false, to: true };
            count(ctx, 'usersReactivated');
          }
          deactivatedBySync = false;
        }
        await trx
          .updateTable('ldap_user')
          .set({
            external_id: entry.externalId,
            dn: entry.dn,
            username: entry.username,
            disabled: entry.disabled,
            deactivated_by_sync: deactivatedBySync,
            removed_at: null,
            synced_at: ctx.now,
          })
          .where('user_id', '=', link.user_id)
          .execute();
        if (account.email !== undefined || account.name !== undefined) {
          await trx
            .updateTable('app_user')
            .set({ ...account, updated_at: ctx.now })
            .where('id', '=', link.user_id)
            .execute();
        }
        if (Object.keys(changes).length > 0) {
          count(ctx, 'usersUpdated');
          events.push({
            type: 'directory.user_updated',
            subjectId: link.user_id,
            payload: { ...tag(ctx), changes, endedSessions, ...lapsedPayload(lapsed) },
          });
        }
      }
      await emitMany(trx, by(ctx), events);
    });
    await checkpoint(ctx);
  }
  return revived;
}

interface Candidate {
  id: number;
  email: string;
  kind: 'person' | 'service';
  break_glass: boolean;
  deactivated_at: Date | null;
  directory_id: number | null;
  removed_at: Date | null;
  position: number | null;
}

/** True when the other directory comes before this one (lower position, then lower id). */
function outranks(ctx: Context, other: { position: number | null; directory_id: number | null }) {
  if (other.directory_id === null || other.position === null) return false;
  if (other.position !== ctx.directory.position) return other.position < ctx.directory.position;
  return other.directory_id < ctx.directory.id;
}

/** New entries: link the account with their address, or create one. Returns the entries now linked. */
async function addUsers(ctx: Context, fresh: DirectoryUser[]): Promise<DirectoryUser[]> {
  const added: DirectoryUser[] = [];
  const seenEmails = new Set<string>();
  const usable: DirectoryUser[] = [];
  for (const entry of fresh) {
    if (!entry.email) {
      warn(ctx, 'no_email', entry.dn);
      ctx.skipped.add(entry.externalId);
      continue;
    }
    if (seenEmails.has(entry.email)) {
      warn(ctx, 'duplicate_email', entry.dn, entry.email);
      ctx.skipped.add(entry.externalId);
      continue;
    }
    seenEmails.add(entry.email);
    usable.push(entry);
  }
  const candidates = new Map<string, Candidate>();
  for (let i = 0; i < usable.length; i += 1000) {
    const emails = usable.slice(i, i + 1000).map((u) => u.email as string);
    const rows = await ctx.db
      .selectFrom('app_user as a')
      .leftJoin('ldap_user as l', 'l.user_id', 'a.id')
      .leftJoin('ldap_directory as d', 'd.id', 'l.directory_id')
      .select([
        'a.id',
        sql<string>`lower(a.email)`.as('email'),
        'a.kind',
        'a.break_glass',
        'a.deactivated_at',
        'l.directory_id',
        'l.removed_at',
        'd.position',
      ])
      .where('a.workspace_id', '=', ctx.ws)
      .where(sql<string>`lower(a.email)`, 'in', emails)
      .execute();
    for (const r of rows) candidates.set(r.email, r as Candidate);
  }
  const creates: DirectoryUser[] = [];
  const links: { entry: DirectoryUser; account: Candidate }[] = [];
  for (const entry of usable) {
    const account = candidates.get(entry.email as string);
    if (!account) {
      creates.push(entry);
      continue;
    }
    let refusal: string | null = null;
    if (account.kind === 'service') refusal = 'service_account_email';
    else if (account.break_glass) refusal = 'break_glass_account';
    else if (account.directory_id === ctx.directory.id && account.removed_at === null) {
      refusal = 'duplicate_email';
    } else if (
      account.directory_id !== null &&
      account.removed_at === null &&
      outranks(ctx, account)
    ) {
      refusal = 'managed_by_other_directory';
    }
    if (refusal) {
      warn(ctx, refusal, entry.dn, entry.email ?? undefined);
      ctx.skipped.add(entry.externalId);
      continue;
    }
    links.push({ entry, account });
  }

  for (let i = 0; i < links.length; i += CHUNK) {
    await ctx.db.transaction().execute(async (trx) => {
      const events: DomainEventInput[] = [];
      for (const { entry, account } of links.slice(i, i + CHUNK)) {
        const takenFrom =
          account.directory_id !== null && account.directory_id !== ctx.directory.id
            ? account.directory_id
            : null;
        await trx.deleteFrom('ldap_user').where('user_id', '=', account.id).execute();
        let deactivated = false;
        let lapsed: LapsedCreateTracks[] = [];
        if (entry.disabled && account.deactivated_at === null) {
          const outcome = await deactivateAccount(trx, ctx.ws, account.id, ctx.now);
          if (outcome.refused) warn(ctx, `kept_${outcome.refused}`, entry.dn);
          deactivated = outcome.deactivated;
          lapsed = outcome.lapsed;
          if (deactivated) count(ctx, 'usersDeactivated');
        }
        await trx
          .insertInto('ldap_user')
          .values({
            user_id: account.id,
            workspace_id: ctx.ws,
            directory_id: ctx.directory.id,
            external_id: entry.externalId,
            dn: entry.dn,
            username: entry.username,
            disabled: entry.disabled,
            deactivated_by_sync: deactivated,
            synced_at: ctx.now,
          })
          .execute();
        // The directory checks the password from now on; the local one must not come back.
        await trx
          .updateTable('app_user')
          .set({ name: entry.name, password_hash: null, updated_at: ctx.now })
          .where('id', '=', account.id)
          .execute();
        await trx
          .deleteFrom('password_link')
          .where('user_id', '=', account.id)
          .where('used_at', 'is', null)
          .execute();
        count(ctx, 'usersLinked');
        added.push(entry);
        events.push({
          type: 'directory.user_created',
          subjectId: account.id,
          payload: {
            ...tag(ctx),
            email: entry.email as string,
            username: entry.username,
            dn: entry.dn,
            linked: true,
            takenFromDirectoryId: takenFrom,
            active: account.deactivated_at === null && !deactivated,
            ...lapsedPayload(lapsed),
          },
        });
      }
      await emitMany(trx, by(ctx), events);
    });
    await checkpoint(ctx);
  }

  for (let i = 0; i < creates.length; i += CHUNK) {
    const slice = creates.slice(i, i + CHUNK);
    try {
      await createUsers(ctx, slice);
      added.push(...slice);
    } catch (error) {
      // Someone took one of the addresses meanwhile: one by one, so only that one is skipped.
      if ((error as { code?: string }).code !== '23505') throw error;
      for (const entry of slice) {
        try {
          await createUsers(ctx, [entry]);
          added.push(entry);
        } catch (single) {
          if ((single as { code?: string }).code !== '23505') throw single;
          warn(ctx, 'email_taken', entry.dn, entry.email ?? undefined);
          ctx.skipped.add(entry.externalId);
        }
      }
    }
    await checkpoint(ctx);
  }
  return added;
}

async function createUsers(ctx: Context, entries: DirectoryUser[]): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const rows = await trx
      .insertInto('app_user')
      .values(
        entries.map((e) => ({
          workspace_id: ctx.ws,
          email: e.email as string,
          name: e.name,
          password_hash: null,
          deactivated_at: e.disabled ? ctx.now : null,
        })),
      )
      .returning(['id', 'email'])
      .execute();
    const ids = new Map(rows.map((r) => [r.email, r.id]));
    await trx
      .insertInto('ldap_user')
      .values(
        entries.map((e) => ({
          user_id: ids.get(e.email as string) as number,
          workspace_id: ctx.ws,
          directory_id: ctx.directory.id,
          external_id: e.externalId,
          dn: e.dn,
          username: e.username,
          disabled: e.disabled,
          deactivated_by_sync: e.disabled,
          synced_at: ctx.now,
        })),
      )
      .execute();
    await emitMany(
      trx,
      by(ctx),
      entries.map((e) => ({
        type: 'directory.user_created',
        subjectId: ids.get(e.email as string) as number,
        payload: {
          ...tag(ctx),
          email: e.email as string,
          username: e.username,
          dn: e.dn,
          linked: false,
          takenFromDirectoryId: null,
          active: !e.disabled,
        },
      })),
    );
  });
  count(ctx, 'usersCreated', entries.length);
}

/**
 * Applies people: removals, then updates (a new entry with the address of an account this
 * directory lost takes that account over), then new entries. Returns the entries that were
 * added or came back, whose groups an incremental run must re-read.
 */
async function applyUsers(
  ctx: Context,
  entries: DirectoryUser[],
  removed: UserLink[],
  links: UserLink[],
): Promise<DirectoryUser[]> {
  const byExternal = new Map(links.map((l) => [l.external_id, l]));
  const gone = new Map<string, UserLink>();
  for (const l of [...links.filter((l) => l.removed_at !== null), ...removed]) {
    gone.set(l.email.toLowerCase(), l);
  }
  const updates: { entry: DirectoryUser; link: UserLink; reclaimed: boolean }[] = [];
  const fresh: DirectoryUser[] = [];
  const reclaimed = new Set<number>();
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (seen.has(entry.externalId)) continue;
    seen.add(entry.externalId);
    ctx.skipped.delete(entry.externalId);
    const link = byExternal.get(entry.externalId);
    if (link) {
      updates.push({ entry, link, reclaimed: false });
      continue;
    }
    const previous = entry.email ? gone.get(entry.email) : undefined;
    if (previous && !reclaimed.has(previous.user_id)) {
      reclaimed.add(previous.user_id);
      updates.push({ entry, link: previous, reclaimed: true });
      continue;
    }
    fresh.push(entry);
  }
  await removeUsers(
    ctx,
    removed.filter((l) => !reclaimed.has(l.user_id) && l.removed_at === null),
  );
  const revived = await updateUsers(ctx, updates);
  const added = await addUsers(ctx, fresh);
  return [...revived, ...added];
}

// ---- Groups ----

interface GroupLink {
  group_id: number;
  external_id: string;
  dn: string;
  name: string;
}

async function loadGroupLinks(db: Db, directoryId: number): Promise<GroupLink[]> {
  return db
    .selectFrom('ldap_group as l')
    .innerJoin('user_group as g', 'g.id', 'l.group_id')
    .select(['l.group_id', 'l.external_id', 'l.dn', 'g.name'])
    .where('l.directory_id', '=', directoryId)
    .execute();
}

const GROUP_NAME_MAX = 255;

/**
 * A free group name: the directory's own, else with the directory's name after it, else
 * numbered. A group keeps the name it already has when that is still the answer.
 */
function groupName(
  ctx: Context,
  taken: Map<string, number>,
  wanted: string,
  self: number | null,
): string {
  const free = (name: string) => {
    const holder = taken.get(name.toLowerCase());
    return holder === undefined || holder === self;
  };
  const fit = (base: string, suffix: string) =>
    `${[...base].slice(0, GROUP_NAME_MAX - [...suffix].length).join('')}${suffix}`;
  if (free(wanted)) return wanted;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? ` (${ctx.directory.name})` : ` (${ctx.directory.name} ${n})`;
    const name = fit(wanted, suffix);
    if (free(name)) return name;
  }
  return fit(wanted, ` (${ctx.run.id}-${self ?? 'new'})`);
}

interface GroupOutcome {
  /** Groups whose members to bring in line, by id. */
  targets: Map<number, DirectoryGroup>;
  created: Set<number>;
  /** Name and DN changes per group, reported with the membership changes. */
  changes: Map<number, Record<string, { from: unknown; to: unknown }>>;
}

async function applyGroups(
  ctx: Context,
  entries: DirectoryGroup[],
  removed: GroupLink[],
  links: GroupLink[],
): Promise<GroupOutcome> {
  const outcome: GroupOutcome = { targets: new Map(), created: new Set(), changes: new Map() };
  for (let i = 0; i < removed.length; i += CHUNK) {
    await ctx.db.transaction().execute(async (trx) => {
      const slice = removed.slice(i, i + CHUNK);
      await lockNesting(trx, ctx.ws);
      // Everyone in them, nested groups included, may run no track without them (T-259).
      for (const u of await membersWithin(
        trx,
        ctx.ws,
        slice.map((g) => g.group_id),
      )) {
        ctx.leftGroups.add(u);
      }
      await trx
        .deleteFrom('user_group')
        .where(
          'id',
          'in',
          slice.map((g) => g.group_id),
        )
        .execute();
      count(ctx, 'groupsDeleted', slice.length);
      await emitMany(
        trx,
        by(ctx),
        slice.map((g) => ({
          type: 'directory.group_deleted',
          subjectId: g.group_id,
          payload: { ...tag(ctx), name: g.name },
        })),
      );
    });
  }

  const taken = new Map<string, number>();
  for (const r of await ctx.db
    .selectFrom('user_group')
    .select(['id', 'name'])
    .where('workspace_id', '=', ctx.ws)
    .execute()) {
    taken.set(r.name.toLowerCase(), r.id);
  }
  const byExternal = new Map(links.map((l) => [l.external_id, l]));
  const fresh: DirectoryGroup[] = [];
  const renames: { link: GroupLink; entry: DirectoryGroup; name: string }[] = [];
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.externalId)) continue;
    seen.add(entry.externalId);
    const link = byExternal.get(entry.externalId);
    if (!link) {
      fresh.push(entry);
      continue;
    }
    outcome.targets.set(link.group_id, entry);
    const name = groupName(ctx, taken, entry.name, link.group_id);
    if (name !== link.name || entry.dn !== link.dn) {
      if (name !== link.name) {
        taken.delete(link.name.toLowerCase());
        taken.set(name.toLowerCase(), link.group_id);
      }
      renames.push({ link, entry, name });
    }
  }
  for (let i = 0; i < renames.length; i += CHUNK) {
    await ctx.db.transaction().execute(async (trx) => {
      for (const { link, entry, name } of renames.slice(i, i + CHUNK)) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (name !== link.name) {
          // Free the old name first: two groups may swap names in one run.
          await trx
            .updateTable('user_group')
            .set({ name: sql<string>`name || ' ' || ${`#${link.group_id}`}` })
            .where('id', '=', link.group_id)
            .execute();
          changes.name = { from: link.name, to: name };
        }
        if (entry.dn !== link.dn) changes.dn = { from: link.dn, to: entry.dn };
        await trx
          .updateTable('ldap_group')
          .set({ dn: entry.dn, synced_at: ctx.now })
          .where('group_id', '=', link.group_id)
          .execute();
        outcome.changes.set(link.group_id, changes);
      }
      for (const { link, name } of renames.slice(i, i + CHUNK)) {
        if (name !== link.name) {
          await trx
            .updateTable('user_group')
            .set({ name })
            .where('id', '=', link.group_id)
            .execute();
        }
      }
    });
  }

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const names = slice.map((entry) => {
      const name = groupName(ctx, taken, entry.name, null);
      taken.set(name.toLowerCase(), -1);
      return name;
    });
    await ctx.db.transaction().execute(async (trx) => {
      const rows = await trx
        .insertInto('user_group')
        .values(names.map((name) => ({ workspace_id: ctx.ws, name })))
        .returning(['id', 'name'])
        .execute();
      const ids = new Map(rows.map((r) => [r.name, r.id]));
      await trx
        .insertInto('ldap_group')
        .values(
          slice.map((entry, k) => ({
            group_id: ids.get(names[k] as string) as number,
            workspace_id: ctx.ws,
            directory_id: ctx.directory.id,
            external_id: entry.externalId,
            dn: entry.dn,
            synced_at: ctx.now,
          })),
        )
        .execute();
      slice.forEach((entry, k) => {
        const id = ids.get(names[k] as string) as number;
        taken.set((names[k] as string).toLowerCase(), id);
        outcome.targets.set(id, entry);
        outcome.created.add(id);
      });
    });
    count(ctx, 'groupsCreated', slice.length);
  }
  return outcome;
}

/** People in any of these groups, directly or through groups nested inside them. */
async function membersWithin(
  trx: Trx,
  workspaceId: number,
  groupIds: readonly number[],
): Promise<number[]> {
  if (groupIds.length === 0) return [];
  const ids = sql.join(groupIds.map((g) => sql`${g}::int`));
  const { rows } = await sql<{ user_id: number }>`
    WITH RECURSIVE d(id) AS (
      SELECT g.id FROM user_group g WHERE g.workspace_id = ${workspaceId} AND g.id IN (${ids})
      UNION
      SELECT n.child_id FROM group_nesting n JOIN d ON n.parent_id = d.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT m.user_id FROM group_member m JOIN d ON m.group_id = d.id
     WHERE m.workspace_id = ${workspaceId}`.execute(trx);
  return rows.map((r) => r.user_id);
}

// ---- Memberships ----

async function applyMemberships(ctx: Context, outcome: GroupOutcome): Promise<void> {
  const users = new Map<string, number>();
  for (const r of await ctx.db
    .selectFrom('ldap_user')
    .select(['user_id', 'dn'])
    .where('directory_id', '=', ctx.directory.id)
    .where('removed_at', 'is', null)
    .execute()) {
    users.set(normalizeDn(r.dn), r.user_id);
  }
  const groupDn = new Map<number, string>();
  const groups = new Map<string, number>();
  for (const r of await ctx.db
    .selectFrom('ldap_group')
    .select(['group_id', 'dn'])
    .where('directory_id', '=', ctx.directory.id)
    .execute()) {
    groups.set(normalizeDn(r.dn), r.group_id);
    groupDn.set(r.group_id, normalizeDn(r.dn));
  }

  const wantedMembers = new Map<number, Set<number>>();
  const edges: Edge[] = [];
  for (const [id, entry] of outcome.targets) {
    const members = new Set<number>();
    for (const dn of entry.members) {
      const user = users.get(dn);
      if (user !== undefined) {
        members.add(user);
        continue;
      }
      const child = groups.get(dn);
      if (child !== undefined) edges.push([id, child]);
      else count(ctx, 'unresolvedMembers');
    }
    wantedMembers.set(id, members);
  }
  // Every nesting edge among the directory's groups: the targets' new ones, the others' current.
  const currentEdges = await ctx.db
    .selectFrom('group_nesting as n')
    .innerJoin('ldap_group as p', 'p.group_id', 'n.parent_id')
    .select(['n.parent_id', 'n.child_id'])
    .where('p.directory_id', '=', ctx.directory.id)
    .execute();
  const currentChildren = new Map<number, Set<number>>();
  for (const e of currentEdges) {
    const set = currentChildren.get(e.parent_id) ?? new Set<number>();
    set.add(e.child_id);
    currentChildren.set(e.parent_id, set);
    if (!outcome.targets.has(e.parent_id)) edges.push([e.parent_id, e.child_id]);
  }
  const dnOf = (id: number) => groupDn.get(id) ?? '';
  const { kept, dropped } = breakCycles(edges, (a, b) => {
    const x = `${dnOf(a[0])}\u0000${dnOf(a[1])}`;
    const y = `${dnOf(b[0])}\u0000${dnOf(b[1])}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const [p, c] of dropped) {
    count(ctx, 'cyclesBroken');
    warn(ctx, 'nesting_cycle', groupDn.get(p), groupDn.get(c));
  }
  const wantedChildren = new Map<number, Set<number>>();
  for (const id of outcome.targets.keys()) wantedChildren.set(id, new Set());
  for (const [p, c] of kept) {
    const set = wantedChildren.get(p) ?? new Set<number>();
    set.add(c);
    wantedChildren.set(p, set);
  }
  // Groups outside the targets change only when a cycle cost them an edge.
  const parents = new Set<number>(outcome.targets.keys());
  for (const [p, children] of currentChildren) {
    if (parents.has(p)) continue;
    const wanted = wantedChildren.get(p) ?? new Set<number>();
    if (wanted.size !== children.size || [...children].some((c) => !wanted.has(c))) parents.add(p);
  }

  const ordered = [...parents].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i += 200) {
    const slice = ordered.slice(i, i + 200);
    const memberRows = await ctx.db
      .selectFrom('group_member')
      .select(['group_id', 'user_id'])
      .where('group_id', 'in', slice)
      .execute();
    const currentMembers = new Map<number, Set<number>>();
    for (const r of memberRows) {
      const set = currentMembers.get(r.group_id) ?? new Set<number>();
      set.add(r.user_id);
      currentMembers.set(r.group_id, set);
    }
    await ctx.db.transaction().execute(async (trx) => {
      const events: DomainEventInput[] = [];
      let nestingLocked = false;
      const addRows: { workspace_id: number; group_id: number; user_id: number }[] = [];
      for (const id of slice) {
        const isTarget = outcome.targets.has(id);
        const have = currentMembers.get(id) ?? new Set<number>();
        const want = isTarget ? (wantedMembers.get(id) ?? new Set<number>()) : have;
        const added = [...want].filter((u) => !have.has(u)).sort((a, b) => a - b);
        const removed = [...have].filter((u) => !want.has(u)).sort((a, b) => a - b);
        const haveChildren = currentChildren.get(id) ?? new Set<number>();
        const wantChildren = wantedChildren.get(id) ?? new Set<number>();
        const nested = [...wantChildren].filter((c) => !haveChildren.has(c)).sort((a, b) => a - b);
        const unnested = [...haveChildren]
          .filter((c) => !wantChildren.has(c))
          .sort((a, b) => a - b);
        if (removed.length > 0) {
          await trx
            .deleteFrom('group_member')
            .where('group_id', '=', id)
            .where('user_id', 'in', removed)
            .execute();
          for (const u of removed) ctx.leftGroups.add(u);
        }
        for (const u of added) addRows.push({ workspace_id: ctx.ws, group_id: id, user_id: u });
        if ((nested.length > 0 || unnested.length > 0) && !nestingLocked) {
          await lockNesting(trx, ctx.ws);
          nestingLocked = true;
        }
        if (unnested.length > 0) {
          await trx
            .deleteFrom('group_nesting')
            .where('parent_id', '=', id)
            .where('child_id', 'in', unnested)
            .execute();
          // The children's people leave this group: it may have been how they ran a track.
          for (const u of await membersWithin(trx, ctx.ws, unnested)) ctx.leftGroups.add(u);
        }
        if (nested.length > 0) {
          await trx
            .insertInto('group_nesting')
            .values(nested.map((c) => ({ workspace_id: ctx.ws, parent_id: id, child_id: c })))
            .onConflict((oc) => oc.columns(['parent_id', 'child_id']).doNothing())
            .execute();
        }
        count(ctx, 'membershipsAdded', added.length);
        count(ctx, 'membershipsRemoved', removed.length);
        count(ctx, 'nestingsAdded', nested.length);
        count(ctx, 'nestingsRemoved', unnested.length);
        const entry = outcome.targets.get(id);
        if (outcome.created.has(id) && entry) {
          events.push({
            type: 'directory.group_created',
            subjectId: id,
            payload: {
              ...tag(ctx),
              name: entry.name,
              dn: entry.dn,
              members: cap(added),
              memberCount: added.length,
              children: cap(nested),
            },
          });
          continue;
        }
        const changes = outcome.changes.get(id) ?? {};
        if (
          Object.keys(changes).length > 0 ||
          added.length > 0 ||
          removed.length > 0 ||
          nested.length > 0 ||
          unnested.length > 0
        ) {
          count(ctx, 'groupsUpdated');
          events.push({
            type: 'directory.group_updated',
            subjectId: id,
            payload: {
              ...tag(ctx),
              changes,
              added: cap(added),
              removed: cap(removed),
              addedCount: added.length,
              removedCount: removed.length,
              nested: cap(nested),
              unnested: cap(unnested),
            },
          });
        }
      }
      for (let k = 0; k < addRows.length; k += 2000) {
        await trx
          .insertInto('group_member')
          .values(addRows.slice(k, k + 2000))
          .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
          .execute();
      }
      await emitMany(trx, by(ctx), events);
    });
    await checkpoint(ctx);
  }
}

// ---- A run ----

function checkSafety(ctx: Context, what: string, removed: number, known: number): void {
  if (ctx.run.confirm_removals) return;
  if (known >= SAFETY_MINIMUM && removed > known * SAFETY_SHARE) {
    throw new SafetyStop(what, removed, known);
  }
}

function readCursor(row: DirectoryRow): Cursor | null {
  const value = row.sync_cursor as Record<string, JsonValue> | null;
  if (
    !value ||
    (value.kind !== 'usn' && value.kind !== 'timestamp') ||
    typeof value.value !== 'string'
  ) {
    return null;
  }
  return {
    kind: value.kind,
    value: value.value,
    server: typeof value.server === 'string' ? value.server : null,
    skipped: Array.isArray(value.skipped)
      ? value.skipped.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/** The newest change mark seen, as a Date (modifyTimestamp directories). */
function newestMark(entries: { mark: string | null }[]): Date | null {
  let newest: Date | null = null;
  for (const e of entries) {
    const at = e.mark ? parseGeneralizedTime(e.mark) : null;
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

interface ReadResult {
  users: DirectoryUser[];
  groups: DirectoryGroup[];
  removedUsers: UserLink[];
  removedGroups: GroupLink[];
  userLinks: UserLink[];
  groupLinks: GroupLink[];
}

async function readFull(ctx: Context, client: DirectoryClient): Promise<ReadResult> {
  const s = ctx.settings;
  const users: DirectoryUser[] = [];
  await collect(
    ctx,
    client.search(s.userBaseDn, s.userFilter, userAttributes(s)),
    (e) => readUser(e, s),
    users,
  );
  await checkpoint(ctx);
  const groups: DirectoryGroup[] = [];
  await collect(
    ctx,
    client.search(s.groupBaseDn, s.groupFilter, groupAttributes(s), {
      ranged: [s.attributes.member],
    }),
    (e) => readGroup(e, s),
    groups,
  );
  await checkpoint(ctx);
  const userLinks = await loadUserLinks(ctx.db, ctx.directory.id);
  const groupLinks = await loadGroupLinks(ctx.db, ctx.directory.id);
  const userIds = new Set(users.map((u) => u.externalId));
  const groupIds = new Set(groups.map((g) => g.externalId));
  return {
    users,
    groups,
    userLinks,
    groupLinks,
    removedUsers: userLinks.filter((l) => l.removed_at === null && !userIds.has(l.external_id)),
    removedGroups: groupLinks.filter((l) => !groupIds.has(l.external_id)),
  };
}

async function readIncremental(
  ctx: Context,
  client: DirectoryClient,
  cursor: Cursor,
): Promise<ReadResult> {
  const s = ctx.settings;
  const since =
    cursor.kind === 'usn'
      ? `(${s.attributes.changeMark}>=${(BigInt(cursor.value) + 1n).toString()})`
      : `(${s.attributes.changeMark}>=${cursor.value})`;
  const users: DirectoryUser[] = [];
  await collect(
    ctx,
    client.search(s.userBaseDn, `(&${s.userFilter}${since})`, userAttributes(s)),
    (e) => readUser(e, s),
    users,
  );
  const groups: DirectoryGroup[] = [];
  await collect(
    ctx,
    client.search(s.groupBaseDn, `(&${s.groupFilter}${since})`, groupAttributes(s), {
      ranged: [s.attributes.member],
    }),
    (e) => readGroup(e, s),
    groups,
  );
  count(ctx, 'changedUsersRead', users.length);
  count(ctx, 'changedGroupsRead', groups.length);
  await checkpoint(ctx);
  // Every identifier in scope: what left (deleted, or out of the filter) and what entered.
  const userIds = await readIds(client, s.userBaseDn, s.userFilter);
  const groupIds = await readIds(client, s.groupBaseDn, s.groupFilter);
  await checkpoint(ctx);
  const userLinks = await loadUserLinks(ctx.db, ctx.directory.id);
  const groupLinks = await loadGroupLinks(ctx.db, ctx.directory.id);
  const skipped = new Set(cursor.skipped ?? []);
  const knownUsers = new Set(
    userLinks.filter((l) => l.removed_at === null).map((l) => l.external_id),
  );
  const changedUserIds = new Set(users.map((u) => u.externalId));
  const enteredUsers = [...userIds].filter(
    (id) => !knownUsers.has(id) && !skipped.has(id) && !changedUserIds.has(id),
  );
  users.push(
    ...(await readByIds(
      ctx,
      client,
      s.userBaseDn,
      s.userFilter,
      enteredUsers,
      userAttributes(s),
      (e) => readUser(e, s),
    )),
  );
  const knownGroups = new Set(groupLinks.map((l) => l.external_id));
  const changedGroupIds = new Set(groups.map((g) => g.externalId));
  const enteredGroups = [...groupIds].filter(
    (id) => !knownGroups.has(id) && !changedGroupIds.has(id),
  );
  groups.push(
    ...(await readByIds(
      ctx,
      client,
      s.groupBaseDn,
      s.groupFilter,
      enteredGroups,
      groupAttributes(s),
      (e) => readGroup(e, s),
      [s.attributes.member],
    )),
  );
  for (const id of skipped) if (userIds.has(id)) ctx.skipped.add(id);
  return {
    users,
    groups,
    userLinks,
    groupLinks,
    removedUsers: userLinks.filter((l) => l.removed_at === null && !userIds.has(l.external_id)),
    removedGroups: groupLinks.filter((l) => !groupIds.has(l.external_id)),
  };
}

/** Groups that list any of these DNs, re-read so new people and groups get their memberships. */
async function groupsListing(
  ctx: Context,
  client: DirectoryClient,
  dns: string[],
): Promise<DirectoryGroup[]> {
  const s = ctx.settings;
  const out: DirectoryGroup[] = [];
  for (let i = 0; i < dns.length; i += 50) {
    await collect(
      ctx,
      client.search(s.groupBaseDn, memberFilter(s, dns.slice(i, i + 50)), groupAttributes(s), {
        ranged: [s.attributes.member],
      }),
      (e) => readGroup(e, s),
      out,
    );
  }
  return out;
}

const CHANGE_STATS = [
  'usersCreated',
  'usersLinked',
  'usersUpdated',
  'usersDeactivated',
  'usersReactivated',
  'usersRemoved',
  'groupsCreated',
  'groupsUpdated',
  'groupsDeleted',
  'membershipsAdded',
  'membershipsRemoved',
  'nestingsAdded',
  'nestingsRemoved',
];

/**
 * Claims a queued run (a direct call, as tests make) or continues a claimed one, and runs it.
 * Never throws for the directory's sake: failures end the run as failed with the reason.
 */
export async function runSync(
  db: Db,
  runId: number,
  deps: SyncDeps = {},
): Promise<{
  status: 'succeeded' | 'failed';
  stats: SyncStats;
  warnings: SyncWarning[];
  error: string | null;
}> {
  await db
    .updateTable('ldap_sync_run')
    .set({ status: 'running', started_at: new Date(), heartbeat_at: new Date() })
    .where('id', '=', runId)
    .where('status', '=', 'queued')
    .execute();
  const run = (await db
    .selectFrom('ldap_sync_run')
    .select(['id', 'workspace_id', 'directory_id', 'mode', 'trigger', 'confirm_removals', 'status'])
    .where('id', '=', runId)
    .executeTakeFirst()) as RunRow | undefined;
  if (run?.status !== 'running') {
    return { status: 'failed', stats: {}, warnings: [], error: 'not_running' };
  }
  const directory = (await db
    .selectFrom('ldap_directory')
    .select([...DIRECTORY_COLUMNS])
    .where('id', '=', run.directory_id)
    .executeTakeFirst()) as DirectoryRow | undefined;
  const started = Date.now();
  const stats: SyncStats = {};
  const warnings: SyncWarning[] = [];
  let error: string | null = null;
  let mode = run.mode;
  let cursor: Cursor | null = null;
  let full = false;
  const beat = setInterval(() => void heartbeat(db, runId).catch(() => undefined), 30_000);
  beat.unref();
  let client: DirectoryClient | undefined;
  const leftGroups = new Set<number>();
  try {
    if (!directory) throw new Error('directory_deleted');
    if (!directory.enabled) throw new Error('directory_disabled');
    const settings = directorySettings(directory, deps.peppers);
    client = await DirectoryClient.connect(settings);
    const previous = readCursor(directory);
    const dse = settings.cursor === 'usn' ? await client.rootDse() : null;
    const fullDue =
      !directory.last_full_sync_at ||
      Date.now() - directory.last_full_sync_at.getTime() > directory.full_sync_hours * 3600_000;
    if (
      mode === 'incremental' &&
      (!previous ||
        previous.kind !== settings.cursor ||
        fullDue ||
        (previous.kind === 'usn' && (dse?.server ?? null) !== (previous.server ?? null)))
    ) {
      mode = 'full';
    }
    full = mode === 'full';
    const ctx: Context = {
      db,
      ws: directory.workspace_id,
      directory,
      settings,
      run,
      mode,
      stats,
      warnings,
      skipped: new Set(),
      now: new Date(),
      signal: deps.signal,
      leftGroups,
    };
    const readStart = Date.now();
    const read = full
      ? await readFull(ctx, client)
      : await readIncremental(ctx, client, previous as Cursor);
    stats.usersRead = read.users.length;
    stats.groupsRead = read.groups.length;
    stats.readMs = Date.now() - readStart;
    checkSafety(
      ctx,
      'people',
      read.removedUsers.length,
      read.userLinks.filter((l) => l.removed_at === null).length,
    );
    checkSafety(ctx, 'groups', read.removedGroups.length, read.groupLinks.length);

    const applyStart = Date.now();
    const added = await applyUsers(ctx, read.users, read.removedUsers, read.userLinks);
    stats.usersMs = Date.now() - applyStart;
    let groups = read.groups;
    if (!full) {
      // Groups that did not change may list people and groups that are new here.
      const known = new Set(groups.map((g) => g.externalId));
      const linked = new Set(read.groupLinks.map((l) => l.external_id));
      const newGroupDns = groups.filter((g) => !linked.has(g.externalId)).map((g) => g.dn);
      const listing = await groupsListing(ctx, client, [...added.map((u) => u.dn), ...newGroupDns]);
      groups = [...groups, ...listing.filter((g) => !known.has(g.externalId))];
    }
    const groupsStart = Date.now();
    const outcome = await applyGroups(ctx, groups, read.removedGroups, read.groupLinks);
    stats.groupsMs = Date.now() - groupsStart;
    const membershipsStart = Date.now();
    await applyMemberships(ctx, outcome);
    stats.membershipsMs = Date.now() - membershipsStart;
    stats.applyMs = Date.now() - applyStart;

    // The next incremental run starts here.
    if (settings.cursor === 'usn') {
      cursor = { kind: 'usn', value: dse?.highestCommittedUsn ?? '0', server: dse?.server ?? null };
    } else {
      // Changes committed once the read began carry a later modifyTimestamp than its start,
      // which is no earlier than the newest one seen, or this clock's time then, less the
      // overlap (the read's own length and ten minutes for clocks that disagree). The later
      // of the two re-reads least; the daily full run catches what a wrong clock would hide.
      const newest = newestMark([...read.users, ...read.groups]);
      const overlap = Math.max(TIMESTAMP_OVERLAP_MS, Date.now() - readStart + 60_000);
      const fromClock = readStart - overlap;
      const fromMarks = newest ? newest.getTime() - overlap : 0;
      const candidate = formatGeneralizedTime(new Date(Math.max(fromClock, fromMarks)));
      const kept = previous?.kind === 'timestamp' ? previous.value : null;
      cursor = { kind: 'timestamp', value: kept && kept > candidate ? kept : candidate };
    }
    cursor.skipped = [...ctx.skipped].slice(0, MAX_SKIPPED);
  } catch (failure) {
    error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 500);
    deps.log?.('directory sync failed', { directoryId: run.directory_id, runId, error });
  } finally {
    clearInterval(beat);
    await client?.close();
  }
  stats.durationMs = Date.now() - started;
  const status = error === null ? 'succeeded' : 'failed';
  const changed = CHANGE_STATS.some((name) => (stats[name] ?? 0) > 0);
  await db.transaction().execute(async (trx) => {
    // The grant to create tracks that came with a role goes with the last one (T-087b): checked
    // once every change of the run is in, so someone who moved to another group that runs a
    // track keeps it. A failed run's changes that went in count as well.
    const lapsed =
      directory && leftGroups.size > 0
        ? await dropLapsedCreateTracks(trx, directory.workspace_id, [...leftGroups])
        : [];
    await trx
      .updateTable('ldap_sync_run')
      .set({
        status,
        mode,
        finished_at: new Date(),
        heartbeat_at: new Date(),
        stats: JSON.stringify(stats),
        warnings: JSON.stringify(warnings),
        error,
      })
      .where('id', '=', runId)
      .execute();
    if (directory && status === 'succeeded' && cursor) {
      // An edit during the run that changed what is read cleared the cursor: it stays cleared,
      // so the next run is a full one with the new settings.
      const before = directory.sync_cursor === null ? null : JSON.stringify(directory.sync_cursor);
      await trx
        .updateTable('ldap_directory')
        .set({
          sync_cursor: JSON.stringify(cursor),
          ...(full ? { last_full_sync_at: new Date(started) } : {}),
        })
        .where('id', '=', directory.id)
        .where(sql<boolean>`sync_cursor IS NOT DISTINCT FROM ${before}::jsonb`)
        .execute();
    }
    if (directory && (changed || status === 'failed' || lapsed.length > 0)) {
      await emitMany(trx, { workspaceId: run.workspace_id, actorId: null, ip: null }, [
        {
          type: 'directory.synced',
          subjectId: directory.id,
          payload: {
            runId,
            mode,
            trigger: run.trigger,
            status,
            stats,
            warnings: stats.warnings ?? 0,
            error,
            ...lapsedPayload(lapsed),
          },
        },
      ]);
    }
  });
  return { status, stats, warnings, error };
}

/** Queues a run, or returns the one already waiting (upgraded to full when asked). */
export async function queueRun(
  trx: Trx | Db,
  options: {
    workspaceId: number;
    directoryId: number;
    mode: 'full' | 'incremental';
    trigger: 'schedule' | 'manual';
    requestedBy: number | null;
    confirmRemovals: boolean;
  },
): Promise<{ id: number; coalesced: boolean }> {
  const inserted = await trx
    .insertInto('ldap_sync_run')
    .values({
      workspace_id: options.workspaceId,
      directory_id: options.directoryId,
      mode: options.mode,
      trigger: options.trigger,
      requested_by: options.requestedBy,
      confirm_removals: options.confirmRemovals,
    })
    .onConflict((oc) => oc.column('directory_id').where('status', '=', 'queued').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, coalesced: false };
  const waiting = await trx
    .updateTable('ldap_sync_run')
    .set((eb) => ({
      ...(options.mode === 'full' ? { mode: 'full' as const } : {}),
      ...(options.confirmRemovals ? { confirm_removals: true } : {}),
      ...(options.trigger === 'manual'
        ? { trigger: 'manual' as const, requested_by: options.requestedBy }
        : {}),
      created_at: eb.ref('created_at'),
    }))
    .where('directory_id', '=', options.directoryId)
    .where('status', '=', 'queued')
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: waiting.id, coalesced: true };
}
