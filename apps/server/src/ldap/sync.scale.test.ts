import { useMigratedDatabase } from '@taskmoor/db/testing';
import { sealSecret } from '@taskmoor/iam';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveGroupIds } from '../directory';
import { FakeLdap } from '../testing/fake-ldap';
import { PRESETS } from './settings';
import { queueRun, runSync } from './sync';

/**
 * M1-082's done-when at the in-process directory: 10,000 people in 2,460 groups nested four
 * levels deep, synced in full in under two minutes, then incremental runs in under two
 * minutes (IAM-005 (1) asks that of 100,000 people; the OpenLDAP container run in
 * `tools/ldap/openldap-test.sh` measures a real server). The numbers go to the test log as a
 * warning line (the only console output the lint rules allow).
 */
const PEOPLE = Number(process.env.TASKMOOR_LDAP_SCALE_PEOPLE ?? 10_000);
const TWO_MINUTES = 120_000;

describe('directory sync at scale (M1-082)', () => {
  const database = useMigratedDatabase();
  const ldap = new FakeLdap({ flavour: 'openldap', baseDn: 'dc=scale,dc=test' });
  const people: string[] = [];
  const levels: string[][] = [[], [], [], []];
  let directoryId = 0;

  beforeAll(async () => {
    await ldap.start();
    // The directory was loaded two hours ago; the changes below happen now, so an incremental
    // run reads them and not everything (modifyTimestamp cursors overlap by ten minutes).
    ldap.clock = () => new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (let i = 0; i < PEOPLE; i++) {
      people.push(
        ldap.addUser({ username: `p${i}`, mail: `p${i}@scale.test`, displayName: `Person ${i}` }),
      );
    }
    // Four levels: 10 divisions, 50 departments, 400 groups, 2,000 teams of five people; every
    // tenth person also belongs to a level-three group directly.
    const teams = Math.ceil(PEOPLE / 5);
    for (let t = 0; t < teams; t++) {
      levels[3]?.push(ldap.addGroup({ cn: `team-${t}`, members: people.slice(t * 5, t * 5 + 5) }));
    }
    const l3 = Math.ceil(teams / 5);
    for (let g = 0; g < l3; g++) {
      const direct = people.filter((_, i) => i % 10 === 0 && Math.floor(i / 25) % l3 === g);
      levels[2]?.push(
        ldap.addGroup({
          cn: `group-${g}`,
          members: [...(levels[3]?.slice(g * 5, g * 5 + 5) ?? []), ...direct],
        }),
      );
    }
    const l2 = Math.ceil(l3 / 8);
    for (let d = 0; d < l2; d++) {
      levels[1]?.push(
        ldap.addGroup({ cn: `department-${d}`, members: levels[2]?.slice(d * 8, d * 8 + 8) ?? [] }),
      );
    }
    const l1 = Math.ceil(l2 / 5);
    for (let v = 0; v < l1; v++) {
      levels[0]?.push(
        ldap.addGroup({ cn: `division-${v}`, members: levels[1]?.slice(v * 5, v * 5 + 5) ?? [] }),
      );
    }
    const row = await database.db
      .insertInto('ldap_directory')
      .values({
        workspace_id: 1,
        name: 'Scale',
        kind: 'openldap',
        url: ldap.url,
        bind_dn: ldap.bindDn,
        bind_password_sealed: sealSecret(ldap.bindPassword, undefined),
        base_dn: ldap.baseDn,
        user_filter: PRESETS.openldap.userFilter,
        group_filter: PRESETS.openldap.groupFilter,
        attribute_map: '{}',
        position: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    directoryId = row.id;
  }, 120_000);
  afterAll(async () => {
    await ldap.stop();
  });

  const sync = async (mode: 'full' | 'incremental') => {
    const queued = await queueRun(database.db, {
      workspaceId: 1,
      directoryId,
      mode,
      trigger: 'schedule',
      requestedBy: null,
      confirmRemovals: false,
    });
    const started = performance.now();
    const result = await runSync(database.db, queued.id);
    const ms = Math.round(performance.now() - started);
    expect(result.status, result.error ?? '').toBe('succeeded');
    return { ...result, ms };
  };

  it(
    '[IAM-005] syncs 10,000 people with four-level nesting in under two minutes, then incrementally',
    async () => {
      const groups = levels.flat().length;
      const full = await sync('full');
      expect(full.stats).toMatchObject({ usersCreated: PEOPLE, groupsCreated: groups });
      expect(full.ms).toBeLessThan(TWO_MINUTES);

      // Person 0 is in team 0, group 0, department 0 and division 0: four levels.
      const first = await database.db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'p0@scale.test')
        .executeTakeFirstOrThrow();
      const effective = await effectiveGroupIds(database.db, 1, first.id);
      const named = await database.db
        .selectFrom('user_group')
        .select('name')
        .where('id', 'in', effective)
        .orderBy('name')
        .execute();
      expect(named.map((g) => g.name)).toEqual(['department-0', 'division-0', 'group-0', 'team-0']);
      const memberships = await sql<{ n: string }>`SELECT count(*) AS n FROM group_member`.execute(
        database.db,
      );

      // Nothing changed: an incremental run still reads every identifier to see deletions.
      const idle = await sync('incremental');
      expect(idle.ms).toBeLessThan(TWO_MINUTES);

      // A hundred people change, ten are disabled, five leave, and ten teams change members.
      ldap.clock = () => new Date();
      for (let i = 0; i < 100; i++)
        ldap.modify(people[i * 7] as string, { displayName: [`Renamed ${i}`] });
      for (let i = 0; i < 10; i++) ldap.setDisabled(people[1000 + i] as string, true);
      for (let i = 0; i < 5; i++) ldap.remove(people[2000 + i] as string);
      for (let t = 0; t < 10; t++)
        ldap.addMember(levels[3]?.[t] as string, people[5000 + t] as string);
      const busy = await sync('incremental');
      expect(busy.ms).toBeLessThan(TWO_MINUTES);
      expect(busy.stats).toMatchObject({ usersRemoved: 5, usersDeactivated: 15 });
      expect(busy.stats.usersUpdated).toBeGreaterThanOrEqual(100);
      // Only what changed was read in full; deletions came from the identifiers alone.
      expect(busy.stats.changedUsersRead).toBeLessThanOrEqual(110);
      expect(busy.stats.changedGroupsRead).toBe(10);
      expect(idle.stats.changedUsersRead ?? 0).toBe(0);

      console.warn(
        JSON.stringify({
          ldapScale: {
            people: PEOPLE,
            groups,
            memberships: Number(memberships.rows[0]?.n ?? 0),
            fullMs: full.ms,
            fullReadMs: full.stats.readMs,
            fullApplyMs: full.stats.applyMs,
            fullUsersMs: full.stats.usersMs,
            fullGroupsMs: full.stats.groupsMs,
            fullMembershipsMs: full.stats.membershipsMs,
            idleIncrementalMs: idle.ms,
            busyIncrementalMs: busy.ms,
            busyChangedRead:
              (busy.stats.changedUsersRead ?? 0) + (busy.stats.changedGroupsRead ?? 0),
          },
        }),
      );
    },
    6 * TWO_MINUTES,
  );
});
