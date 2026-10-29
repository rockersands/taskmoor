import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { type Kysely, sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus, emit, startWorker, withEvent } from './bus';
import type { DomainEvent } from './catalogue';
import { claim, enqueue, JobRunner, releaseStale } from './queue';

describe('domain event bus and job queue (M1-005, ADR-015)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  const ctx = { workspaceId: 1, actorId: null };

  beforeEach(async () => {
    db = database.db;
    await db.deleteFrom('job').execute();
    await db.deleteFrom('domain_event').execute();
  });

  const eventCount = async () =>
    Number(
      (
        await db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('[AUT-010] records an event exactly when its transaction commits', async () => {
    await withEvent(db, ctx, async () => ({
      result: null,
      event: { type: 'group.created', subjectId: 1, payload: { name: 'Kept' } },
    }));
    await expect(
      db.transaction().execute(async (trx) => {
        await emit(trx, ctx, { type: 'group.created', subjectId: 2, payload: { name: 'Lost' } });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await eventCount()).toBe(1);
    const row = await db.selectFrom('domain_event').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      type: 'group.created',
      subject_type: 'group',
      subject_id: '1',
      payload: { name: 'Kept' },
      published_at: null,
    });
  });

  it('refuses a payload the catalogue does not describe', async () => {
    await expect(
      emit(db, ctx, {
        type: 'group.created',
        subjectId: 1,
        payload: { name: 3 } as unknown as { name: string },
      }),
    ).rejects.toThrow();
    expect(await eventCount()).toBe(0);
  });

  it('[AUT-010] hands every event to each interested subscriber once, even when relayed again', async () => {
    const seen: Record<string, string[]> = { all: [], groups: [], users: [] };
    const bus = new EventBus(db);
    bus.subscribe({ name: 'all', types: '*', handle: async (e) => void seen.all?.push(e.type) });
    bus.subscribe({
      name: 'groups',
      types: ['group.created'],
      handle: async (e) => void seen.groups?.push(e.type),
    });
    bus.subscribe({
      name: 'users',
      types: ['user.created'],
      handle: async (e) => void seen.users?.push(e.type),
    });
    await emit(db, ctx, { type: 'group.created', subjectId: 1, payload: { name: 'A' } });
    await emit(db, ctx, { type: 'role.created', subjectId: 2, payload: { name: 'B' } });
    expect(await bus.relayOnce()).toBe(2);
    // A relay that crashed after enqueueing would leave events unpublished: the keys absorb it.
    await db.updateTable('domain_event').set({ published_at: null }).execute();
    expect(await bus.relayOnce()).toBe(2);
    const runner = new JobRunner(db, 'test');
    bus.attach(runner);
    while ((await runner.runOnce()) > 0) {}
    expect(seen).toEqual({
      all: ['group.created', 'role.created'],
      groups: ['group.created'],
      users: [],
    });
  });

  it('[AUT-010] retries a failing job with backoff, keeps the error and gives up at the maximum', async () => {
    await enqueue(db, [{ workspaceId: 1, task: 'flaky', key: 'flaky-1', maxAttempts: 2 }]);
    const runner = new JobRunner(db, 'test');
    let calls = 0;
    runner.handle('flaky', async () => {
      calls++;
      throw new Error(`attempt ${calls} failed`);
    });
    expect(await runner.runOnce()).toBe(0);
    let job = await db.selectFrom('job').selectAll().executeTakeFirstOrThrow();
    expect(job).toMatchObject({ attempts: 1, last_error: 'attempt 1 failed', done_at: null });
    expect(job.run_at.getTime()).toBeGreaterThan(Date.now());
    await db
      .updateTable('job')
      .set({ run_at: new Date(Date.now() - 1000) })
      .execute();
    await runner.runOnce();
    job = await db.selectFrom('job').selectAll().executeTakeFirstOrThrow();
    expect(job.attempts).toBe(2);
    expect(job.done_at).not.toBeNull();
    expect(job.last_error).toBe('attempt 2 failed');
    // A job's key outlives completion: the same work is never queued twice.
    expect(await enqueue(db, [{ workspaceId: 1, task: 'flaky', key: 'flaky-1' }])).toBe(0);
  });

  it('runs again the jobs of a worker that died while holding them', async () => {
    await enqueue(db, [{ workspaceId: 1, task: 'slow', key: 'slow-1' }]);
    expect(await claim(db, 'doomed', 10)).toHaveLength(1);
    expect(await claim(db, 'other', 10)).toHaveLength(0);
    await db
      .updateTable('job')
      .set({ locked_at: new Date(Date.now() - 20 * 60_000) })
      .execute();
    expect(await releaseStale(db, 10 * 60_000)).toBe(1);
    expect(await claim(db, 'other', 10)).toHaveLength(1);
  });

  it('a runner for some tasks leaves every other job alone', async () => {
    await enqueue(db, [
      { workspaceId: 1, task: 'mine', key: 'mine-1' },
      { workspaceId: 1, task: 'theirs', key: 'theirs-1' },
    ]);
    const runner = new JobRunner(db, 'some', { tasks: ['mine'] });
    const ran: string[] = [];
    runner.handle('mine', async (job) => {
      ran.push(job.task);
    });
    expect(await runner.runOnce()).toBe(1);
    expect(ran).toEqual(['mine']);
    const theirs = await db
      .selectFrom('job')
      .selectAll()
      .where('task', '=', 'theirs')
      .executeTakeFirstOrThrow();
    expect(theirs).toMatchObject({ attempts: 0, locked_at: null, done_at: null, last_error: null });
    expect(await claim(db, 'other', 10)).toHaveLength(1);
  });

  it('[AUT-010] delivers each event once with two relays and two runners at work', async () => {
    const delivered = new Map<string, number>();
    const bus = new EventBus(db);
    bus.subscribe({
      name: 'counter',
      types: '*',
      handle: async (e: DomainEvent) => void delivered.set(e.id, (delivered.get(e.id) ?? 0) + 1),
    });
    for (let i = 0; i < 300; i++) {
      await emit(db, ctx, { type: 'group.created', subjectId: i + 1, payload: { name: `g${i}` } });
    }
    const runners = [new JobRunner(db, 'r1'), new JobRunner(db, 'r2')];
    for (const r of runners) bus.attach(r);
    const relay = async () => {
      while ((await bus.relayOnce(50)) > 0) {}
    };
    await Promise.all([relay(), relay()]);
    const run = async (r: JobRunner) => {
      while ((await r.runOnce(20)) > 0) {}
    };
    await Promise.all(runners.map(run));
    expect(delivered.size).toBe(300);
    expect([...delivered.values()].every((n) => n === 1)).toBe(true);
    const { rows } = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM job WHERE done_at IS NULL`.execute(db);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('[AUT-010] the worker loop delivers an event end to end', async () => {
    const bus = new EventBus(db);
    const got: string[] = [];
    let resolve: () => void = () => {};
    const arrived = new Promise<void>((r) => {
      resolve = r;
    });
    bus.subscribe({
      name: 'probe',
      types: ['role.created'],
      handle: async (e) => {
        got.push(e.subjectId);
        resolve();
      },
    });
    const runner = new JobRunner(db, 'loop');
    bus.attach(runner);
    const worker = startWorker({ bus, runner, db, idleMs: 20 });
    await emit(db, ctx, { type: 'role.created', subjectId: 77, payload: { name: 'Probe' } });
    await arrived;
    await worker.stop();
    expect(got).toEqual(['77']);
  });
});
