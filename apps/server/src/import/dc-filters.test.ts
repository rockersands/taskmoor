import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit/golden';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { filterWorldOf } from './dc-backup/filters';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import { securityOf } from './dc-backup/schemes';
import { buildWorld, type World, walkIssues } from './dc-backup/world';
import { scheduleOf } from './dc-filters';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.94.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const OPTIONS = defaultOptions(1_500, 94, { projects: 4 });
// Tickets without their content: the queries need tickets, not their comments or files.
const SOURCE = { format: 'dc-backup', path: 'dc-filters.zip', scope: 'tickets' } as const;
const KINDS = ['saved_search', 'subscription', 'dashboard'];

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
 * The Data Center backup import of saved filters, dashboards and subscriptions (M1-094;
 * IMP-004, IMP-010; QRY-003, QRY-011, QRY-012, RPT-004): every filter of the backup becomes a
 * saved search with its owner, shares and stars, its query translated through the corpus or
 * flagged with the reason; subscriptions keep their schedules; dashboards keep the gadgets that
 * have a widget; and a translated saved search finds exactly the tickets the source's query did.
 */
describe('Data Center backup import: saved filters, dashboards and subscriptions (M1-094)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
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

  /** Imported saved searches by the source filter's id. */
  async function savedBySource() {
    const { rows } = await sql<{
      source_id: string;
      id: number;
      name: string;
      query: string;
      import_problem: string | null;
      email: string;
    }>`SELECT e.source_id, s.id, s.name, s.query, s.import_problem, u.email
         FROM import_external_id e
         JOIN saved_search s ON s.id = e.target_id::int
         JOIN app_user u ON u.id = s.owner_id
        WHERE e.entity_kind = 'saved_search'`.execute(database.db);
    return new Map(rows.map((r) => [r.source_id, r]));
  }

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-filters-'));
    await generateDcBackup(OPTIONS, join(importDir, SOURCE.path));
    world = buildWorld(OPTIONS);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-filters-test');
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
    cookie = sessionCookie(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'admin@example.com', password: PASSWORD },
          remoteAddress: nextAddress(),
        })
      ).headers['set-cookie'],
    );
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Filters', dryRun: false, source: SOURCE },
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

  it('[IMP-004] [IMP-010] imports every filter, flagging each one that cannot translate with its reason', async () => {
    const fw = filterWorldOf(world);
    const filters = entity('saved_search');
    // The boards' filters are saved filters too.
    expect(filters?.source).toBe(fw.filters.length + world.boards.length);
    expect(filters?.outcomes.failed).toBe(0);
    expect(filters?.fidelity).toBe(1);
    const saved = await savedBySource();
    const mapping = new Map(
      report.mapping.filter((m) => m.kind === 'saved_search').map((m) => [m.sourceId, m]),
    );
    for (const f of fw.filters) {
      const row = saved.get(String(f.id));
      expect(row, f.name).toBeDefined();
      expect(row?.email, f.name).toBe(f.owner.email.toLowerCase());
      const warnings = mapping.get(String(f.id))?.warnings ?? [];
      if (f.entry.expect === 'untranslatable') {
        // Kept with the source's text, flagged, and listed with the code and the name.
        expect(row?.import_problem, f.name).toBeTruthy();
        const reason = f.entry.reason?.({ appField: { name: '' } } as never);
        expect(
          warnings.some((w) => w.startsWith(`query_not_translated: ${reason?.code}`)),
          `${f.name}: ${warnings.join(', ')}`,
        ).toBe(true);
      } else if (f.entry.expect === 'flagged') {
        expect(row?.import_problem, f.name).toMatch(/does not have yet/);
      } else if (row?.import_problem) {
        // A translated query the target refuses names what is missing here (no releases or
        // sprints are imported from this backup yet), and is listed too.
        expect(
          warnings.some((w) => w.startsWith('query_not_translated:')),
          `${f.name}: ${row.import_problem}`,
        ).toBe(true);
      }
    }
    // Most of the corpus imports clean.
    const clean = fw.filters.filter((f) => !saved.get(String(f.id))?.import_problem).length;
    expect(clean / fw.filters.length).toBeGreaterThan(0.7);
  });

  it('[QRY-011] keeps owners, shares and stars, never wider than the source', async () => {
    const fw = filterWorldOf(world);
    const saved = await savedBySource();
    const first = fw.filters[0];
    const firstRow = saved.get(String(first?.id));
    const shares = await database.db
      .selectFrom('saved_search_share')
      .select(['saved_search_id', 'scope'])
      .execute();
    expect(shares.filter((s) => s.saved_search_id === firstRow?.id).map((s) => s.scope)).toEqual([
      'public',
    ]);
    for (const f of fw.filters.slice(0, 40)) {
      const id = saved.get(String(f.id))?.id;
      const mine = shares.filter((s) => s.saved_search_id === id);
      // A private filter stays private; a share never turns into a wider one.
      if (f.shares.length === 0) expect(mine, f.name).toEqual([]);
      for (const s of mine) {
        const from = { public: 'global', any_user: 'loggedin', group: 'group', track: 'project' }[
          s.scope as 'public'
        ];
        expect(
          f.shares.some((x) => x.type === from),
          `${f.name}: ${s.scope}`,
        ).toBe(true);
      }
    }
    const stars = await database.db
      .selectFrom('saved_search_star as st')
      .innerJoin('app_user as u', 'u.id', 'st.user_id')
      .select(['st.saved_search_id', 'u.email'])
      .execute();
    const expected = fw.filters.reduce((n, f) => n + f.favourites.length, 0);
    expect(stars.length).toBe(expected);
  });

  it('[QRY-003] runs a translated saved search: it finds the tickets the source query found', async () => {
    const fw = filterWorldOf(world);
    const saved = await savedBySource();
    const filter = fw.filters.find((f) => f.entry.id === 'project-name');
    const m = /^project = "(.+)" AND status != "(.+)"$/.exec(filter?.query ?? '');
    expect(m).not.toBeNull();
    const [, projectName, doneName] = m as unknown as [string, string, string];
    const row = saved.get(String(filter?.id));
    expect(row?.import_problem).toBeNull();
    expect(row?.query).toMatch(/^track = [A-Z]+ AND status != "/);
    // The source's answer, from the generated instance: the project's issues not in that
    // status, that the administrator sees (none with a security level they are not in).
    const want = new Set<string>();
    for (const issue of walkIssues(world)) {
      if (issue.project.name !== projectName || issue.status.name === doneName) continue;
      if (securityOf(world, issue) !== null) continue;
      want.add(issue.key);
    }
    const got = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await as({
        method: 'POST',
        url: '/api/v1/search',
        // Its query as the administrator runs it (the saved search itself may be private).
        payload: {
          q: `(${row?.query}) AND visibilityLevel IS EMPTY`,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { tickets: { key: string }[]; next: string | null };
      for (const t of body.tickets) got.add(t.key);
      if (!body.next) break;
      cursor = body.next;
    }
    expect(want.size).toBeGreaterThan(10);
    expect([...got].sort()).toEqual([...want].sort());
  });

  it('[QRY-012] keeps subscriptions with their people, groups and schedules', async () => {
    const fw = filterWorldOf(world);
    const subs = entity('subscription');
    expect(subs?.source).toBe(fw.subscriptions.length);
    const untranslatable = fw.subscriptions.filter((s) => 'reason' in scheduleOf(s.cron));
    expect(untranslatable.length).toBeGreaterThan(0);
    expect(subs?.outcomes.skipped).toBe(untranslatable.length);
    expect(subs?.outcomes.failed).toBe(0);
    expect(subs?.outcomes.created).toBe(fw.subscriptions.length - untranslatable.length);
    const rows = await database.db.selectFrom('saved_search_subscription').selectAll().execute();
    expect(rows.filter((r) => r.recipient_group_id !== null).length).toBe(
      fw.subscriptions.filter((s) => s.group !== null && !('reason' in scheduleOf(s.cron))).length,
    );
    expect(new Set(rows.map((r) => r.schedule))).toEqual(
      new Set(['daily', 'weekly', 'monthly', 'cron']),
    );
    expect(scheduleOf('0 30 9 ? * MON-FRI')).toEqual({
      schedule: 'cron',
      hour: 0,
      minute: 0,
      weekday: null,
      dayOfMonth: null,
      cron: '30 9 * * 1-5',
    });
    expect(scheduleOf('0 0 7 ? * MON')).toMatchObject({ schedule: 'weekly', weekday: 1, hour: 7 });
    expect(scheduleOf('0 0 18 L * ?')).toEqual({ reason: 'cron_day_rule_not_supported' });
  });

  it('[RPT-004] maps dashboards and their gadgets, reporting the gadgets with no widget', async () => {
    const fw = filterWorldOf(world);
    const dash = entity('dashboard');
    expect(dash?.source).toBe(fw.dashboards.length);
    expect(dash?.outcomes.failed).toBe(0);
    const rows = await database.db.selectFrom('dashboard').selectAll().execute();
    const kinds = new Set(
      rows.flatMap((r) => (r.widgets as unknown as { kind: string }[]).map((w) => w.kind)),
    );
    for (const k of [
      'search-results',
      'pie',
      'created-vs-closed',
      'introduction',
      'two-dimensional',
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
    const notMapped = report.warnings
      .filter((w) => w.kind === 'dashboard' && w.code === 'gadget_not_mapped')
      .map((w) => w.detail);
    expect(notMapped.sort()).toEqual(['activitystream-gadget', 'month-calendar']);
    // A dashboard shows its widgets to someone it is shared with.
    const first = rows.find((r) => r.name === 'Team overview');
    const read = await as({ method: 'GET', url: `/api/v1/dashboards/${first?.id}` });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('[IMP-010] golden: what the report says about filters, subscriptions and dashboards', async () => {
    const golden = {
      entities: report.entities.filter((e) => KINDS.includes(e.kind)),
      warnings: report.warnings
        .filter((w) => KINDS.includes(w.kind))
        .map(({ examples: _, ...w }) => w),
      mapping: report.mapping
        .filter((m) => KINDS.includes(m.kind))
        .map(({ targetId: _, ...m }) => m),
      unsupported: report.unsupported,
      failures: report.failures.filter((f) => KINDS.includes(f.kind)),
    };
    await expect(stableJson(golden)).toMatchFileSnapshot(
      './__golden__/dc-filters-seed94.report.json',
    );
  });
});
