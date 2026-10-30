import { createDb, type Database } from '@taskmoor/db';
import { migratedTemplate, useMigratedDatabase } from '@taskmoor/db/testing';
import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { fc } from '@taskmoor/testkit/property';
import { type Kysely, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { FieldCatalogs } from '../fields/catalog';
import { IMPORT_FORMATS } from './jobs';
import type { FidelityReport } from './report';
import { createRun, runImport } from './run';
import { SyntheticSource, syntheticFixture } from './synthetic';

/**
 * IMP-009 (1): killing the importer at random points and resuming gives the same final state
 * as an uninterrupted run. Each run imports the same synthetic file into a fresh database; a
 * hook throws before a chosen record (the batch rolls back, as when a worker dies), the run is
 * started again from its checkpoint, and the imported rows are compared with the reference run
 * as a stable snapshot keyed by source ids (target ids may differ: a rolled-back insert still
 * uses up its sequence values).
 */
const FIXTURE = syntheticFixture({ seed: 21, tickets: 18 });
const BATCH = 7;

/** Field names whose history values are ids, and the kind of the id. */
const HISTORY_KINDS: Record<string, string> = {
  track: 'track',
  type: 'ticket_type',
  status: 'status',
  assignee: 'user',
  requester: 'user',
  parent: 'ticket',
  comment: 'comment',
};

async function snapshot(db: Kysely<Database>, runId: string) {
  const run = await db
    .selectFrom('import_run')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();
  const ext = await db
    .selectFrom('import_external_id')
    .select(['entity_kind', 'source_id', 'target_id'])
    .where('source_system', '=', run.source_system)
    .execute();
  const back = new Map(ext.map((e) => [`${e.entity_kind}:${e.target_id}`, e.source_id]));
  const ids = (kind: string) =>
    ext.filter((e) => e.entity_kind === kind).map((e) => Number(e.target_id));
  const as = (kind: string, id: number | string | null) =>
    id === null ? null : (back.get(`${kind}:${id}`) ?? `native:${id}`);
  const historyValue = (field: string, value: string | null) => {
    if (value === null) return null;
    // Rank keys come from a sequence that a rolled-back batch also advances: their order is
    // what an import keeps, so the snapshot names them by position.
    if (field === 'rank') return ranks.get(value) ?? 'other';
    if (field === 'link') {
      const [type, direction, other] = value.split(':');
      return `${linkTypes.get(Number(type))}:${direction}:${as('ticket', other ?? '')}`;
    }
    const kind = HISTORY_KINDS[field];
    return kind ? as(kind, value) : value;
  };
  const none = [-1];

  const users = await db
    .selectFrom('app_user')
    .select(['id', 'email', 'name', 'time_zone', 'deactivated_at'])
    .where('id', 'in', [...ids('user'), ...none])
    .execute();
  const members = await db
    .selectFrom('group_member')
    .select(['group_id', 'user_id'])
    .where('group_id', 'in', [...ids('group'), ...none])
    .execute();
  const tickets = await db
    .selectFrom('ticket')
    .selectAll()
    .where('id', 'in', [...ids('ticket'), ...none])
    .orderBy('rank')
    .execute();
  const ranks = new Map(tickets.map((t, i) => [t.rank, `rank#${i}`]));
  // Link types the import created have no external id: they are named by name.
  const linkTypes = new Map(
    (await db.selectFrom('link_type').select(['id', 'name']).execute()).map((t) => [t.id, t.name]),
  );
  const changes = await db
    .selectFrom('ticket_change')
    .select([
      'ticket_id',
      'at',
      'actor_id',
      'field',
      'from_value',
      'to_value',
      'from_display',
      'to_display',
    ])
    .where('ticket_id', 'in', [...ids('ticket'), ...none])
    .orderBy('ticket_id')
    .orderBy('at')
    .orderBy('id')
    .execute();
  const comments = await db
    .selectFrom('ticket_comment')
    .select(['id', 'ticket_id', 'author_id', 'body', 'visible_group_id', 'created_at'])
    .where('id', 'in', [...ids('comment'), ...none])
    .execute();
  const links = await db
    .selectFrom('ticket_link as l')
    .innerJoin('link_type as t', 't.id', 'l.link_type_id')
    .select(['l.id', 't.name', 'l.source_id', 'l.target_id', 'l.created_at'])
    .where('l.id', 'in', [...ids('link'), ...none])
    .execute();
  const entries = await db
    .selectFrom('time_entry')
    .select(['id', 'ticket_id', 'author_id', 'started_at', 'duration', 'description'])
    .where('id', 'in', [...ids('time_entry'), ...none])
    .execute();
  const counters = await db
    .selectFrom('ticket_counter')
    .select(['track_id', 'last_number'])
    .where('track_id', 'in', [...ids('track'), ...none])
    .execute();
  const changeLog = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM change_log
     WHERE entity = 'ticket' AND entity_id = ANY(${[...ids('ticket'), ...none]}::int[])`.execute(
    db,
  );
  const records = await db
    .selectFrom('import_record')
    .select(['entity_kind', 'source_id', 'outcome', 'sampled', 'error'])
    .where('run_id', '=', runId)
    .orderBy('entity_kind')
    .orderBy('source_id')
    .execute();
  const report = run.report as unknown as FidelityReport;
  const byKey = <T>(rows: T[], key: (r: T) => string) =>
    rows.map((r) => [key(r), r] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    status: run.status,
    checkpoint: run.checkpoint,
    tallies: run.tallies,
    warnings: run.warnings,
    unsupported: run.unsupported,
    batches: run.batches,
    records,
    externalIds: ext.map((e) => `${e.entity_kind}:${e.source_id}`).sort(),
    users: byKey(users, (u) => as('user', u.id) as string).map(([k, u]) => ({
      k,
      email: u.email,
      name: u.name,
      timeZone: u.time_zone,
      active: u.deactivated_at === null,
    })),
    members: members.map((m) => `${as('group', m.group_id)}:${as('user', m.user_id)}`).sort(),
    // In rank order: imports keep the order they made tickets in.
    tickets: tickets.map((t) => ({
      k: as('ticket', t.id),
      track: as('track', t.track_id),
      number: t.number,
      type: as('ticket_type', t.ticket_type_id),
      status: as('status', t.status_id),
      parent: as('ticket', t.parent_id),
      assignee: as('user', t.assignee_id),
      requester: as('user', t.requester_id),
      creator: as('user', t.creator_id),
      summary: t.summary,
      description: t.description,
      labels: t.labels,
      priority: t.priority_id,
      dates: [t.start_date, t.due_date, t.created_at.toISOString(), t.updated_at.toISOString()],
      closedAt: t.closed_at?.toISOString() ?? null,
      estimates: [t.original_estimate, t.remaining_estimate, t.time_spent],
      fields: t.fields,
      version: t.version,
    })),
    history: changes.map((c) => ({
      ticket: as('ticket', c.ticket_id),
      at: c.at.toISOString(),
      actor: as('user', c.actor_id),
      field: c.field,
      from: historyValue(c.field, c.from_value),
      to: historyValue(c.field, c.to_value),
      display: [c.from_display, c.to_display],
    })),
    comments: byKey(comments, (c) => as('comment', c.id) as string).map(([k, c]) => ({
      k,
      ticket: as('ticket', c.ticket_id),
      author: as('user', c.author_id),
      group: as('group', c.visible_group_id),
      body: c.body,
      at: c.created_at.toISOString(),
    })),
    links: byKey(links, (l) => as('link', l.id) as string).map(([k, l]) => ({
      k,
      type: l.name,
      source: as('ticket', l.source_id),
      target: as('ticket', l.target_id),
      at: l.created_at.toISOString(),
    })),
    timeEntries: byKey(entries, (e) => as('time_entry', e.id) as string).map(([k, e]) => ({
      k,
      ticket: as('ticket', e.ticket_id),
      author: as('user', e.author_id),
      at: e.started_at.toISOString(),
      duration: e.duration,
      description: e.description,
    })),
    counters: counters.map((c) => `${as('track', c.track_id)}:${c.last_number}`).sort(),
    changeLogRows: changeLog.rows[0]?.n,
    report: {
      ...report,
      run: { ...report.run, id: 0, startedAt: null, finishedAt: '' },
      // Checksums cover resolved target ids; whether they match is what counts here.
      samples: report.samples.map((s) => ({ kind: s.kind, sourceId: s.sourceId, match: s.match })),
      // Target ids by the source record they came from: rolled-back batches use up ids.
      mapping: report.mapping.map((m) => ({ ...m, targetId: as(m.kind, m.targetId) })),
    },
  };
}

/**
 * Imports the fixture into a fresh database. `kills` are ordinals of record attempts (counted
 * across restarts) before which the hook throws; `parts` makes every batch its own job part.
 */
async function importFresh(kills: readonly number[], parts: boolean) {
  const created = await createDatabase(testPgAdminUrl(), { template: migratedTemplate.name });
  const db = createDb({ connectionString: created.url, maxConnections: 3 });
  try {
    const deps = { db, catalogs: new FieldCatalogs(db), formats: IMPORT_FORMATS };
    const run = await createRun(db, {
      workspaceId: 1,
      userId: null,
      importSource: 'synthetic',
      system: new SyntheticSource(FIXTURE).system,
      name: 'resume',
      source: { format: 'synthetic', data: FIXTURE },
      dryRun: false,
    });
    const pending = new Set(kills);
    let attempt = 0;
    let restarts = 0;
    for (let guard = 0; guard < 500; guard++) {
      try {
        const state = await runImport(deps, run.id, {
          until: parts ? 0 : Number.POSITIVE_INFINITY,
          batch: BATCH,
          beforeRecord: () => {
            attempt += 1;
            if (pending.delete(attempt)) throw new Error('killed');
          },
        });
        if (state === 'finished') break;
      } catch (error) {
        expect((error as Error).message).toBe('killed');
        restarts += 1;
      }
    }
    return { snapshot: await snapshot(db, run.id), restarts, attempts: attempt };
  } finally {
    await db.destroy();
    await created.drop();
  }
}

describe('kill and resume (M1-086)', () => {
  // Makes sure the migrated template exists; each run clones its own database from it.
  useMigratedDatabase();

  it('[IMP-009] an import killed at random points and resumed ends as an uninterrupted one', async () => {
    const reference = await importFresh([], false);
    expect(reference.restarts).toBe(0);
    expect(reference.snapshot.status).toBe('done');
    expect(reference.snapshot.report.failures).toEqual([]);
    expect(reference.snapshot.tickets.length).toBe(18);
    const total = reference.attempts;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: total }), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        async (kills, parts) => {
          const resumed = await importFresh(kills, parts);
          expect(resumed.restarts).toBe(kills.length);
          expect(resumed.snapshot).toEqual(reference.snapshot);
        },
      ),
      { numRuns: Math.min(8, Number(process.env.FC_RUNS ?? 8)) },
    );
  }, 300_000);
});
