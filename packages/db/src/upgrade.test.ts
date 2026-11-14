import { readFileSync } from 'node:fs';
import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { knownMigrations, migrateTo, migrateToLatest, migrationStatus } from './migrate';
import { up } from './migrations/0107_workflows_left_without_moves';
import { snapshotSchema } from './snapshot';
import { seededRows, UPGRADE_SEEDS } from './upgrade-fixtures';

/**
 * The upgrade harness (M0-029, OPS-006): a database left at each of the last three releases,
 * holding that release's data, is upgraded to the current code and must end with the reviewed
 * schema and every seeded row. Zero manual steps: start the new release and it migrates.
 */
const golden = JSON.parse(
  readFileSync(new URL('./__golden__/schema.json', import.meta.url), 'utf8'),
);
const all = knownMigrations();
const latest = all[all.length - 1] as string;
const starts = all.slice(Math.max(0, all.length - 4), -1);

describe('upgrade from earlier releases', () => {
  it('knows a seed for every migration, so new tables are exercised', () => {
    for (const name of all) expect(UPGRADE_SEEDS, name).toHaveProperty(name);
  });

  for (const start of starts) {
    describe(`from ${start}`, () => {
      let database: Awaited<ReturnType<typeof createDatabase>>;
      let db: ReturnType<typeof createDb>;

      beforeAll(async () => {
        database = await createDatabase(testPgAdminUrl());
        db = createDb({ connectionString: database.url, maxConnections: 2 });
        // Each seed runs right after its own migration, with the schema it was written for: a
        // later migration may drop a column an earlier seed writes (0042 dropped
        // track.workflow_id, which the 0024 seed sets).
        for (const name of all.slice(0, all.indexOf(start) + 1)) {
          await migrateTo(db, name);
          await UPGRADE_SEEDS[name]?.seed(db as never);
        }
      });
      afterAll(async () => {
        await db.destroy();
        await database.drop();
      });

      it(`[OPS-006] applies exactly the newer migrations up to ${latest}`, async () => {
        const before = await migrationStatus(db);
        expect(before.applied[before.applied.length - 1]).toBe(start);
        expect(before.unknown).toEqual([]);
        const applied = await migrateToLatest(db);
        expect(applied).toEqual(all.slice(all.indexOf(start) + 1));
        expect((await migrationStatus(db)).pending).toEqual([]);
      });

      it('lands on the reviewed schema with every seeded row intact', async () => {
        expect(await snapshotSchema(db)).toEqual(golden);
        const rows = await seededRows(db as never, all.slice(0, all.indexOf(start) + 1));
        expect(Object.keys(rows).length).toBeGreaterThan(0);
        for (const [table, n] of Object.entries(rows)) expect(n, table).toBe(1);
      });
    });
  }

  describe('the default workflow moves freely (0089)', () => {
    const atDefault = async (db: ReturnType<typeof createDb>) => {
      const { rows } = await sql<{
        published_version: number;
        id: number;
        definition: {
          transitions: { id: number; name: string; from: unknown; layout?: unknown }[];
        };
      }>`
        SELECT w.id, w.published_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.is_default`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const atBefore0089 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0088_one_board_per_track');
      return { database, db };
    };

    it('[WF-008] gives a default workflow nobody changed its second version', async () => {
      const { database, db } = await atBefore0089();
      try {
        await migrateToLatest(db);
        const { published_version, definition } = await atDefault(db);
        expect(published_version).toBe(2);
        expect(definition.transitions.map((t) => [t.id, t.name, t.from, t.layout])).toEqual([
          [5, 'New', 'any', undefined],
          [1, 'Active', 'any', undefined],
          [2, 'In Review', 'any', undefined],
          [4, 'Closed', 'any', undefined],
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] leaves a default workflow an administrator edited with its own rules', async () => {
      const { database, db } = await atBefore0089();
      try {
        const before = await atDefault(db);
        await sql`
          INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
          VALUES (1, ${before.id}, 2, ${JSON.stringify(before.definition)}, now())`.execute(db);
        await sql`
          INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
          SELECT workspace_id, workflow_id, 2, status_id FROM workflow_version_status
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await sql`UPDATE workflow SET published_version = 2 WHERE id = ${before.id}`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(2);
        expect(after.definition).toEqual(before.definition);
        expect(after.definition.transitions.find((t) => t.name === 'Close')?.layout).toEqual([
          'close-reason',
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  describe('the default workflow 0089 left strict (0104)', () => {
    const FREE = [
      [5, 'any', undefined],
      [1, 'any', undefined],
      [2, 'any', undefined],
      [4, 'any', undefined],
    ];
    const atDefault = async (db: ReturnType<typeof createDb>) => {
      const { rows } = await sql<{
        id: number;
        published_version: number;
        draft_version: number | null;
        definition: {
          transitions: { id: number; name: string; from: unknown; layout?: unknown }[];
        };
      }>`
        SELECT w.id, w.published_version, w.draft_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.is_default`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const atBefore0089 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0088_one_board_per_track');
      return { database, db };
    };

    it('[WF-008] gives a default workflow whose status was renamed its free-moving version', async () => {
      const { database, db } = await atBefore0089();
      try {
        await sql`UPDATE status SET name = 'Review' WHERE name = 'In Review'`.execute(db);
        await migrateToLatest(db);
        const { published_version, definition } = await atDefault(db);
        expect(published_version).toBe(2);
        expect(definition.transitions.map((t) => [t.id, t.from, t.layout])).toEqual(FREE);
        expect(definition.transitions.map((t) => t.name)).toEqual([
          'New',
          'Active',
          'Review',
          'Closed',
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] publishes under an open draft and keeps the draft as its author saved it', async () => {
      const { database, db } = await atBefore0089();
      try {
        const before = await atDefault(db);
        const saved = { ...before.definition, description: undefined };
        await sql`
          INSERT INTO workflow_version (workspace_id, workflow_id, version, definition)
          VALUES (1, ${before.id}, 2, ${JSON.stringify(saved)})`.execute(db);
        await sql`
          INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
          SELECT workspace_id, workflow_id, 2, status_id FROM workflow_version_status
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await sql`UPDATE workflow SET draft_version = 2 WHERE id = ${before.id}`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(2);
        expect(after.draft_version).toBe(3);
        expect(after.definition.transitions.map((t) => [t.id, t.from, t.layout])).toEqual(FREE);
        const { rows } = await sql<{ definition: unknown }>`
          SELECT definition FROM workflow_version
           WHERE workflow_id = ${before.id} AND version = 3`.execute(db);
        expect(rows[0]?.definition).toEqual(before.definition);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] leaves version 1 when it is no longer what the seed wrote', async () => {
      const { database, db } = await atBefore0089();
      try {
        await sql`UPDATE status SET name = 'Review' WHERE name = 'In Review'`.execute(db);
        const before = await atDefault(db);
        const edited = {
          ...before.definition,
          transitions: before.definition.transitions.map((t) =>
            t.id === 1 ? { ...t, name: 'Begin' } : t,
          ),
        };
        await sql`
          UPDATE workflow_version SET definition = ${JSON.stringify(edited)}
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(1);
        expect(after.definition).toEqual(edited);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  describe('a close reason deleted while a workflow set it (0105)', () => {
    interface Stored {
      transitions: {
        id: number;
        to: number;
        effects?: { type: string; field?: string; value?: unknown }[];
      }[];
    }
    const atDefault = async (db: ReturnType<typeof createDb>) => {
      const { rows } = await sql<{
        id: number;
        published_version: number;
        definition: Stored;
      }>`
        SELECT w.id, w.published_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.is_default`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const reasonSet = (definition: Stored) =>
      definition.transitions
        .flatMap((t) => t.effects ?? [])
        .filter((e) => e.type === 'update-system-field')
        .map((e) => e.value);
    const reasonsNamed = async (db: ReturnType<typeof createDb>, name: string) =>
      (
        await sql<{ id: number }>`
          SELECT id FROM close_reason WHERE lower(name) = ${name}`.execute(db)
      ).rows.map((r) => r.id);
    const before0105 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0104_default_workflow_left_strict');
      return { database, db };
    };

    it('[WF-008] gives the published version and the draft Completed again, made if it is gone', async () => {
      const { database, db } = await before0105();
      try {
        const before = await atDefault(db);
        const version = before.published_version;
        const old = (await reasonsNamed(db, 'completed'))[0] as number;
        expect(reasonSet(before.definition)).toEqual([String(old)]);
        await sql`
          INSERT INTO workflow_version (workspace_id, workflow_id, version, definition)
          VALUES (1, ${before.id}, ${version + 1}, ${JSON.stringify(before.definition)})`.execute(
          db,
        );
        await sql`UPDATE workflow SET draft_version = ${version + 1} WHERE id = ${before.id}`.execute(
          db,
        );
        await sql`DELETE FROM close_reason WHERE id = ${old}`.execute(db);

        await migrateToLatest(db);

        const made = await reasonsNamed(db, 'completed');
        expect(made).toHaveLength(1);
        expect(made[0]).not.toBe(old);
        const { rows } = await sql<{ definition: Stored }>`
          SELECT definition FROM workflow_version
           WHERE workflow_id = ${before.id} AND version IN (${version}, ${version + 1})`.execute(
          db,
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(reasonSet(row.definition)).toEqual([String(made[0])]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] names the Completed that is there, and leaves a version whose reason exists', async () => {
      const { database, db } = await before0105();
      try {
        const before = await atDefault(db);
        const completed = await reasonsNamed(db, 'completed');
        const notPlanned = (await reasonsNamed(db, 'not planned'))[0] as number;
        const setNotPlanned = {
          ...before.definition,
          transitions: before.definition.transitions.map((t) =>
            t.effects?.some((e) => e.type === 'update-system-field')
              ? {
                  ...t,
                  effects: [
                    {
                      type: 'update-system-field',
                      field: 'close-reason',
                      value: String(notPlanned),
                    },
                  ],
                }
              : t,
          ),
        };
        // An earlier version keeps what it was written with; the published one has the gone reason.
        const earlier = before.published_version - 1;
        const { rows: written } = await sql<{ definition: Stored }>`
          SELECT definition FROM workflow_version
           WHERE workflow_id = ${before.id} AND version = ${earlier}`.execute(db);
        await sql`
          UPDATE workflow_version SET definition = ${JSON.stringify(setNotPlanned)}
           WHERE workflow_id = ${before.id} AND version = ${before.published_version}`.execute(db);
        await sql`DELETE FROM close_reason WHERE id = ${notPlanned}`.execute(db);

        await migrateToLatest(db);

        expect(await reasonsNamed(db, 'completed')).toEqual(completed);
        const after = await atDefault(db);
        expect(after.published_version).toBe(before.published_version);
        expect(reasonSet(after.definition)).toEqual([String(completed[0])]);
        const { rows: kept } = await sql<{ definition: Stored }>`
          SELECT definition FROM workflow_version
           WHERE workflow_id = ${before.id} AND version = ${earlier}`.execute(db);
        expect(kept[0]?.definition).toEqual(written[0]?.definition);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] changes nothing where every reason still exists', async () => {
      const { database, db } = await before0105();
      try {
        const before = await atDefault(db);
        await migrateToLatest(db);
        expect(await atDefault(db)).toEqual(before);
        expect(await reasonsNamed(db, 'completed')).toHaveLength(1);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  describe('old workflows left with no moves (0107)', () => {
    interface Stored {
      initialStatusId: number;
      statuses: { statusId: number }[];
      transitions: {
        id: number;
        name: string;
        from: unknown;
        to: number;
        effects?: { type: string; field?: string; value?: unknown }[];
      }[];
      rules?: Record<string, unknown[]>;
      board?: unknown;
    }
    type Db = ReturnType<typeof createDb>;
    const CLEAR = [{ type: 'clear-field', field: 'close-reason' }];
    const setting = (reason: number) => [
      { type: 'update-system-field', field: 'close-reason', value: String(reason) },
    ];
    const before0107 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0106_cross_track_releases');
      return { database, db };
    };
    const idOf = async (db: Db, table: 'status' | 'close_reason', name: string) =>
      (
        await sql<{ id: number }>`
          SELECT id FROM ${sql.table(table)} WHERE workspace_id = 1 AND name = ${name}`.execute(db)
      ).rows[0]?.id as number;
    const writeVersion = async (
      db: Db,
      workflowId: number,
      version: number,
      definition: Stored,
      at: string | null = null,
    ) => {
      await sql`
        INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, created_at)
        VALUES (1, ${workflowId}, ${version}, ${JSON.stringify(definition)},
                coalesce(${at}::timestamptz, now()))`.execute(db);
      await sql`
        INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
        SELECT 1, ${workflowId}, ${version}, unnest(${definition.statuses.map((s) => s.statusId)}::int[])`.execute(
        db,
      );
    };
    /** A workflow as an old release left it: its published version has no transitions. */
    const leftEmpty = async (
      db: Db,
      name: string,
      statusIds: number[],
      extra: Partial<Stored> = {},
    ) => {
      const made = await sql<{ id: number }>`
        INSERT INTO workflow (workspace_id, name) VALUES (1, ${name}) RETURNING id`.execute(db);
      const id = made.rows[0]?.id as number;
      const definition: Stored = {
        initialStatusId: statusIds[0] as number,
        statuses: statusIds.map((statusId) => ({ statusId })),
        transitions: [],
        ...extra,
      };
      await writeVersion(db, id, 1, definition);
      return { id, definition };
    };
    const current = async (db: Db, id: number) => {
      const { rows } = await sql<{
        published_version: number;
        draft_version: number | null;
        definition: Stored;
      }>`
        SELECT w.published_version, w.draft_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.id = ${id}`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const versionRow = async (db: Db, id: number, version: number) =>
      (
        await sql<{ definition: Stored; created_at: Date; published_at: Date | null }>`
          SELECT definition, created_at, published_at FROM workflow_version
           WHERE workflow_id = ${id} AND version = ${version}`.execute(db)
      ).rows[0];
    const statusesOf = async (db: Db, id: number, version: number) =>
      (
        await sql<{ status_id: number }>`
          SELECT status_id FROM workflow_version_status
           WHERE workflow_id = ${id} AND version = ${version} ORDER BY status_id`.execute(db)
      ).rows.map((r) => r.status_id);

    it('[WF-008] gives an old workflow with no transitions a move into each status as its next published version', async () => {
      const { database, db } = await before0107();
      try {
        const [fresh, active, closed] = [
          await idOf(db, 'status', 'New'),
          await idOf(db, 'status', 'Active'),
          await idOf(db, 'status', 'Closed'),
        ];
        const completed = await idOf(db, 'close_reason', 'Completed');
        // An earlier version used transition id 7; version 2 was published with none.
        const { id, definition } = await leftEmpty(db, 'Left empty', [fresh, active, closed], {
          transitions: [{ id: 7, name: 'Start', from: [fresh], to: active }],
        });
        await writeVersion(db, id, 2, { ...definition, transitions: [] });
        await sql`UPDATE workflow SET published_version = 2 WHERE id = ${id}`.execute(db);
        // A draft someone saved stays theirs.
        const saved = { ...definition, statuses: [{ statusId: fresh }, { statusId: active }] };
        await writeVersion(db, id, 3, saved, '2026-10-01T09:00:00Z');
        await sql`UPDATE workflow SET draft_version = 3 WHERE id = ${id}`.execute(db);

        await migrateToLatest(db);

        const after = await current(db, id);
        // The new version takes the draft's number; the draft moves above it.
        expect(after.published_version).toBe(3);
        expect(after.draft_version).toBe(4);
        expect(after.definition).toEqual({
          ...definition,
          transitions: [
            { id: 8, name: 'New', from: 'any', to: fresh, effects: CLEAR },
            { id: 9, name: 'Active', from: 'any', to: active, effects: CLEAR },
            { id: 10, name: 'Closed', from: 'any', to: closed, effects: setting(completed) },
          ],
        });
        expect((await versionRow(db, id, 3))?.published_at).not.toBeNull();
        expect(await statusesOf(db, id, 3)).toEqual([fresh, active, closed].sort((a, b) => a - b));
        const draft = await versionRow(db, id, 4);
        expect(draft?.definition).toEqual(saved);
        expect(draft?.created_at.toISOString()).toBe('2026-10-01T09:00:00.000Z');
        expect(draft?.published_at).toBeNull();
        expect(await statusesOf(db, id, 4)).toEqual([fresh, active].sort((a, b) => a - b));
        // Earlier versions stay as they were written.
        expect((await versionRow(db, id, 2))?.definition.transitions).toEqual([]);
        expect((await versionRow(db, id, 1))?.definition).toEqual(definition);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] closes with the reason the default workflow sets once Completed was renamed, and gives a closing status nothing when there is no reason to name', async () => {
      const { database, db } = await before0107();
      try {
        const fresh = await idOf(db, 'status', 'New');
        const closed = await idOf(db, 'status', 'Closed');
        const completed = await idOf(db, 'close_reason', 'Completed');
        await sql`UPDATE close_reason SET name = 'Done' WHERE id = ${completed}`.execute(db);
        const renamed = await leftEmpty(db, 'Renamed reason', [fresh, closed]);
        // Nothing a free move could close with: the default workflow sets no reason either.
        const { rows } = await sql<{ id: number; published_version: number; definition: Stored }>`
          SELECT w.id, w.published_version, v.definition FROM workflow w
            JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
           WHERE w.is_default`.execute(db);
        const fallback = rows[0] as NonNullable<(typeof rows)[0]>;
        await up(db as never);
        expect((await current(db, renamed.id)).definition.transitions).toEqual([
          { id: 1, name: 'New', from: 'any', to: fresh, effects: CLEAR },
          { id: 2, name: 'Closed', from: 'any', to: closed, effects: setting(completed) },
        ]);

        await sql`
          UPDATE workflow_version
             SET definition = ${JSON.stringify({
               ...fallback.definition,
               transitions: fallback.definition.transitions.map((t) => ({ ...t, effects: [] })),
             })}
           WHERE workflow_id = ${fallback.id} AND version = ${fallback.published_version}`.execute(
          db,
        );
        const partly = await leftEmpty(db, 'Partly', [fresh, closed]);
        const closingOnly = await leftEmpty(db, 'Closing only', [closed]);
        const reasons = await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM close_reason`.execute(db);
        await up(db as never);
        expect((await current(db, partly.id)).definition.transitions).toEqual([
          { id: 1, name: 'New', from: 'any', to: fresh, effects: CLEAR },
        ]);
        // No move at all: it stays as it was, for the operator's check to list.
        expect(await current(db, closingOnly.id)).toEqual({
          published_version: 1,
          draft_version: null,
          definition: closingOnly.definition,
        });
        // No reason is made.
        expect(
          (await sql<{ n: number }>`SELECT count(*)::int AS n FROM close_reason`.execute(db))
            .rows[0]?.n,
        ).toBe(reasons.rows[0]?.n);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] leaves a board-managed workflow, one with a rule and one that has moves', async () => {
      const { database, db } = await before0107();
      try {
        const fresh = await idOf(db, 'status', 'New');
        const active = await idOf(db, 'status', 'Active');
        const board = await leftEmpty(db, 'Board managed', [fresh, active], {
          board: { boardId: 1, columns: [fresh, active] },
        });
        const ruled = await leftEmpty(db, 'With a rule', [fresh, active], {
          rules: { '1': [{ type: 'clear-field', field: 'close-reason' }] },
        });
        const moving = await leftEmpty(db, 'Moving', [fresh, active], {
          transitions: [{ id: 1, name: 'Start', from: [fresh], to: active }],
        });
        const before = await Promise.all([board, ruled, moving].map((w) => current(db, w.id)));
        await migrateToLatest(db);
        expect(await Promise.all([board, ruled, moving].map((w) => current(db, w.id)))).toEqual(
          before,
        );
        for (const w of [board, ruled, moving]) {
          expect((await current(db, w.id)).published_version).toBe(1);
        }
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  describe('who wrote a checklist item’s words (0116)', () => {
    it('[CORE-033] names the last person who rewrote an item from its events, and nobody for an item never rewritten', async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      try {
        for (const name of all.slice(0, all.indexOf('0107_workflows_left_without_moves') + 1)) {
          await migrateTo(db, name);
          await UPGRADE_SEEDS[name]?.seed(db as never);
        }
        const person = async (email: string) =>
          (
            await sql<{ id: number }>`
              INSERT INTO app_user (workspace_id, email, name, password_hash)
              VALUES (1, ${email}, ${email}, 'scrypt$x') RETURNING id`.execute(db)
          ).rows[0]?.id as number;
        const first = await person('first@example.com');
        const last = await person('last@example.com');
        const items = await sql<{ id: number; checklist_id: number }>`
          INSERT INTO ticket_checklist_item (workspace_id, checklist_id, text, position)
          SELECT 1, c.id, w.text, w.position FROM ticket_checklist c,
                 (VALUES ('Rewritten twice', 1), ('Ticked only', 2)) AS w (text, position)
           WHERE c.name = 'Seed checklist'
          ORDER BY w.position
          RETURNING id, checklist_id`.execute(db);
        const [twice, ticked] = items.rows as [
          { id: number; checklist_id: number },
          { id: number; checklist_id: number },
        ];
        const event = (actor: number, change: string, itemId: number | null, at: string) =>
          sql`
          INSERT INTO domain_event (workspace_id, type, actor_id, subject_type, subject_id,
              payload, occurred_at)
          VALUES (1, 'ticket.checklist_changed', ${actor}, 'ticket', '1',
                  ${JSON.stringify({ change, checklistId: twice.checklist_id, itemId })}::jsonb,
                  ${at}::timestamptz)`.execute(db);
        await event(first, 'item_edited', twice.id, '2026-11-01T10:00:00Z');
        await event(last, 'item_edited', twice.id, '2026-11-02T10:00:00Z');
        // A later tick by someone else leaves the words as their last writer left them.
        await event(first, 'item_state', twice.id, '2026-11-03T10:00:00Z');
        await event(first, 'item_state', ticked.id, '2026-11-03T10:00:00Z');
        // A list renamed names no item.
        await event(first, 'checklist_renamed', null, '2026-11-03T10:00:00Z');

        await migrateTo(db, '0116_checklist_item_edited_by');
        const { rows } = await sql<{ text: string; edited_by: number | null }>`
          SELECT text, edited_by FROM ticket_checklist_item ORDER BY position`.execute(db);
        expect(rows).toEqual([
          { text: 'Seed item', edited_by: null },
          { text: 'Rewritten twice', edited_by: last },
          { text: 'Ticked only', edited_by: null },
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  it('[OPS-006] reports a database migrated by a newer release as unknown', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: database.url, maxConnections: 1 });
    try {
      await migrateToLatest(db);
      await db
        .insertInto('schema_migration' as never)
        .values({ name: '9999_from_the_future', timestamp: new Date().toISOString() } as never)
        .execute();
      const status = await migrationStatus(db);
      expect(status.unknown).toEqual(['9999_from_the_future']);
      expect(status.pending).toEqual([]);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });
});
