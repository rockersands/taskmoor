import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit/golden';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { customValues, fieldWorldOf } from './dc-backup/fields';
import { customFieldKey } from './dc-backup/format';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { type Grantee, roleActors, schemeWorldOf, securityOf } from './dc-backup/schemes';
import {
  buildWorld,
  type IssueFacts,
  type Person,
  type Project,
  type World,
  walkIssues,
} from './dc-backup/world';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/** Six projects (every permission scheme, both security schemes, none) and six groups. */
const OPTIONS = defaultOptions(3_000, 92, { projects: 6, groups: 6 });
/** Tickets with their levels; their content is M1-091's test (`dc-content.test.ts`). */
const SOURCE = { format: 'dc-backup', path: 'dc-access.zip', scope: 'tickets' } as const;

function sessionCookie(header: string | string[] | undefined): string {
  return (
    (
      [header ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
      ''
    ).split(';')[0] ?? ''
  );
}

/**
 * The Data Center backup import of access, visibility and notification configuration (M1-092;
 * IMP-004, IMP-005, IMP-010; IAM-009 to IAM-011, NTF-001): permission schemes become access
 * policies (identical ones merged), issue security schemes visibility policies with levels,
 * notification schemes notification policies, global permissions global grants, and each issue
 * keeps its security level. The parity test: every fixture person, and an anonymous visitor,
 * sees exactly the tickets the fixture's permission and security model lets them see.
 */
describe('Data Center backup import: access, visibility and notifications (M1-092)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let manifest: Manifest;
  let world: World;
  let cookie = '';
  let report: FidelityReport;

  const as = (options: InjectOptions, session = cookie) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: session },
    });
  const entity = (kind: string) => report.entities.find((e) => e.kind === kind);
  const signIn = async (email: string) =>
    sessionCookie(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email, password: PASSWORD },
          remoteAddress: nextAddress(),
        })
      ).headers['set-cookie'],
    );

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-access-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(importDir, SOURCE.path)));
    world = buildWorld(OPTIONS);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-access-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 100 });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    cookie = await signIn('admin@example.com');
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Access', dryRun: false, source: SOURCE },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().importRun as { id: number };
    for (let i = 0; i < 1000; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    report = fidelityReport.parse(
      (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}/report` })).json().report,
    );
  }, 600_000);
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  /** Names for ids, so the goldens read without the target's ids. */
  async function names() {
    const db = database.db;
    const of = async (table: 'role' | 'user_group' | 'field' | 'track') =>
      new Map(
        (
          await db
            .selectFrom(table)
            .select(['id', table === 'track' ? 'key' : 'name'])
            .execute()
        ).map((r) => [
          r.id,
          String((r as { key?: string; name?: string }).key ?? (r as { name: string }).name),
        ]),
      );
    const users = new Map(
      (await db.selectFrom('app_user').select(['id', 'email']).execute()).map((u) => [
        u.id,
        u.email,
      ]),
    );
    const [roles, groups, fields, tracks] = await Promise.all([
      of('role'),
      of('user_group'),
      of('field'),
      of('track'),
    ]);
    const who = (r: {
      role_id: number | null;
      group_id: number | null;
      user_id: number | null;
      field_key: string | null;
    }) =>
      r.role_id !== null
        ? `role:${roles.get(r.role_id)}`
        : r.group_id !== null
          ? `group:${groups.get(r.group_id)}`
          : r.user_id !== null
            ? `user:${users.get(r.user_id)}`
            : r.field_key !== null
              ? `field:${fields.get(Number(/\d+/.exec(r.field_key)?.[0]))}`
              : '';
    return { who, tracks };
  }

  it('[IMP-004] [IMP-005] [IAM-009] maps permission schemes to access policies, merging identical ones', async () => {
    const sw = schemeWorldOf(world);
    expect(entity('access_policy')?.source).toBe(manifest.entities.PermissionScheme);
    expect(entity('access_policy')?.outcomes).toMatchObject({ created: 3, skipped: 1, failed: 0 });
    expect(report.failures).toEqual([]);
    // The copy is merged into the scheme it repeats, and the report names both (IMP-005 (1)).
    const copy = report.mapping.find(
      (m) => m.kind === 'access_policy' && m.label === 'Open permissions (copy)',
    );
    expect(copy).toMatchObject({
      outcome: 'skipped',
      reason: 'merged_identical',
      warnings: ['merged_into: Open permissions'],
    });
    const db = database.db;
    const { who, tracks } = await names();
    const policies = await db
      .selectFrom('access_policy')
      .selectAll()
      .where('is_default', '=', false)
      .execute();
    const trackRows = await db
      .selectFrom('track')
      .select(['key', 'access_policy_id', 'visibility_policy_id', 'notification_policy_id'])
      .execute();
    // Every track uses its project's scheme, a copy's tracks the scheme it repeats.
    for (const p of world.projects) {
      const scheme = sw.permissionSchemes.find((s) => s.id === sw.permissionSchemeOf.get(p.id));
      const name = scheme?.name.replace(' (copy)', '');
      const track = trackRows.find((t) => t.key === p.key);
      expect(policies.find((x) => x.id === track?.access_policy_id)?.name, p.key).toBe(name);
    }
    const grants = await db.selectFrom('access_grant').selectAll().execute();
    await expect(
      stableJson(
        policies
          .map((p) => ({
            name: p.name,
            tracks: trackRows
              .filter((t) => t.access_policy_id === p.id)
              .map((t) => t.key)
              .sort(),
            grants: grants
              .filter((g) => g.policy_id === p.id)
              .map((g) => `${g.permission} ${g.grantee} ${who(g)}`.trim())
              .sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    ).toMatchFileSnapshot('./__golden__/dc-access-seed92.policies.json');
    expect(tracks.size).toBeGreaterThan(0);
    // The plugin's permission is named in the report, not dropped silently.
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        code: 'permission_not_mapped',
        detail: 'com.example.reviews:APPROVE',
      }),
    );
  });

  it('[IMP-004] [IAM-011] [NTF-001] maps security schemes, notification schemes and global permissions', async () => {
    const db = database.db;
    const sw = schemeWorldOf(world);
    const { who } = await names();
    const policies = await db.selectFrom('visibility_policy').selectAll().execute();
    const levels = await db.selectFrom('visibility_level').selectAll().execute();
    const members = await db.selectFrom('visibility_member').selectAll().execute();
    const trackRows = await db
      .selectFrom('track')
      .select(['key', 'visibility_policy_id', 'notification_policy_id'])
      .execute();
    const notifications = await db
      .selectFrom('notification_policy')
      .selectAll()
      .where('is_default', '=', false)
      .execute();
    const rules = await db.selectFrom('notification_rule').selectAll().execute();
    const globals = await db
      .selectFrom('global_grant as g')
      .leftJoin('user_group as u', 'u.id', 'g.group_id')
      .select(['g.permission', 'g.grantee', 'u.name'])
      .execute();
    for (const p of world.projects) {
      const track = trackRows.find((t) => t.key === p.key);
      const scheme = sw.securitySchemes.find((s) => s.id === sw.securitySchemeOf.get(p.id));
      expect(policies.find((x) => x.id === track?.visibility_policy_id)?.name ?? null, p.key).toBe(
        scheme?.name ?? null,
      );
    }
    // Tickets keep their level; sub-tasks have their parent's (as the backup has them).
    const withLevel = await db
      .selectFrom('ticket')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('visibility_level_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(Number(withLevel.n)).toBe(manifest.cases.issuesWithSecurity);
    await expect(
      stableJson({
        visibility: policies
          .map((p) => ({
            name: p.name,
            default: levels.find((l) => l.id === p.default_level_id)?.name ?? null,
            tracks: trackRows
              .filter((t) => t.visibility_policy_id === p.id)
              .map((t) => t.key)
              .sort(),
            levels: levels
              .filter((l) => l.policy_id === p.id)
              .sort((a, b) => a.position - b.position)
              .map((l) => ({
                name: l.name,
                members: members
                  .filter((m) => m.level_id === l.id)
                  .map((m) => `${m.grantee} ${who(m)}`.trim())
                  .sort(),
              })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        notifications: notifications
          .map((p) => ({
            name: p.name,
            tracks: trackRows
              .filter((t) => t.notification_policy_id === p.id)
              .map((t) => t.key)
              .sort(),
            rules: rules
              .filter((r) => r.policy_id === p.id)
              .map((r) => `${r.event} ${r.recipient} ${who(r)}`.trim())
              .sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        global: globals.map((g) => `${g.permission} ${g.grantee} ${g.name ?? ''}`.trim()).sort(),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-access-seed92.visibility.json');
  });

  it('[IMP-004] [IAM-011] visibility parity: each fixture person sees exactly the expected tickets', async () => {
    const sw = schemeWorldOf(world);
    const fw = fieldWorldOf(world);
    const members = new Map(
      world.groups.map((g) => [
        g.name,
        new Set(g.members.map((i) => (world.people[i] as Person).key)),
      ]),
    );
    const groupsOf = (key: string) =>
      world.groups.filter((g) => members.get(g.name)?.has(key)).map((g) => g.name);
    const actors = new Map(world.projects.map((p) => [p.id, roleActors(world, p)]));
    const admins =
      members.get(sw.globalPermissions.find((g) => g.permission === 'SYSTEM_ADMIN')?.group ?? '') ??
      new Set();
    const fieldName = (key: string | null) =>
      fw.fields.find((f) => customFieldKey(f.id) === key)?.name;

    /** Whether a grantee of the backup names the viewer for an issue (null: anonymous). */
    const holds = (
      viewer: Person | null,
      g: Grantee,
      issue: IssueFacts,
      project: Project,
    ): boolean => {
      if (g.type === 'group' && g.parameter === null) return true;
      if (viewer === null) return false;
      const key = viewer.key;
      switch (g.type) {
        case 'group':
          return members.get(g.parameter ?? '')?.has(key) ?? false;
        case 'user':
          return g.parameter === key;
        case 'projectrole':
          return (actors.get(project.id) ?? []).some(
            (a) =>
              String(a.role) === g.parameter &&
              (a.user?.key === key ||
                (a.group !== null && (members.get(a.group)?.has(key) ?? false))),
          );
        case 'reporter':
          return issue.reporter.key === key;
        case 'assignee':
          return issue.assignee?.key === key;
        case 'lead':
          return project.lead.key === key;
        case 'applicationRole':
          return true;
        case 'userCF':
        case 'groupCF': {
          const v = customValues(world, issue).find((x) => x.field.name === fieldName(g.parameter));
          if (v?.kind === 'people') return v.people.some((p) => p.key === key);
          if (v?.kind === 'groups') return v.groups.some((name) => groupsOf(key).includes(name));
          return false;
        }
      }
    };
    /** What the fixture's model shows the viewer: browse by scheme, then the issue's level. */
    const expectedFor = (viewer: Person | null): Set<string> => {
      const out = new Set<string>();
      for (const issue of walkIssues(world)) {
        const project = issue.project;
        const scheme = sw.permissionSchemes.find(
          (s) => s.id === sw.permissionSchemeOf.get(project.id),
        );
        const browses =
          (viewer !== null && admins.has(viewer.key)) ||
          (scheme?.grants ?? []).some(
            (x) => x.permission === 'BROWSE_PROJECTS' && holds(viewer, x.grantee, issue, project),
          );
        if (!browses) continue;
        const level = securityOf(world, issue);
        if (level !== null) {
          const def = sw.securitySchemes.flatMap((s) => s.levels).find((l) => l.id === level);
          if (!def?.members.some((m) => holds(viewer, m, issue, project))) continue;
        }
        out.add(issue.key);
      }
      return out;
    };

    const db = database.db;
    const tickets = await db
      .selectFrom('ticket as t')
      .innerJoin('track as k', 'k.id', 't.track_id')
      .select(['t.id', 'k.key', 't.number'])
      .execute();
    const keyOf = new Map(tickets.map((t) => [t.id, `${t.key}-${t.number}`]));
    const ids = tickets.map((t) => t.id);
    const people = new Map(
      (await db.selectFrom('app_user').select(['id', 'email']).execute()).map((u) => [
        (u.email ?? '').toLowerCase(),
        u.id,
      ]),
    );
    const authorizer = new Authorizer(db);
    const seen = async (userId: number | null) =>
      new Set(
        [...(await authorizer.visibleTicketIds(1, { userId }, ids))].map(
          (id) => keyOf.get(id) as string,
        ),
      );

    const rows: {
      viewer: string;
      expected: number;
      seen: number;
      missing: string[];
      extra: string[];
    }[] = [];
    const compare = async (label: string, expected: Set<string>, userId: number | null) => {
      const got = await seen(userId);
      rows.push({
        viewer: label,
        expected: expected.size,
        seen: got.size,
        missing: [...expected].filter((k) => !got.has(k)).slice(0, 10),
        extra: [...got].filter((k) => !expected.has(k)).slice(0, 10),
      });
    };
    const anonymous = expectedFor(null);
    await compare('anonymous', anonymous, null);
    for (const person of world.users) {
      // An inactive account signs in to nothing, as in the source; visiting without signing
      // in, its owner sees what the anonymous row sees.
      const expected = person.active ? expectedFor(person) : new Set<string>();
      await compare(
        `${person.key}${person.active ? '' : ' (inactive)'}${admins.has(person.key) ? ' (site admin)' : ''}`,
        expected,
        people.get(person.email.toLowerCase()) ?? null,
      );
    }
    await expect(stableJson(rows)).toMatchFileSnapshot('./__golden__/dc-access-seed92.parity.json');
    // Exactly: no viewer misses a ticket or sees one too many.
    expect(rows.filter((r) => r.missing.length > 0 || r.extra.length > 0)).toEqual([]);
    expect(rows.length).toBe(world.users.length + 1);
    // The model is not trivial: viewers see different amounts, nobody sees everything but
    // through the site administrators' grant, and anonymous visitors see some.
    expect(new Set(rows.map((r) => r.expected)).size).toBeGreaterThan(5);
    expect(anonymous.size).toBeGreaterThan(0);
    expect(anonymous.size).toBeLessThan(OPTIONS.issues);

    // The same through the API for one person who is not an administrator: a ticket they
    // should see opens, one they should not is not found.
    const person = world.users.find((p) => p.active && !admins.has(p.key)) as Person;
    await db
      .updateTable('app_user')
      .set({ password_hash: await hashPassword(PASSWORD) })
      .where('id', '=', people.get(person.email.toLowerCase()) as number)
      .execute();
    const session = await signIn(person.email);
    expect(session).not.toBe('');
    const expected = expectedFor(person);
    const sample = [...walkIssues(world)].filter((_, k) => k % 97 === 0).map((i) => i.key);
    for (const key of sample) {
      const res = await as({ method: 'GET', url: `/api/v1/tickets/${key}` }, session);
      expect(res.statusCode, key).toBe(expected.has(key) ? 200 : 404);
    }
  });

  it('[IMP-010] reports the run: counts, outcomes, warnings and the mapping by name', async () => {
    const kinds = [
      'access_policy',
      'visibility_policy',
      'visibility_level',
      'notification_policy',
      'global_grant',
    ];
    await expect(
      stableJson({
        entities: report.entities
          .filter((e) => kinds.includes(e.kind) || e.kind === 'ticket')
          .map((e) => ({ kind: e.kind, source: e.source, outcomes: e.outcomes })),
        unsupported: report.unsupported,
        warnings: report.warnings
          .filter((w) => kinds.includes(w.kind))
          .map((w) => ({ kind: w.kind, code: w.code, detail: w.detail, count: w.count })),
        mapping: report.mapping
          .filter((m) => kinds.includes(m.kind))
          .map(({ targetId: _, ...m }) => m),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-access-seed92.report.json');
  });
});
