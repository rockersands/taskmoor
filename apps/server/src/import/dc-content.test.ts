import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { LocalStore } from '@taskmoor/storage';
import { stableJson } from '@taskmoor/testkit/golden';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storesOf } from '../attachments/stores';
import { FieldCatalogs } from '../fields/catalog';
import { resolveTicket } from '../tickets/store';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { buildWorld, type World, walkIssues } from './dc-backup/world';
import { type DcFidelity, dcFidelity } from './dc-fidelity';
import { IMPORT_FORMATS } from './jobs';
import { type FidelityReport, fidelityReport } from './report';
import { createRun, runImport } from './run';

/** Six projects, so moved issues have somewhere to come from. */
const OPTIONS = defaultOptions(3_000, 91, { projects: 6 });

/** M1-091's done-when: at least this share of every entity kind arrives exactly. */
const FIDELITY = 0.999;

/**
 * The Data Center backup import of an issue's content (M1-091; IMP-001, IMP-004, IMP-010,
 * IMP-011; CORE-020, CORE-022, CORE-023): a seeded synthetic backup with change history,
 * comments restricted to groups and roles and edited, time entries, links of several types,
 * web links, attachment files, watchers, voters and moved issues imports in full; every entity
 * is compared with the fixture's instance (`dc-fidelity.ts`) and the share that matches is at
 * least 99.9% per kind. The million-issue run of the same check is `dc-import.large.test.ts`.
 */
describe('Data Center backup import: tickets and their content (M1-091)', () => {
  const database = useMigratedDatabase();
  let dir = '';
  let manifest: Manifest;
  let world: World;
  let report: FidelityReport;
  let fidelity: DcFidelity;
  let deps: Parameters<typeof runImport>[0];

  const importOnce = async (name: string) => {
    const run = await createRun(database.db, {
      workspaceId: 1,
      userId: null,
      importSource: 'dc-backup',
      system: 'dc',
      name,
      source: { format: 'dc-backup', path: join(dir, 'backup.zip') },
      dryRun: false,
    });
    while ((await runImport(deps, run.id, { until: Date.now() + 60_000, batch: 250 })) === 'more');
    const row = await database.db
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row.status, row.last_error ?? '').toBe('done');
    return fidelityReport.parse(row.report);
  };
  const entity = (kind: string) => report.entities.find((e) => e.kind === kind);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-content-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(dir, 'backup.zip')));
    world = buildWorld(OPTIONS);
    const db = database.db;
    deps = {
      db,
      catalogs: new FieldCatalogs(db),
      formats: IMPORT_FORMATS,
      stores: storesOf(await LocalStore.open(join(dir, 'files'))),
    };
    report = await importOnce('Content');
    fidelity = await dcFidelity(db, world);
  }, 900_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('[IMP-004] [IMP-010] imports every kind of issue content at 99.9% fidelity or more', async () => {
    expect(report.failures).toEqual([]);
    const counts = {
      ticket: manifest.entities.Issue,
      comment: manifest.entities.Action,
      history: manifest.entities.ChangeGroup,
      time_entry: manifest.entities.Worklog,
      link: (manifest.entities.IssueLink ?? 0) - (manifest.cases.subtasks ?? 0),
      web_link: manifest.entities.RemoteIssueLink,
      attachment: manifest.entities.FileAttachment,
    };
    for (const [kind, count] of Object.entries(counts)) {
      expect(entity(kind)?.source, kind).toBe(count);
      expect(entity(kind)?.outcomes.created, kind).toBe(count);
    }
    const checked = Object.fromEntries(fidelity.kinds.map((k) => [k.kind, k.expected]));
    expect(checked).toMatchObject({
      ...counts,
      follower: manifest.cases.watches,
      vote: manifest.cases.votes,
      key_history: manifest.cases.movedIssues,
      starting_value: manifest.entities.Issue,
    });
    // The fixture has every case M1-091 maps.
    for (const c of [
      'commentsForGroup',
      'commentsForRole',
      'commentsEdited',
      'worklogsForGroup',
      'worklogsForRole',
      'anonymousChanges',
      'customFieldChanges',
      'movedIssues',
    ]) {
      expect(manifest.cases[c], c).toBeGreaterThan(0);
    }
    for (const k of fidelity.kinds) {
      expect(k.matched / k.expected, `${k.kind}: ${k.examples.join('\n')}`).toBeGreaterThanOrEqual(
        FIDELITY,
      );
    }
    expect(fidelity.rate).toBeGreaterThanOrEqual(FIDELITY);
    // Every mismatch would be listed here; the report's warnings say what was approximated.
    await expect(
      stableJson({
        fidelity: fidelity.kinds,
        entities: report.entities.map((e) => ({
          kind: e.kind,
          source: e.source,
          outcomes: e.outcomes,
        })),
        warnings: report.warnings
          .filter((w) => w.kind !== 'source')
          .map((w) => ({ kind: w.kind, code: w.code, detail: w.detail, count: w.count })),
        unsupported: report.unsupported,
      }),
    ).toMatchFileSnapshot('./__golden__/dc-content-seed91.fidelity.json');
  });

  it('[IMP-011] [CORE-023] keeps the keys moved tickets had: each still opens the ticket', async () => {
    const moved = [...walkIssues(world)].filter((i) => i.moved);
    expect(moved.length).toBe(manifest.cases.movedIssues);
    for (const i of moved) {
      const now = await resolveTicket(database.db, 1, i.key);
      const before = await resolveTicket(
        database.db,
        1,
        `${i.moved?.project.key}-${i.moved?.number}`,
      );
      expect(now?.id, i.key).toBeGreaterThan(0);
      expect(before?.id, i.key).toBe(now?.id);
    }
  });

  it('[IMP-009] a second run of the same backup changes nothing', async () => {
    const tickets = await database.db
      .selectFrom('ticket_change')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow();
    const again = await importOnce('Content again');
    for (const e of again.entities) {
      expect(e.outcomes.created + e.outcomes.updated + e.outcomes.failed, e.kind).toBe(0);
    }
    const after = await database.db
      .selectFrom('ticket_change')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(tickets.n);
  }, 600_000);

  it('[IMP-010] lists every entity that differs from the fixture', async () => {
    const db = database.db;
    const comment = await db
      .selectFrom('ticket_comment')
      .select('id')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('ticket_comment')
      .set({ body: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }) })
      .where('id', '=', comment.id)
      .execute();
    const follower = await db
      .selectFrom('ticket_follower')
      .selectAll()
      .orderBy('ticket_id')
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom('ticket_follower')
      .where('ticket_id', '=', follower.ticket_id)
      .where('user_id', '=', follower.user_id)
      .execute();
    const changed = await dcFidelity(db, world);
    const kind = (k: string) => changed.kinds.find((x) => x.kind === k);
    expect(kind('comment')?.matched).toBe((kind('comment')?.expected ?? 0) - 1);
    expect(kind('comment')?.examples[0]).toMatch(/: body /);
    expect(kind('follower')?.matched).toBe((kind('follower')?.expected ?? 0) - 1);
    expect(kind('follower')?.examples[0]).toMatch(/missing/);
  });
});
