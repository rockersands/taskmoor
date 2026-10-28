import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { sealSecret } from '@taskmoor/iam';
import { sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { effectiveGroupIds } from '../directory';
import { FakeLdap, type FakeLdapOptions } from '../testing/fake-ldap';
import { acyclic } from './nesting';
import { claimRun, failStaleRuns, scheduleDirectories } from './scheduler';
import { PRESETS } from './settings';
import { queueRun, runSync } from './sync';

/**
 * Directory sync (M1-082; IAM-005) against the in-process LDAP server in both of its
 * flavours. Passwords are made per run; none is part of the repository.
 */
const secret = () => `pw-${randomBytes(12).toString('base64url')}`;

describe('directory sync (M1-082)', () => {
  const database = useMigratedDatabase();
  let db: typeof database.db;
  beforeAll(() => {
    db = database.db;
  });
  const servers: FakeLdap[] = [];
  let names = 0;

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  async function server(options: Partial<FakeLdapOptions> & Pick<FakeLdapOptions, 'flavour'>) {
    const fake = await new FakeLdap(options).start();
    servers.push(fake);
    return fake;
  }

  async function directory(
    fake: FakeLdap,
    overrides: Partial<{ name: string; position: number; user_filter: string }> = {},
  ) {
    const kind = fake.flavour;
    names += 1;
    const row = await db
      .insertInto('ldap_directory')
      .values({
        workspace_id: 1,
        name: overrides.name ?? `Directory ${names}`,
        kind,
        url: fake.url,
        bind_dn: fake.bindDn,
        bind_password_sealed: sealSecret(fake.bindPassword, undefined),
        base_dn: fake.baseDn,
        user_filter: overrides.user_filter ?? PRESETS[kind].userFilter,
        group_filter: PRESETS[kind].groupFilter,
        attribute_map: '{}',
        position: overrides.position ?? names,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function sync(
    directoryId: number,
    mode: 'full' | 'incremental' = 'incremental',
    confirmRemovals = false,
  ) {
    const run = await queueRun(db, {
      workspaceId: 1,
      directoryId,
      mode,
      trigger: 'manual',
      requestedBy: null,
      confirmRemovals,
    });
    const result = await runSync(db, run.id);
    const row = await db
      .selectFrom('ldap_sync_run')
      .select(['mode', 'status'])
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    return { ...result, runId: run.id, mode: row.mode };
  }

  async function account(email: string) {
    return db
      .selectFrom('app_user as a')
      .leftJoin('ldap_user as l', 'l.user_id', 'a.id')
      .select([
        'a.id',
        'a.name',
        'a.email',
        'a.password_hash',
        'a.deactivated_at',
        'l.directory_id',
        'l.dn',
        'l.removed_at',
      ])
      .where(sql<string>`lower(a.email)`, '=', email)
      .executeTakeFirst();
  }

  async function groupId(name: string) {
    const row = await db
      .selectFrom('user_group')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    return row?.id;
  }

  async function members(name: string) {
    const id = await groupId(name);
    const rows = await db
      .selectFrom('group_member as m')
      .innerJoin('app_user as a', 'a.id', 'm.user_id')
      .select('a.email')
      .where('m.group_id', '=', id ?? 0)
      .orderBy('a.email')
      .execute();
    return rows.map((r) => r.email);
  }

  async function children(name: string) {
    const id = await groupId(name);
    const rows = await db
      .selectFrom('group_nesting as n')
      .innerJoin('user_group as g', 'g.id', 'n.child_id')
      .select('g.name')
      .where('n.parent_id', '=', id ?? 0)
      .orderBy('g.name')
      .execute();
    return rows.map((r) => r.name);
  }

  async function events(runId: number) {
    const rows = await db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'actor_id', 'subject_id'])
      .where(sql<string>`payload->>'runId'`, '=', String(runId))
      .orderBy('id')
      .execute();
    return rows;
  }

  describe.each(['openldap', 'active_directory'] as const)('%s', (flavour) => {
    it('[IAM-005] a full sync creates accounts and groups nested four levels deep', async () => {
      const fake = await server({ flavour });
      const ann = fake.addUser({
        username: `ann-${flavour}`,
        displayName: 'Ann Lee',
        password: secret(),
      });
      const bob = fake.addUser({ username: `bob-${flavour}`, displayName: 'Bob Roe' });
      const l4 = fake.addGroup({ cn: `${flavour}-level4`, members: [ann] });
      const l3 = fake.addGroup({ cn: `${flavour}-level3`, members: [l4, bob] });
      const l2 = fake.addGroup({ cn: `${flavour}-level2`, members: [l3] });
      fake.addGroup({ cn: `${flavour}-level1`, members: [l2] });
      const id = await directory(fake);

      const run = await sync(id);
      expect(run.status, run.error ?? '').toBe('succeeded');
      // The first run is a full one, whatever was asked: there is no cursor yet.
      expect(run.mode).toBe('full');
      expect(run.stats).toMatchObject({ usersCreated: 2, groupsCreated: 4, nestingsAdded: 3 });

      const a = await account(`ann-${flavour}@example.com`);
      expect(a).toMatchObject({ name: 'Ann Lee', password_hash: null, deactivated_at: null });
      expect(a?.directory_id).toBe(id);
      expect(await children(`${flavour}-level1`)).toEqual([`${flavour}-level2`]);
      expect(await members(`${flavour}-level3`)).toEqual([`bob-${flavour}@example.com`]);
      // Ann is in level 4 directly and in every level above it through nesting.
      const effective = await effectiveGroupIds(db, 1, a?.id as number);
      for (const level of [1, 2, 3, 4]) {
        expect(effective).toContain(await groupId(`${flavour}-level${level}`));
      }

      const emitted = await events(run.runId);
      expect(emitted.every((e) => e.actor_id === null)).toBe(true);
      expect(emitted.filter((e) => e.type === 'directory.user_created')).toHaveLength(2);
      expect(emitted.filter((e) => e.type === 'directory.group_created')).toHaveLength(4);
      const synced = await db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'directory.synced')
        .where('subject_id', '=', String(id))
        .executeTakeFirstOrThrow();
      expect(synced.payload).toMatchObject({
        status: 'succeeded',
        mode: 'full',
        trigger: 'manual',
      });

      // Nothing changed: an incremental run writes nothing and reports nothing.
      const again = await sync(id);
      expect(again.mode).toBe('incremental');
      expect(again.status).toBe('succeeded');
      expect(await events(again.runId)).toEqual([]);
    });

    it('[IAM-005] an incremental sync takes changes, renames, new people and new members', async () => {
      const fake = await server({ flavour });
      const cy = fake.addUser({ username: `cy-${flavour}`, displayName: 'Cy Old' });
      const dee = fake.addUser({ username: `dee-${flavour}` });
      const team = fake.addGroup({ cn: `${flavour}-team`, members: [cy] });
      const id = await directory(fake);
      expect((await sync(id)).status).toBe('succeeded');

      // OpenLDAP's modifyTimestamp has one-second steps; the cursor overlaps, so this is seen.
      fake.modify(cy, { displayName: ['Cy New'] });
      const renamedDee = fake.rename(
        dee,
        flavour === 'active_directory' ? 'CN=Dee Two' : `uid=dee-${flavour}-2`,
      );
      const eve = fake.addUser({ username: `eve-${flavour}` });
      fake.addMember(team, eve);
      const before = fake.stats.searches;
      const run = await sync(id);
      expect(run.status, run.error ?? '').toBe('succeeded');
      expect(run.mode).toBe('incremental');
      expect(run.stats).toMatchObject({ usersCreated: 1 });
      expect(run.stats.changedUsersRead).toBeLessThanOrEqual(3);
      expect(fake.stats.searches - before).toBeLessThan(12);

      expect((await account(`cy-${flavour}@example.com`))?.name).toBe('Cy New');
      expect((await account(`dee-${flavour}@example.com`))?.dn).toBe(renamedDee);
      expect(await members(`${flavour}-team`)).toEqual([
        `cy-${flavour}@example.com`,
        `eve-${flavour}@example.com`,
      ]);
      const updates = (await events(run.runId)).filter((e) => e.type === 'directory.user_updated');
      expect(
        updates.flatMap((e) => Object.keys((e.payload as { changes: object }).changes)),
      ).toEqual(expect.arrayContaining(['name', 'dn']));
    });

    it('[IAM-005] a person disabled in the directory is deactivated at the next sync, and comes back', async () => {
      const fake = await server({ flavour });
      const fay = fake.addUser({ username: `fay-${flavour}` });
      const gil = fake.addUser({ username: `gil-${flavour}` });
      const id = await directory(fake);
      await sync(id);
      const before = await account(`fay-${flavour}@example.com`);
      await db
        .insertInto('user_session')
        .values({
          workspace_id: 1,
          user_id: before?.id as number,
          token_hash: `session-${flavour}`,
          expires_at: new Date(Date.now() + 3600_000),
        })
        .execute();

      fake.setDisabled(fay, true);
      const run = await sync(id);
      expect(run.mode).toBe('incremental');
      const after = await account(`fay-${flavour}@example.com`);
      expect(after?.deactivated_at).not.toBeNull();
      const sessions = await db
        .selectFrom('user_session')
        .select('id')
        .where('user_id', '=', after?.id as number)
        .execute();
      expect(sessions).toEqual([]);
      const update = (await events(run.runId)).find((e) => e.type === 'directory.user_updated');
      expect(update?.payload).toMatchObject({
        changes: { active: { from: true, to: false } },
        endedSessions: 1,
      });

      fake.setDisabled(fay, false);
      await sync(id);
      expect((await account(`fay-${flavour}@example.com`))?.deactivated_at).toBeNull();

      // An administrator's deactivation is the administrator's: the sync does not undo it.
      const g = await account(`gil-${flavour}@example.com`);
      await db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', g?.id as number)
        .execute();
      fake.modify(gil, { displayName: ['Gil Changed'] });
      await sync(id);
      const gAfter = await account(`gil-${flavour}@example.com`);
      expect(gAfter?.name).toBe('Gil Changed');
      expect(gAfter?.deactivated_at).not.toBeNull();
    });

    it('[IAM-005] entries deleted from the directory deactivate their accounts and leave their groups', async () => {
      const fake = await server({ flavour });
      const hal = fake.addUser({ username: `hal-${flavour}` });
      const ida = fake.addUser({ username: `ida-${flavour}` });
      fake.addGroup({ cn: `${flavour}-crew`, members: [hal, ida] });
      const id = await directory(fake);
      await sync(id);
      // Deleting removes the member link without touching the group's change mark.
      fake.remove(hal);
      const run = await sync(id);
      expect(run.mode).toBe('incremental');
      expect(run.stats.usersRemoved).toBe(1);
      const h = await account(`hal-${flavour}@example.com`);
      expect(h?.deactivated_at).not.toBeNull();
      expect(h?.removed_at).not.toBeNull();
      expect(await members(`${flavour}-crew`)).toEqual([`ida-${flavour}@example.com`]);
      const removed = (await events(run.runId)).find((e) => e.type === 'directory.user_removed');
      expect(removed?.payload).toMatchObject({ deactivated: true, username: `hal-${flavour}` });

      // The same person created again (a new identifier) takes the account back.
      fake.addUser({ username: `hal-${flavour}` });
      await sync(id);
      const back = await account(`hal-${flavour}@example.com`);
      expect(back?.id).toBe(h?.id);
      expect(back?.deactivated_at).toBeNull();
      expect(back?.removed_at).toBeNull();
    });
  });

  it('[IAM-005] never deactivates break-glass accounts or the last active site administrator', async () => {
    const fake = await server({ flavour: 'active_directory' });
    const hash = 'pepper:test:not-a-real-hash';
    for (const [email, admin, breakGlass] of [
      ['root@example.com', true, false],
      ['rescue@example.com', false, true],
      ['local@example.com', false, false],
    ] as const) {
      await db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email,
          name: email,
          password_hash: hash,
          is_site_admin: admin,
          break_glass: breakGlass,
        })
        .execute();
    }
    const root = fake.addUser({ username: 'root', mail: 'root@example.com' });
    fake.addUser({ username: 'rescue', mail: 'rescue@example.com' });
    fake.addUser({ username: 'local', mail: 'local@example.com' });
    const id = await directory(fake);
    const run = await sync(id);
    expect(run.warnings.map((w) => w.code)).toContain('break_glass_account');
    // Existing accounts are linked by address; the directory checks their password now.
    expect(await account('local@example.com')).toMatchObject({
      directory_id: id,
      password_hash: null,
    });
    expect(await account('rescue@example.com')).toMatchObject({
      directory_id: null,
      password_hash: hash,
    });
    expect((await account('root@example.com'))?.directory_id).toBe(id);

    fake.setDisabled(root, true);
    const second = await sync(id);
    expect(second.warnings.map((w) => w.code)).toContain('kept_last_admin');
    expect((await account('root@example.com'))?.deactivated_at).toBeNull();
    fake.remove(root);
    await sync(id);
    expect((await account('root@example.com'))?.deactivated_at).toBeNull();
  });

  it('[IAM-005] the first directory in precedence manages an address two directories hold', async () => {
    const first = await server({ flavour: 'openldap' });
    const second = await server({ flavour: 'active_directory' });
    first.addUser({ username: 'shared', mail: 'shared@example.com', displayName: 'From first' });
    second.addUser({ username: 'shared', mail: 'shared@example.com', displayName: 'From second' });
    const a = await directory(first, { position: 1 });
    const b = await directory(second, { position: 2 });
    await sync(b);
    expect((await account('shared@example.com'))?.directory_id).toBe(b);
    const taken = await sync(a);
    expect((await account('shared@example.com'))?.directory_id).toBe(a);
    const created = (await events(taken.runId)).find((e) => e.type === 'directory.user_created');
    expect(created?.payload).toMatchObject({ linked: true, takenFromDirectoryId: b });
    const kept = await sync(b, 'full');
    expect(kept.warnings.map((w) => w.code)).toContain('managed_by_other_directory');
    expect(await account('shared@example.com')).toMatchObject({
      directory_id: a,
      name: 'From first',
    });
  });

  it('[IAM-005] breaks nesting loops the same way whatever order the directory lists them in', async () => {
    const results: string[][] = [];
    for (const order of [
      ['x', 'y', 'z'],
      ['z', 'y', 'x'],
    ]) {
      const fake = await server({
        flavour: 'openldap',
        baseDn: `dc=loop${results.length},dc=test`,
      });
      const dn = (cn: string) => `cn=loop${results.length}-${cn},ou=groups,${fake.baseDn}`;
      const memberOf: Record<string, string> = { x: dn('y'), y: dn('z'), z: dn('x') };
      for (const cn of order) {
        fake.addGroup({ cn: `loop${results.length}-${cn}`, members: [memberOf[cn] as string] });
      }
      const id = await directory(fake);
      const run = await sync(id);
      expect(run.stats.cyclesBroken).toBe(1);
      expect(run.warnings.map((w) => w.code)).toContain('nesting_cycle');
      const edges = await db
        .selectFrom('group_nesting as n')
        .innerJoin('ldap_group as p', 'p.group_id', 'n.parent_id')
        .innerJoin('ldap_group as c', 'c.group_id', 'n.child_id')
        .select(['n.parent_id', 'n.child_id', 'p.dn as parent', 'c.dn as child'])
        .where('p.directory_id', '=', id)
        .execute();
      expect(acyclic(edges.map((e) => [e.parent_id, e.child_id] as const))).toBe(true);
      results.push(
        edges
          .map((e) => `${e.parent.split(',')[0]?.slice(-1)}>${e.child.split(',')[0]?.slice(-1)}`)
          .sort(),
      );
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(['x>y', 'y>z']);
  });

  it('[IAM-005] reads member lists longer than Active Directory returns at once', async () => {
    const fake = await server({ flavour: 'active_directory', maxValueRange: 5, maxPageSize: 7 });
    const people = Array.from({ length: 23 }, (_, i) => fake.addUser({ username: `ranged${i}` }));
    fake.addGroup({ cn: 'Ranged', members: people });
    const id = await directory(fake);
    const run = await sync(id);
    expect(run.status, run.error ?? '').toBe('succeeded');
    expect(await members('Ranged')).toHaveLength(23);
    expect(fake.stats.rangeRequests).toBeGreaterThanOrEqual(4);
    expect(fake.stats.pagesServed).toBeGreaterThan(0);
  });

  it('[IAM-005] stops a run that would remove more than half of the people, unless confirmed', async () => {
    const fake = await server({ flavour: 'openldap' });
    const people = Array.from({ length: 12 }, (_, i) =>
      fake.addUser({ username: `safe${i}`, mail: `safe${i}@example.com` }),
    );
    const id = await directory(fake);
    await sync(id);
    for (const dn of people.slice(0, 8)) fake.remove(dn);
    const stopped = await sync(id, 'full');
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toMatch(/^safety_stop/);
    expect((await account('safe0@example.com'))?.deactivated_at).toBeNull();
    const confirmed = await sync(id, 'full', true);
    expect(confirmed.status).toBe('succeeded');
    expect(confirmed.stats.usersRemoved).toBe(8);
    expect((await account('safe0@example.com'))?.deactivated_at).not.toBeNull();
  });

  it('[IAM-005] runs a full sync when another domain controller answers, since USNs are per controller', async () => {
    const fake = await server({ flavour: 'active_directory' });
    fake.addUser({ username: 'usn' });
    const id = await directory(fake);
    await sync(id);
    expect((await sync(id)).mode).toBe('incremental');
    fake.switchDomainController();
    expect((await sync(id)).mode).toBe('full');
    expect((await sync(id)).mode).toBe('incremental');
  });

  it('[IAM-005] gives a directory group a free name and deletes groups that left the directory', async () => {
    const fake = await server({ flavour: 'openldap' });
    await db.insertInto('user_group').values({ workspace_id: 1, name: 'Engineering' }).execute();
    const eng = fake.addGroup({ cn: 'Engineering' });
    const brief = fake.addGroup({ cn: 'Short lived' });
    const id = await directory(fake, { name: 'Corp' });
    await sync(id);
    expect(await groupId('Engineering (Corp)')).toBeDefined();
    expect(await groupId('Short lived')).toBeDefined();
    fake.remove(brief);
    const run = await sync(id);
    expect(run.stats.groupsDeleted).toBe(1);
    expect(await groupId('Short lived')).toBeUndefined();
    // Renaming in the directory keeps the group (and its grants) and changes its name.
    const renamed = fake.rename(eng, 'cn=Platform');
    fake.modify(renamed, { cn: ['Platform'] });
    await sync(id);
    expect(await groupId('Platform')).toBeDefined();
    expect(await groupId('Engineering (Corp)')).toBeUndefined();
  });

  it('[IAM-005] fails a run without changes when the directory cannot be reached', async () => {
    const fake = await server({ flavour: 'openldap' });
    fake.addUser({ username: 'kim' });
    const id = await directory(fake);
    await sync(id);
    fake.down = true;
    const run = await sync(id);
    expect(run.status).toBe('failed');
    expect(run.error).toBeTruthy();
    expect(run.error).not.toContain(fake.bindPassword);
    const failed = await db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'directory.synced')
      .where('subject_id', '=', String(id))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(failed.payload).toMatchObject({ status: 'failed' });
    expect((await account('kim@example.com'))?.deactivated_at).toBeNull();
  });

  it('[IAM-005] schedules due directories, runs one sync per directory at a time and ends stale runs', async () => {
    const fake = await server({ flavour: 'openldap' });
    const id = await directory(fake);
    await db.updateTable('ldap_directory').set({ next_sync_at: null }).execute();
    await db.updateTable('ldap_directory').set({ enabled: false }).where('id', '!=', id).execute();
    expect(await scheduleDirectories(db)).toBe(1);
    // Not due again until its interval has passed.
    expect(await scheduleDirectories(db)).toBe(0);
    const next = await db
      .selectFrom('ldap_directory')
      .select('next_sync_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect((next.next_sync_at?.getTime() ?? 0) - Date.now()).toBeGreaterThan(55 * 60_000);
    const first = await claimRun(db, 'worker-a');
    expect(first).not.toBeNull();
    // A second request while one runs waits; it cannot start beside the running one.
    await queueRun(db, {
      workspaceId: 1,
      directoryId: id,
      mode: 'full',
      trigger: 'manual',
      requestedBy: null,
      confirmRemovals: false,
    });
    expect(await claimRun(db, 'worker-b')).toBeNull();
    await db
      .updateTable('ldap_sync_run')
      .set({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
      .where('id', '=', first as number)
      .execute();
    expect(await failStaleRuns(db)).toBe(1);
    expect(await claimRun(db, 'worker-b')).not.toBeNull();
  });
});
