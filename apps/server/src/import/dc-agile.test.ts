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
import type { Column } from '../boards/model';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { DC_SOURCE } from './dc';
import { mapBoard, rankKey, translateQuery } from './dc-agile';
import {
  type AgileBoard,
  type AgileSprint,
  agileWorldOf,
  type IssueAgile,
  issueAgile,
  KANBAN_SUB_QUERY,
  type QuickFilterDef,
} from './dc-backup/agile';
import { customValues } from './dc-backup/fields';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { schemeWorldOf, securityOf } from './dc-backup/schemes';
import { buildWorld, type IssueFacts, type World, walkIssues } from './dc-backup/world';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.93.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/** Six projects: five software projects with a board each, one business project. */
const OPTIONS = defaultOptions(2_000, 93, { projects: 6 });
/** Tickets without their content (M1-091): boards and sprints need tickets, not comments. */
const SOURCE = { format: 'dc-backup', path: 'dc-agile.zip', scope: 'tickets' } as const;

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

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const day = (ms: number | null) => iso(ms)?.slice(0, 10) ?? null;

/**
 * The Data Center backup import of boards, sprints, rank, releases and areas (M1-093; IMP-004,
 * IMP-006, IMP-010; AGL-001 to AGL-011; CORE-015, CORE-016): a seeded synthetic backup with
 * Scrum and Kanban boards, one spanning two projects through its filter, columns with limits,
 * quick filters, sub-queries, sprints in every state with their issues, a rank on every issue,
 * versions and components imports through the route and the job. Every board and sprint of the
 * fixture is compared with the target: columns, queries, board filters, sprint states and
 * dates, membership and the rank order; and the boards are read through the board and backlog
 * routes, card by card, against what the fixture says each must show.
 */
describe('Data Center backup import: boards, sprints, rank, releases and areas (M1-093)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let manifest: Manifest;
  let world: World;
  let cookie = '';
  let report: FidelityReport;
  let runId = 0;
  const issues: { issue: IssueFacts; agile: IssueAgile }[] = [];
  /** Source id to target id per kind, through the import's external ids. */
  const ids = new Map<string, Map<string, number>>();
  const target = (kind: string, id: number | string) => {
    const t = ids.get(kind)?.get(String(id));
    if (t === undefined) throw new Error(`no ${kind} ${id}`);
    return t;
  };

  const as = (options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
  const entity = (kind: string) => report.entities.find((e) => e.kind === kind);

  async function runImport(): Promise<FidelityReport> {
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Boards', dryRun: false, source: SOURCE },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().importRun as { id: number };
    runId = run.id;
    for (let i = 0; i < 2000; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    return fidelityReport.parse(
      (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}/report` })).json().report,
    );
  }

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-agile-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(importDir, SOURCE.path)));
    world = buildWorld(OPTIONS);
    for (const issue of walkIssues(world)) issues.push({ issue, agile: issueAgile(world, issue) });
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-agile-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 250 });
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
    report = await runImport();
    const rows = await database.db
      .selectFrom('import_external_id')
      .select(['entity_kind', 'source_id', 'target_id'])
      .where('workspace_id', '=', 1)
      .where('import_source', '=', DC_SOURCE)
      .execute();
    for (const r of rows) {
      const map = ids.get(r.entity_kind) ?? new Map<string, number>();
      ids.set(r.entity_kind, map);
      map.set(r.source_id, Number(r.target_id));
    }
  }, 900_000);
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  /** The fixture's issues sorted by their rank: the order every board shows. */
  const byRank = () =>
    [...issues].sort((a, b) =>
      a.agile.rank < b.agile.rank ? -1 : a.agile.rank > b.agile.rank ? 1 : 0,
    );
  const statusName = (id: number) => world.statuses.find((s) => s.id === id)?.name as string;
  /** What a board's filter and sub-query find in the fixture. */
  const onBoard = (b: AgileBoard, i: IssueFacts, a: IssueAgile) =>
    b.projects.includes(i.project) &&
    (b.component === null || a.components.includes(b.component)) &&
    (b.subQuery === null || a.fixVersions.length === 0 || a.fixVersions.some((v) => !v.released));
  /**
   * The site administrator does not see tickets with a visibility level they are not in: only
   * the level for anyone signed in lets them see a ticket that has one.
   */
  const visible = (i: IssueFacts) => {
    const level = securityOf(world, i);
    if (level === null) return true;
    return schemeWorldOf(world)
      .securitySchemes.flatMap((s) => s.levels)
      .some((l) => l.id === level && l.members.some((m) => m.type === 'applicationRole'));
  };
  /** What a quick filter finds, by its kind; the app's one has no target query. */
  const matches = (f: QuickFilterDef, i: IssueFacts, a: IssueAgile): boolean => {
    switch (f.kind) {
      case 'mine':
        return false; // The administrator is nobody's assignee.
      case 'recent':
        return false; // Nothing in the fixture changed in the last day.
      case 'defects':
        return i.type.name === 'Defect';
      case 'urgent':
        return i.priority.name === 'Critical' || i.priority.name === 'High';
      // Queries name releases and areas by name: those of every track of the board match.
      case 'component':
        return a.components.some((c) => c.name === f.component?.name);
      case 'release':
        return a.fixVersions.some((v) => v.name === f.version?.name);
      case 'unestimated':
        return i.estimate === null;
      case 'reviewer':
        return customValues(world, i).some((v) => v.field.name === 'Reviewer');
      case 'openSprints':
        // Open sprints are the started ones that are not closed.
        return a.sprints.some((s) => s.started && !s.closed);
      case 'app':
        throw new Error('not imported');
    }
  };
  /** The query a quick filter is expected to hold, in Taskmoor's names. */
  const expectedFilter = (f: QuickFilterDef): string | null => {
    switch (f.kind) {
      case 'mine':
        return 'assignee = currentUser()';
      case 'recent':
        return 'updated >= -1d';
      case 'defects':
        return 'type = Defect';
      case 'urgent':
        return 'priority IN (Critical, High)';
      case 'component':
        return `area = "${f.component?.name}"`;
      case 'release':
        return `targetRelease = "${f.version?.name}"`;
      case 'unestimated':
        return 'originalEstimate IS EMPTY';
      case 'reviewer': {
        const reviewer = /^cf\[(\d+)\]/.exec(f.query)?.[1] as string;
        return `cf[${target('field', reviewer)}] IS NOT EMPTY`;
      }
      case 'openSprints':
        return 'sprint IN openSprints()';
      case 'app':
        return null;
    }
  };
  const expectedQuery = (b: AgileBoard) =>
    (b.projects.length > 1
      ? `track IN (${b.projects.map((p) => p.key).join(', ')})`
      : `track = ${b.projects[0]?.key}`) + (b.component ? ` AND area = "${b.component.name}"` : '');

  async function boardRow(b: AgileBoard) {
    return database.db
      .selectFrom('board')
      .selectAll()
      .where('id', '=', target('board', b.id))
      .executeTakeFirstOrThrow();
  }

  it('[IMP-004] [IMP-010] imports every board, sprint, release and area of the fixture, and reports what it leaves out', () => {
    const aw = agileWorldOf(world);
    expect(report.failures).toEqual([]);
    expect(entity('board')?.source).toBe(manifest.activeObjects.AO_60DB71_RAPIDVIEW);
    expect(entity('board')?.outcomes.created).toBe(aw.boards.length);
    expect(entity('sprint')?.outcomes.created).toBe(aw.sprints.length);
    expect(entity('release')?.outcomes.created).toBe(manifest.entities.Version);
    expect(entity('area')?.outcomes.created).toBe(manifest.entities.Component);
    // The plugin's own fields are carried by sprints and rank, not imported as fields.
    expect(entity('field')?.outcomes.skipped).toBe(2);
    // Every agile table is read; the elements this part reads are not reported as left out.
    for (const u of report.unsupported) {
      expect(u.kind, u.kind).not.toMatch(/^AO_60DB71_|^Version$|^Component$|^NodeAssociation$/);
    }
    // IMP-006 (2): the query an app's function needs is named with the filter and the board.
    const appFilters = aw.boards.flatMap((b) => b.quickFilters.filter((f) => f.kind === 'app'));
    expect(appFilters.length).toBeGreaterThan(0);
    const left = report.warnings.filter((w) => w.kind === 'board');
    expect(left.map((w) => [w.code, w.detail?.split(':')[0], w.count])).toEqual([
      ['board_filter_not_imported', 'Commented (app)', appFilters.length],
    ]);
  });

  it('[AGL-001] [AGL-002] [AGL-003] [AGL-005] [IMP-006] keeps each board: its kind, track, query, sub-filter, columns and board filters', async () => {
    const aw = agileWorldOf(world);
    const tracks = new Map(
      (await database.db.selectFrom('track').select(['id', 'key']).execute()).map((t) => [
        t.id,
        t.key,
      ]),
    );
    const statuses = new Map(
      (await database.db.selectFrom('status').select(['id', 'name']).execute()).map((s) => [
        s.id,
        s.name,
      ]),
    );
    const golden: unknown[] = [];
    let compared = 0;
    for (const b of aw.boards) {
      const row = await boardRow(b);
      const columns = row.columns as unknown as Column[];
      const filters = row.board_filters as { id: string; name: string; query: string }[];
      const got = {
        name: row.name,
        kind: row.kind,
        track: tracks.get(row.location_track_id as number),
        query: row.filter_query,
        subFilter: row.sub_filter_query,
        columns: columns.map((c) => ({
          name: c.name,
          statuses: c.statusIds.map((s) => statuses.get(s)),
          min: c.min,
          max: c.max,
        })),
        boardFilters: filters.map((f) => ({ name: f.name, query: f.query })),
      };
      expect(got, b.name).toEqual({
        name: b.name,
        kind: b.kind,
        track: b.projects[0]?.key,
        query: expectedQuery(b),
        subFilter:
          b.subQuery === null
            ? null
            : 'targetRelease IN upcomingReleases() OR targetRelease IS EMPTY',
        columns: b.columns.map((c) => ({
          name: c.name,
          statuses: c.statuses.map(statusName),
          min: c.min,
          max: c.max,
        })),
        boardFilters: b.quickFilters.flatMap((f) => {
          const query = expectedFilter(f);
          return query === null ? [] : [{ name: f.name, query }];
        }),
      });
      compared++;
      golden.push(got);
    }
    expect(compared).toBe(aw.boards.length);
    expect(aw.boards.filter((b) => b.projects.length > 1)).toHaveLength(1);
    expect(new Set(aw.boards.map((b) => b.kind))).toEqual(new Set(['scrum', 'kanban']));
    expect(KANBAN_SUB_QUERY).toContain('fixVersion');
    await expect(stableJson(golden)).toMatchFileSnapshot(
      './__golden__/dc-agile-seed93.boards.json',
    );
  });

  it('[AGL-010] [AGL-011] keeps each sprint: state, dates, goal, order and the tickets in it', async () => {
    const aw = agileWorldOf(world);
    const keyOf = new Map(issues.map(({ issue }) => [target('ticket', issue.id), issue.key]));
    const golden: unknown[] = [];
    for (const b of aw.boards) {
      const own = aw.sprints.filter((s) => s.board === b);
      const rows = await database.db
        .selectFrom('sprint')
        .selectAll()
        .where('board_id', '=', target('board', b.id))
        .orderBy('sequence')
        .execute();
      // Every sprint of the board, in the fixture's order, and nothing else.
      expect(
        rows.map((r) => r.id),
        b.name,
      ).toEqual(own.map((s) => target('sprint', s.id)));
      for (const s of own) {
        const row = rows.find((r) => r.id === target('sprint', s.id));
        const members = await database.db
          .selectFrom('sprint_ticket')
          .select(['ticket_id', 'open'])
          .where('sprint_id', '=', target('sprint', s.id))
          .execute();
        const got = {
          board: b.name,
          name: row?.name,
          state: row?.state,
          goal: row?.goal,
          startAt: row?.start_at?.toISOString() ?? null,
          endAt: row?.end_at?.toISOString() ?? null,
          startedAt: row?.started_at?.toISOString() ?? null,
          completedAt: row?.completed_at?.toISOString() ?? null,
          tickets: members.map((m) => keyOf.get(m.ticket_id)).sort(),
          open: [...new Set(members.map((m) => m.open))],
        };
        const want = issues
          .filter(({ agile }) => agile.sprints.includes(s))
          .map(({ issue }) => issue.key)
          .sort();
        expect(got, `${b.name}: ${s.name}`).toEqual({
          board: b.name,
          name: s.name,
          state: s.closed ? 'closed' : s.started ? 'active' : 'future',
          goal: s.goal ?? '',
          startAt: iso(s.start),
          endAt: iso(s.end),
          startedAt: s.started ? iso(s.start) : null,
          completedAt: iso(s.complete),
          tickets: want,
          open: want.length === 0 ? [] : [!s.closed],
        });
        golden.push({ ...got, tickets: got.tickets.length });
      }
    }
    const states = new Set(aw.sprints.map((s) => (s.closed ? 'c' : s.started ? 'a' : 'f')));
    expect(states).toEqual(new Set(['c', 'a', 'f']));
    expect(manifest.cases.issuesInSeveralSprints).toBeGreaterThan(0);
    await expect(stableJson(golden)).toMatchFileSnapshot(
      './__golden__/dc-agile-seed93.sprints.json',
    );
  });

  it('[AGL-009] gives every ticket a rank in the fixture order', async () => {
    const rows = await database.db
      .selectFrom('ticket')
      .select(['id', 'rank'])
      .where('workspace_id', '=', 1)
      .orderBy('rank')
      .execute();
    expect(rows.map((r) => r.id)).toEqual(byRank().map(({ issue }) => target('ticket', issue.id)));
    // The key is the backup's rank written in rank digits, so it survives a second import.
    const first = byRank()[0] as (typeof issues)[number];
    expect(rows[0]?.rank).toBe(rankKey(first.agile.rank));
    expect(report.warnings.filter((w) => w.code === 'rank_changed')).toEqual([]);
  });

  it('[CORE-015] [CORE-016] maps versions to releases and components to areas, on their tickets', async () => {
    const aw = agileWorldOf(world);
    const releases = await database.db.selectFrom('release').selectAll().execute();
    for (const v of aw.versions) {
      const r = releases.find((x) => x.id === target('release', v.id));
      const shipped = v.release ?? v.start;
      expect(
        {
          track: r?.track_id,
          name: r?.name,
          releaseDate: r?.release_date ?? null,
          startDate: r?.start_date ?? null,
          shippedAt: r?.shipped_at?.toISOString() ?? null,
          archivedAt: r?.archived_at?.toISOString() ?? null,
        },
        `${v.project.key} ${v.name}`,
      ).toEqual({
        track: target('track', v.project.id),
        name: v.name,
        releaseDate: day(v.release),
        startDate: day(v.start),
        shippedAt: v.released ? `${day(shipped)}T00:00:00.000Z` : null,
        archivedAt: v.archived ? `${day(shipped)}T00:00:00.000Z` : null,
      });
    }
    // Releases keep the versions' order within their track.
    for (const p of world.projects) {
      const own = releases
        .filter((r) => r.track_id === target('track', p.id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((r) => r.name);
      expect(own, p.key).toEqual(aw.versionsOf.get(p.id)?.map((v) => v.name));
    }
    const areas = await database.db.selectFrom('area').selectAll().execute();
    const assignee = ['track_owner', 'area_owner', 'track_owner', 'unassigned'];
    for (const c of aw.components) {
      const a = areas.find((x) => x.id === target('area', c.id));
      expect(
        {
          track: a?.track_id,
          name: a?.name,
          owner: a?.owner_id,
          defaultAssignee: a?.default_assignee,
        },
        c.name,
      ).toEqual({
        track: target('track', c.project.id),
        name: c.name,
        owner: c.lead === null ? null : target('user', c.lead.key.toLowerCase()),
        defaultAssignee: assignee[c.assigneeType],
      });
    }
    const ticketReleases = await database.db.selectFrom('ticket_release').selectAll().execute();
    const ticketAreas = await database.db.selectFrom('ticket_area').selectAll().execute();
    let matched = 0;
    for (const { issue, agile } of issues) {
      const t = target('ticket', issue.id);
      const of = (role: string) =>
        ticketReleases
          .filter((r) => r.ticket_id === t && r.role === role)
          .map((r) => r.release_id)
          .sort((a, b) => a - b);
      const got = {
        target: of('target'),
        found: of('found'),
        areas: ticketAreas
          .filter((r) => r.ticket_id === t)
          .map((r) => r.area_id)
          .sort((a, b) => a - b),
      };
      const want = {
        target: agile.fixVersions.map((v) => target('release', v.id)).sort((a, b) => a - b),
        found: agile.affectsVersions.map((v) => target('release', v.id)).sort((a, b) => a - b),
        areas: agile.components.map((c) => target('area', c.id)).sort((a, b) => a - b),
      };
      expect(got, issue.key).toEqual(want);
      matched++;
    }
    expect(matched).toBe(OPTIONS.issues);
  });

  it('[AGL-002] [AGL-005] [AGL-009] reads every imported board card by card, with each board filter', async () => {
    const aw = agileWorldOf(world);
    let cards = 0;
    for (const b of aw.boards) {
      const id = target('board', b.id);
      const columnOf = (status: number) => b.columns.find((c) => c.statuses.includes(status));
      const shown = byRank().filter(
        ({ issue, agile }) => visible(issue) && onBoard(b, issue, agile),
      );
      const read = async (filters?: string) => {
        const res = await as({
          method: 'GET',
          url: `/api/v1/boards/${id}/data?limit=50000${filters ? `&filters=${filters}` : ''}`,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as {
          columns: { id: string; name: string; count: number }[];
          cards: { key: string; columnId: string }[];
          unmapped: { count: number };
          truncated: boolean;
        };
      };
      const data = await read();
      expect(data.truncated).toBe(false);
      const want = shown.filter(({ issue }) => columnOf(issue.status.id) !== undefined);
      expect(
        data.cards.map((c) => c.key),
        b.name,
      ).toEqual(want.map(({ issue }) => issue.key));
      // Each card in the column that holds its status, and the unmapped panel counts the rest.
      for (const card of data.cards) {
        const issue = want.find((w) => w.issue.key === card.key)?.issue as IssueFacts;
        const column = data.columns.find((c) => c.id === card.columnId);
        expect(column?.name, card.key).toBe(columnOf(issue.status.id)?.name);
      }
      expect(data.unmapped.count, b.name).toBe(shown.length - want.length);
      cards += data.cards.length;

      // Each board filter narrows the cards to what the fixture says it finds.
      const row = await boardRow(b);
      const filters = row.board_filters as { id: string; name: string }[];
      for (const f of b.quickFilters) {
        if (f.kind === 'app') continue;
        const imported = filters.find((x) => x.name === f.name);
        expect(imported, `${b.name}: ${f.name}`).toBeDefined();
        const narrowed = await read(imported?.id);
        expect(
          narrowed.cards.map((c) => c.key),
          `${b.name}: ${f.name}`,
        ).toEqual(
          want.filter(({ issue, agile }) => matches(f, issue, agile)).map(({ issue }) => issue.key),
        );
      }
    }
    expect(cards).toBeGreaterThan(1000);
  });

  it('[AGL-008] [AGL-010] reads the cross-track board backlog: open sprints, then the backlog, in rank order', async () => {
    const aw = agileWorldOf(world);
    const b = aw.boards.find((x) => x.projects.length > 1) as AgileBoard;
    const res = await as({ method: 'GET', url: `/api/v1/boards/${target('board', b.id)}/backlog` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      sprints: { id: number; state: string; tickets: { key: string }[] }[];
      backlog: { tickets: { key: string }[] };
    };
    const mapped = new Set(b.columns.flatMap((c) => c.statuses));
    const done = new Set(b.columns[b.columns.length - 1]?.statuses);
    const shown = byRank().filter(
      ({ issue, agile }) =>
        visible(issue) && onBoard(b, issue, agile) && mapped.has(issue.status.id),
    );
    // The active sprint first, then the future ones in their order.
    const open = aw.sprints
      .filter((s) => s.board === b && !s.closed)
      .sort((x, y) => Number(y.started) - Number(x.started) || x.sequence - y.sequence);
    expect(body.sprints.map((s) => s.id)).toEqual(open.map((s) => target('sprint', s.id)));
    for (const [k, s] of open.entries()) {
      expect(
        body.sprints[k]?.tickets.map((t) => t.key),
        s.name,
      ).toEqual(
        shown
          .filter(({ agile }) => agile.sprints.includes(s as AgileSprint))
          .map(({ issue }) => issue.key),
      );
    }
    expect(body.backlog.tickets.map((t) => t.key)).toEqual(
      shown
        .filter(
          ({ issue, agile }) => !agile.sprints.some((s) => !s.closed) && !done.has(issue.status.id),
        )
        .map(({ issue }) => issue.key),
    );
    expect(body.sprints.some((s) => s.tickets.length > 0)).toBe(true);
    expect(body.backlog.tickets.length).toBeGreaterThan(0);
  });

  it('[IMP-009] changes nothing when the same backup is imported again', async () => {
    const before = await database.db.selectFrom('board').select('id').execute();
    const again = await runImport();
    for (const kind of ['release', 'area', 'board', 'sprint', 'ticket']) {
      const e = again.entities.find((x) => x.kind === kind);
      expect(e?.outcomes.unchanged, kind).toBe(e?.source);
    }
    expect(await database.db.selectFrom('board').select('id').execute()).toEqual(before);
    expect(again.warnings.filter((w) => w.code === 'rank_changed')).toEqual([]);
    expect(runId).toBeGreaterThan(0);
  }, 600_000);

  it('[IMP-006] translates queries into the native names and refuses ids of the backup', () => {
    expect(translateQuery('project in (AX, BX) AND issuetype = Defect ORDER BY Rank ASC')).toEqual({
      query: 'track IN (AX, BX) AND type = Defect',
      fields: [],
    });
    expect(translateQuery('cf[10007] is not EMPTY AND component = "Café"')).toEqual({
      query: 'cf[10007] IS NOT EMPTY AND area = "Café"',
      fields: ['10007'],
    });
    expect(translateQuery('filter = 10003')).toMatchObject({ problem: 'query_names_saved_filter' });
    expect(translateQuery('sprint = 12')).toMatchObject({ problem: 'query_names_sprint_by_id' });
    expect(translateQuery('project = (')).toMatchObject({ problem: 'query_not_parsed' });
    // A board whose filter names no project the backup holds has nowhere to live.
    expect(
      mapBoard({
        id: '1',
        name: 'Lost',
        scrum: true,
        filter: { id: '9', name: 'f', query: 'assignee = currentUser()' },
        filterId: '9',
        projects: [],
        unknownProjects: [],
        subQuery: null,
        columns: [],
        quickFilters: [],
      }),
    ).toEqual({ fail: 'board_project_unknown' });
  });

  it('[AGL-009] keeps the order of ranks: keys compare as the backup ranks do', () => {
    const ranks = ['0|hzzzzz:', '0|i00000:', '0|i00000:a', '0|i0000a:', '1|000000:', '0|hzzzzz:z'];
    const sorted = [...ranks].sort();
    const keys = sorted.map((r) => rankKey(r) as string);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rankKey('0|Ä')).toBeNull();
  });
});
