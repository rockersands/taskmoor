import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit/golden';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { AGILE_CONFIGURATION_TABLES } from './dc-backup/agile-format';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { CONSUMED, CONTENT_ELEMENTS, STAGED } from './dc-backup/stage';
import { buildWorld, type World } from './dc-backup/world';
import { registerImportJobs } from './jobs';
import { placeholderEmail } from './load';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
/** The agile plugin's sprint and rank fields, which are not imported as fields (M1-093). */
const AGILE_FIELDS = 2;

const OPTIONS = defaultOptions(10_000, 1);
/** People and configuration only: the tickets are M1-089's test (`dc-fields.test.ts`). */
const SOURCE = { format: 'dc-backup', path: 'dc-10k.zip', scope: 'configuration' } as const;

/** The configuration tables a mapped kind lands in, with their name column. */
const TARGETS = {
  role: 'role',
  status: 'status',
  priority: 'priority',
  close_reason: 'close_reason',
  ticket_type: 'ticket_type',
  group: 'user_group',
} as const satisfies Record<string, keyof Database>;

async function zipOf(entries: Record<string, string>, path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const chunk of zip.outputStream) parts.push(chunk as Buffer);
  await writeFile(path, Buffer.concat(parts));
}

/**
 * The Data Center backup import, first mapping (M1-088; IMP-001, IMP-004, IMP-007, IMP-009,
 * IMP-010): the 10,000-issue synthetic backup of M1-087 imports through the route and the job,
 * its people, groups with members, roles, projects with role actors, issue types, statuses,
 * priorities and resolutions match the golden manifest exactly, every other element is
 * reported with its count and reason, and the report maps each configuration object by name.
 */
describe('Data Center backup import (M1-088)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let manifest: Manifest;
  let world: World;
  let cookie = '';
  /** A target person who is also in the backup, by another case of the same address. */
  let known = { id: 0, email: '' };
  /** Names each configuration table had before any import, lower case. */
  const before: Record<string, Set<string>> = {};
  let dryReport: FidelityReport;
  let realReport: FidelityReport;
  let realRun = 0;

  const as = (options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
  async function start(source: Record<string, unknown>, dryRun = false) {
    const res = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Backup', dryRun, source },
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json().importRun as { id: number };
  }
  async function finish(id: number): Promise<FidelityReport> {
    for (let i = 0; i < 200; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    const res = await as({ method: 'GET', url: `/api/v1/admin/imports/${id}/report` });
    expect(res.statusCode, res.body).toBe(200);
    return fidelityReport.parse(res.json().report);
  }
  const entity = (r: FidelityReport, kind: string) => r.entities.find((e) => e.kind === kind);
  const imported = async (runId: number, kind: string) =>
    (
      await database.db
        .selectFrom('import_record')
        .select('target_id')
        .where('run_id', '=', String(runId))
        .where('entity_kind', '=', kind)
        .where('target_id', 'is not', null)
        .execute()
    ).map((r) => Number(r.target_id));
  const countRows = async (table: keyof Database) =>
    Number(
      (await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(database.db))
        .rows[0]?.n,
    );

  /** What each kind should hold, from the manifest and the generator's own instance. */
  const expected = () => ({
    user: (manifest.entities.ApplicationUser ?? 0) + (manifest.cases.usersDeletedReferenced ?? 0),
    group: manifest.entities.Group,
    role: manifest.entities.ProjectRole,
    status: manifest.entities.Status,
    priority: manifest.entities.Priority,
    close_reason: manifest.entities.Resolution,
    ticket_type: manifest.entities.IssueType,
    track: manifest.entities.Project,
    // M1-089: fields and forms (the second project keeps the default field rules: one more).
    // The agile plugin's sprint and rank fields are skipped: sprints and rank carry them.
    field: (manifest.entities.CustomField ?? 0) - AGILE_FIELDS,
    field_context: manifest.entities.FieldConfigScheme,
    field_option: manifest.entities.CustomFieldOption,
    field_rule_set: (manifest.entities.FieldLayoutScheme ?? 0) + 1,
    layout_set: manifest.entities.IssueTypeScreenScheme,
    // M1-093: releases, areas and boards are configuration; sprints hold tickets.
    release: manifest.entities.Version,
    area: manifest.entities.Component,
    board: manifest.activeObjects.AO_60DB71_RAPIDVIEW,
  });
  /** Records of a kind read and skipped on purpose: the agile plugin's two fields (M1-093). */
  const skippedOf = (kind: string) => (kind === 'field' ? AGILE_FIELDS : 0);
  /** Source names per kind, to tell which link to the target's objects of the same name. */
  const sourceNames = () => ({
    role: world.roles.map((r) => r.name),
    status: world.statuses.map((s) => s.name),
    priority: world.priorities.map((p) => p.name),
    close_reason: world.resolutions.map((r) => r.name),
    ticket_type: world.issueTypes.map((t) => t.name),
    group: world.groups.map((g) => g.name),
  });

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-import-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(importDir, 'dc-10k.zip')));
    world = buildWorld(OPTIONS);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-import-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 40 });
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = (
      [res.headers['set-cookie'] ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
      ''
    ).split(';')[0] as string;
    // Someone already here under a source person's address, in capitals.
    const person = world.users[1] as World['users'][number];
    const row = await database.db
      .insertInto('app_user')
      .values({ workspace_id: 1, email: person.email.toUpperCase(), name: 'Already here' })
      .returning('id')
      .executeTakeFirstOrThrow();
    known = { id: row.id, email: person.email };
    for (const [kind, table] of Object.entries(TARGETS)) {
      const { rows } = await sql<{ name: string }>`
        SELECT lower(name) AS name FROM ${sql.table(table)}`.execute(database.db);
      before[kind] = new Set(rows.map((r) => r.name));
    }
  });
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  it('[IMP-004] [IMP-009] a dry run plans every configuration object and writes nothing', async () => {
    const tables = ['app_user', 'user_group', 'group_member', 'track', 'track_role_actor'] as const;
    const counts = await Promise.all(tables.map(countRows));
    const run = await start(SOURCE, true);
    dryReport = await finish(run.id);
    expect(await Promise.all(tables.map(countRows))).toEqual(counts);
    for (const [kind, n] of Object.entries(expected())) {
      const e = entity(dryReport, kind);
      expect(e?.source, kind).toBe((n ?? 0) + skippedOf(kind));
      expect((e?.outcomes.created ?? 0) + (e?.outcomes.linked ?? 0), kind).toBe(n);
      expect(e?.target, kind).toBeNull();
    }
    // The stage stays beside the backup for the real run.
    expect((await stat(join(importDir, `dc-10k.zip${STAGED}`, 'stage.json'))).isFile()).toBe(true);
    // Staging spills every issue's content to files and reads it back (M1-091): give it time.
  }, 120_000);

  it('[IMP-004] [IMP-001] imports the configuration with every count equal to the golden manifest', async () => {
    const run = await start(SOURCE);
    realRun = run.id;
    realReport = await finish(run.id);
    const r = realReport;

    // Every kind: all records read, none failed or skipped, each with its target (100%).
    for (const [kind, n] of Object.entries(expected())) {
      const e = entity(r, kind);
      expect(e?.source, kind).toBe((n ?? 0) + skippedOf(kind));
      expect(e?.outcomes.failed, kind).toBe(0);
      expect(e?.outcomes.skipped, kind).toBe(skippedOf(kind));
      expect((e?.outcomes.created ?? 0) + (e?.outcomes.linked ?? 0), kind).toBe(n);
      expect(e?.fidelity, kind).toBe(1);
    }
    expect(r.failures).toEqual([]);
    // Names the target had are linked, the others created; the dry run said the same.
    for (const [kind, names] of Object.entries(sourceNames())) {
      const linked = names.filter((n) => before[kind]?.has(n.toLowerCase())).length;
      expect(entity(r, kind)?.outcomes.linked, kind).toBe(linked);
      expect(entity(r, kind)?.target, kind).toBe(names.length);
    }
    expect(dryReport.entities.map((e) => [e.kind, e.outcomes])).toEqual(
      r.entities.map((e) => [e.kind, e.outcomes]),
    );

    // Memberships and role actors arrive in full.
    const groups = await imported(run.id, 'group');
    const members = await database.db
      .selectFrom('group_member')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('group_id', 'in', groups)
      .executeTakeFirstOrThrow();
    expect(Number(members.n)).toBe(manifest.entities.Membership);
    const tracks = await imported(run.id, 'track');
    const actors = await database.db
      .selectFrom('track_role_actor')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('track_id', 'in', tracks)
      .executeTakeFirstOrThrow();
    expect(Number(actors.n)).toBe(manifest.entities.ProjectRoleActor);

    // Tracks keep key, name, type, lead and the last number given out.
    const rows = await database.db
      .selectFrom('track as t')
      .leftJoin('ticket_counter as c', 'c.track_id', 't.id')
      .leftJoin('app_user as u', 'u.id', 't.owner_id')
      .select(['t.key', 't.name', 't.type', 'c.last_number', 'u.email'])
      .where('t.id', 'in', tracks)
      .orderBy('t.key')
      .execute();
    expect(rows).toEqual(
      [...world.projects]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((p) => ({
          key: p.key,
          name: p.name,
          type: p.type,
          last_number: p.counter,
          email: p.lead.email.toLowerCase(),
        })),
    );
    // Statuses keep their stage; the sub-task type becomes a subticket type.
    const statuses = await database.db
      .selectFrom('status')
      .select(['name', 'stage'])
      .where('id', 'in', await imported(run.id, 'status'))
      .execute();
    const stageOf = { new: 'new', indeterminate: 'active', done: 'closed' } as const;
    for (const s of world.statuses) {
      expect(statuses.find((x) => x.name === s.name)?.stage, s.name).toBe(stageOf[s.category]);
    }
    const levels = await database.db
      .selectFrom('ticket_type as t')
      .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
      .select(['t.name', 'l.kind'])
      .where('t.id', 'in', await imported(run.id, 'ticket_type'))
      .execute();
    for (const t of world.issueTypes) {
      expect(levels.find((x) => x.name === t.name)?.kind, t.name).toBe(
        t.subtask ? 'subticket' : 'standard',
      );
    }
    // Inactive people and deleted ones are deactivated.
    const people = await database.db
      .selectFrom('app_user')
      .select(['email', 'deactivated_at'])
      .where('id', 'in', await imported(run.id, 'user'))
      .execute();
    expect(people.filter((p) => p.deactivated_at !== null).length).toBe(
      (manifest.cases.usersInactive ?? 0) + (manifest.cases.usersDeletedReferenced ?? 0),
    );

    // Everything else is reported, with its count and why (IMP-004: never dropped silently).
    const leftOut = Object.entries(manifest.entities)
      .filter(([name]) => !CONSUMED.has(name) || CONTENT_ELEMENTS.has(name))
      .map(([kind, count]) => ({
        kind,
        count,
        reason: CONTENT_ELEMENTS.has(kind)
          ? 'configuration_only'
          : kind === 'SequenceValueItem'
            ? 'not_needed'
            : 'not_imported_yet',
      }));
    // Boards are read in full; their sprints and the issues' rank are tickets' (M1-093).
    const tables = Object.entries(manifest.activeObjects)
      .filter(([kind]) => !AGILE_CONFIGURATION_TABLES.has(kind))
      .map(([kind, count]) => ({ kind, count, reason: 'configuration_only' }));
    const associations = ['issueFixVersions', 'issueAffectedVersions', 'issueComponents'].reduce(
      (n, k) => n + (manifest.cases[k] ?? 0),
      0,
    );
    leftOut.push({ kind: 'NodeAssociation', count: associations, reason: 'configuration_only' });
    const files = { kind: 'data/attachments', count: manifest.attachments.files };
    expect(r.unsupported).toEqual(
      // Attachment files are content too (M1-091).
      [...leftOut, ...tables, { ...files, reason: 'configuration_only' }].sort((a, b) =>
        a.kind.localeCompare(b.kind),
      ),
    );
    // The characters XML forbids were removed and are in the report (IMP-001 (2)).
    const removed = Object.fromEntries(
      r.warnings
        .filter((w) => w.kind === 'source' && w.code === 'removed_character')
        .map((w) => [w.detail, w.count]),
    );
    expect(removed).toEqual({
      nul: manifest.forbidden.nul,
      control: manifest.forbidden.control,
      noncharacter: manifest.forbidden.noncharacter,
      char_ref: manifest.forbidden.charRef,
    });

    // The golden: counts, outcomes, what was left out, and the mapping by name.
    await expect(
      stableJson({
        entities: r.entities.map((e) => ({ kind: e.kind, source: e.source, outcomes: e.outcomes })),
        unsupported: r.unsupported,
        warnings: r.warnings.map((w) => ({
          kind: w.kind,
          code: w.code,
          detail: w.detail,
          count: w.count,
        })),
        mapping: r.mapping.map(({ targetId: _, ...m }) => m),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-10k-seed1.report.json');
  });

  it('[IMP-007] links a person by address and keeps deleted people as inactive placeholders', async () => {
    const linked = realReport.mapping.filter((m) => m.kind === 'user' && m.outcome === 'linked');
    expect(linked.map((m) => m.targetId)).toEqual([known.id]);
    expect(linked[0]?.label).toContain(known.email);
    const deleted = world.people.filter((p) => p.deleted);
    const placeholders = realReport.mapping.filter(
      (m) => m.kind === 'user' && m.warnings.includes('deleted_user'),
    );
    expect(placeholders.map((m) => m.sourceId).sort()).toEqual(
      deleted.map((p) => p.key.toLowerCase()).sort(),
    );
    const rows = await database.db
      .selectFrom('app_user')
      .select(['email', 'deactivated_at', 'password_hash'])
      .where(
        'id',
        'in',
        placeholders.map((m) => m.targetId as number),
      )
      .execute();
    expect(rows.map((u) => u.email).sort()).toEqual(
      placeholders.map((m) => placeholderEmail('dc', m.sourceId)).sort(),
    );
    for (const u of rows) {
      expect(u.deactivated_at).not.toBeNull();
      expect(u.password_hash).toBeNull();
    }
    // Statuses, priorities and the rest name what they linked to or created.
    const backlog = realReport.mapping.find((m) => m.kind === 'status' && m.label === 'Backlog');
    expect(backlog?.outcome).toBe('linked');
    const declined = realReport.mapping.find((m) => m.kind === 'status' && m.label === 'Declined');
    expect(declined?.outcome).toBe('created');
    // The backup's workflows hold it (M1-090), so it is not reported as outside every workflow.
    expect(declined?.warnings).toEqual([]);
  });

  it('[IMP-009] importing the same backup again changes nothing and reuses the stage', async () => {
    const summary = join(importDir, `dc-10k.zip${STAGED}`, 'stage.json');
    const staged = (await stat(summary)).mtimeMs;
    const run = await start(SOURCE);
    const again = await finish(run.id);
    for (const [kind, n] of Object.entries(expected())) {
      expect(entity(again, kind)?.outcomes, kind).toEqual({
        created: 0,
        updated: 0,
        unchanged: n,
        linked: 0,
        failed: 0,
        skipped: skippedOf(kind),
      });
    }
    expect((await stat(summary)).mtimeMs).toBe(staged);
    // The source's notes are counted once per run, not once per part of it.
    expect(again.warnings.filter((w) => w.kind === 'source')).toEqual(
      realReport.warnings.filter((w) => w.kind === 'source'),
    );
  });

  it('[IMP-010] lists every record with its name in the source, a page at a time', async () => {
    const page = async (query: string) => {
      const res = await as({
        method: 'GET',
        url: `/api/v1/admin/imports/${realRun}/records?${query}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        records: { kind: string; label: string | null; outcome: string; targetId: number | null }[];
        next: string | null;
      };
    };
    const first = await page('kind=status&limit=4');
    expect(first.records.length).toBe(4);
    expect(first.next).not.toBeNull();
    const rest = await page(`kind=status&limit=4&after=${encodeURIComponent(first.next ?? '')}`);
    expect(rest.next).toBeNull();
    expect(
      [...first.records, ...rest.records]
        .map((r) => r.label)
        .sort((a, b) => (a ?? '').localeCompare(b ?? '')),
    ).toEqual(world.statuses.map((s) => s.name).sort((a, b) => a.localeCompare(b)));
    const linked = await page('outcome=linked&limit=1000');
    expect(linked.records.every((r) => r.outcome === 'linked' && r.targetId !== null)).toBe(true);
    expect(linked.records.length).toBe(
      realReport.entities.reduce((n, e) => n + e.outcomes.linked, 0),
    );
    const bad = await as({
      method: 'GET',
      url: `/api/v1/admin/imports/${realRun}/records?limit=0`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('[IMP-001] refuses a file that is not a backup before anything is queued', async () => {
    await writeFile(join(importDir, 'text.zip'), 'not a zip');
    await zipOf({ 'backup/entities.xml': '<entity-engine-xml/>' }, join(importDir, 'nested.zip'));
    for (const [path, error] of [
      ['text.zip', 'invalid_source'],
      ['nested.zip', 'invalid_source'],
      ['../outside.zip', 'not_found'],
      ['missing.zip', 'not_found'],
    ] as const) {
      const res = await as({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { source: { format: 'dc-backup', path } },
      });
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error, path).toBe(error);
    }
  });

  it('[IMP-004] [IMP-007] reads leniently and says what it left out of a hand-written backup', async () => {
    const entities = `<?xml version="1.0" encoding="UTF-8"?>
<entity-engine-xml>
  <ApplicationUser id="1" userKey="ana" lowerUserName="ana"/>
  <ApplicationUser id="2" userKey="JIRAUSER2" lowerUserName="gone"/>
  <ApplicationUser id="3" userKey="JIRAUSER3" lowerUserName="forgotten"/>
  <CustomField id="1" cfname="Team size" customfieldtypekey="com.example.plugin:team-size"/>
  <Directory id="1" directoryName="Remote" active="1" directoryPosition="1"/>
  <Directory id="2" directoryName="Local" active="1" directoryPosition="0"/>
  <Group id="1" groupName="Edge-Team" lowerGroupName="edge-team" active="1" local="0" directoryId="1"/>
  <Group id="2" groupName="edge-inner" lowerGroupName="edge-inner" active="1" local="0" directoryId="1"/>
  <Issue id="1" project="1" number="1" type="1" status="1" reporter="jirauser2" summary="x"/>
  <Membership id="1" parentId="1" childId="1" membershipType="GROUP_USER" parentName="Edge-Team" lowerParentName="edge-team" childName="Ana" lowerChildName="ana" directoryId="1"/>
  <Membership id="2" parentId="1" childId="2" membershipType="GROUP_GROUP" parentName="Edge-Team" lowerParentName="edge-team" childName="edge-inner" lowerChildName="edge-inner" directoryId="1"/>
  <Membership id="3" parentId="1" childId="9" membershipType="GROUP_USER" parentName="Edge-Team" lowerParentName="edge-team" childName="nobody" lowerChildName="nobody" directoryId="1"/>
  <Project id="1" name="Edge cases" key="EDGE" originalkey="OLDEDGE" lead="ana" counter="7" projecttype="service_desk">
    <description><![CDATA[Two lines,
and a ]]]]><![CDATA[> in the middle.]]></description>
  </Project>
  <ProjectRole id="1" name="Edge role" description="Edge cases"/>
  <ProjectRoleActor id="1" pid="1" projectroleid="1" roletype="atlassian-user-role-actor" roletypeparameter="Ana"/>
  <ProjectRoleActor id="2" pid="1" projectroleid="1" roletype="atlassian-group-role-actor" roletypeparameter="no-such-group"/>
  <ProjectRoleActor id="3" pid="1" projectroleid="9" roletype="atlassian-user-role-actor" roletypeparameter="ana"/>
  <Status id="1" sequence="1" name="Edge open" statuscategory="7"/>
  <User id="1" directoryId="1" userName="Ana" lowerUserName="ana" active="1" displayName="Ana Remote" emailAddress="ana.remote@edge.test"/>
  <User id="2" directoryId="2" userName="ana" lowerUserName="ana" active="1" displayName="Ana Local" emailAddress="ana@edge.test"/>
  <User id="3" directoryId="2" userName="Nokey" lowerUserName="nokey" active="0" displayName="No Key"/>
</entity-engine-xml>
`;
    await zipOf({ 'entities.xml': entities }, join(importDir, 'edge.zip'));
    const run = await start({
      format: 'dc-backup',
      path: 'edge.zip',
      system: 'edge',
      scope: 'configuration',
    });
    const r = await finish(run.id);
    const map = (kind: string) =>
      r.mapping
        .filter((m) => m.kind === kind)
        .map(({ targetId: _, ...m }) => m)
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    expect(map('user')).toEqual([
      // The directory with the lowest position wins.
      {
        kind: 'user',
        sourceId: 'ana',
        label: 'Ana Local <ana@edge.test>',
        outcome: 'created',
        reason: null,
        warnings: [],
      },
      // Deleted (a key row, no user row): kept only when something names them.
      {
        kind: 'user',
        sourceId: 'jirauser2',
        label: 'gone',
        outcome: 'created',
        reason: null,
        warnings: ['deleted_user', 'placeholder_email'],
      },
      {
        kind: 'user',
        sourceId: 'jirauser3',
        label: 'forgotten',
        outcome: 'skipped',
        reason: 'deleted_user_not_referenced',
        warnings: [],
      },
      // A user row without a key row is keyed by its user name; no address, a placeholder.
      {
        kind: 'user',
        sourceId: 'nokey',
        label: 'No Key',
        outcome: 'created',
        reason: null,
        warnings: ['no_email', 'placeholder_email'],
      },
    ]);
    expect(map('group')).toEqual([
      {
        kind: 'group',
        sourceId: 'edge-inner',
        label: 'edge-inner',
        outcome: 'created',
        reason: null,
        warnings: [],
      },
      {
        kind: 'group',
        sourceId: 'edge-team',
        label: 'Edge-Team',
        outcome: 'created',
        reason: null,
        warnings: ['nested_group_not_imported: edge-inner', 'member_not_found'],
      },
    ]);
    expect(map('track')).toEqual([
      {
        kind: 'track',
        sourceId: '1',
        label: 'EDGE: Edge cases',
        outcome: 'created',
        reason: null,
        warnings: [
          'unknown_project_type: service_desk',
          'original_key_not_kept: OLDEDGE',
          'role_actor_unknown_group: no-such-group',
          'role_actor_unknown_role: 9',
        ],
      },
    ]);
    expect(map('status')[0]?.warnings).toEqual([
      'unknown_status_category: 7',
      'status_not_in_workflow: Edge open',
    ]);
    const track = await database.db
      .selectFrom('track')
      .select(['id', 'type', 'description'])
      .where('key', '=', 'EDGE')
      .executeTakeFirstOrThrow();
    expect(track.type).toBe('business');
    expect(track.description).toBe('Two lines,\nand a ]]> in the middle.');
    const actors = await database.db
      .selectFrom('track_role_actor as a')
      .innerJoin('app_user as u', 'u.id', 'a.user_id')
      .select('u.email')
      .where('a.track_id', '=', track.id)
      .execute();
    expect(actors).toEqual([{ email: 'ana@edge.test' }]);
    const team = await database.db
      .selectFrom('group_member as m')
      .innerJoin('user_group as g', 'g.id', 'm.group_id')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('g.name', '=', 'Edge-Team')
      .execute();
    expect(team).toEqual([{ email: 'ana@edge.test' }]);
    // An app's field type: a read-only text field for its raw values (M1-089, spec 02a).
    expect(map('field')).toEqual([
      {
        kind: 'field',
        sourceId: '1',
        label: 'Team size',
        outcome: 'created',
        reason: null,
        warnings: ['app_field_as_read_only_text: com.example.plugin:team-size'],
      },
    ]);
    // Issues are left out of a configuration-only run; there is no active-objects file.
    expect(r.unsupported).toEqual([{ kind: 'Issue', count: 1, reason: 'configuration_only' }]);
  });
});
