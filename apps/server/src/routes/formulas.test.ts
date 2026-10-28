import { useMigratedDatabase } from '@taskmoor/db/testing';
import { dayOfDate, isoOfDay, workingDaysUntil, workingWeek } from '@taskmoor/formula';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus, startWorker } from '../events/bus';
import { JobRunner } from '../events/queue';
import { loadCatalog } from '../fields/catalog';
import { registerFormulaJobs } from '../fields/formula-jobs';
import { FORMULA_RECOMPUTE_TASK, FORMULA_REFRESH_TASK, refreshFormulas } from '../fields/formulas';
import { syncFieldValues, verifyFieldValues } from '../fields/storage';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

interface TicketJson {
  id: number;
  key: string;
  version: number;
  fields: Record<string, unknown>;
}
interface ChangeJson {
  field: string;
  actor: { id: number } | null;
  from: { value: string | null };
  to: { value: string | null };
}

/**
 * Formula fields through the API (M1-013; CORE-011): computed on every write path and shown in
 * the answer, refused on save with the error's place, working days and "Overdue", roll-ups over
 * children (in the request, or by the worker when the parent is held), recomputed in the
 * background after a formula changes, searchable through the side tables, never writable.
 */
describe('formula fields (M1-013)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const types: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  let runner: JobRunner;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: Record<string, unknown> = {}) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  async function field(body: Record<string, unknown>): Promise<number> {
    const res = await post('admin', '/api/v1/fields', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().field.id as number;
  }
  const formula = (name: string, expression: string, output = 'number', extra = {}) =>
    field({ name, type: 'formula', config: { expression, output, ...extra } });
  async function ticket(track: string, body: Record<string, unknown> = {}): Promise<TicketJson> {
    const res = await post('alice', '/api/v1/tickets', { track, summary: 'Work', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }
  const view = async (id: number) =>
    (await get('alice', `/api/v1/tickets/${id}`)).json().ticket as TicketJson;
  const fieldValue = async (id: number, fieldId: number) => (await view(id)).fields[fieldId];
  const edit = async (id: number, body: Record<string, unknown>) => {
    const res = await patch('alice', `/api/v1/tickets/${id}`, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().ticket as TicketJson;
  };
  const history = async (id: number) =>
    (await get('alice', `/api/v1/tickets/${id}/history?order=asc`)).json().changes as ChangeJson[];
  const formulaError = (res: LightMyRequestResponse) => {
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('invalid_formula');
    return res.json().formula as {
      code: string;
      start: number;
      end: number;
      line: number;
      column: number;
      message: string;
    };
  };
  /** Runs queued jobs until none is ready. */
  async function drainJobs(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 200; i++) {
      await sql`UPDATE job SET run_at = now() WHERE done_at IS NULL AND locked_at IS NULL`.execute(
        database.db,
      );
      const ran = await runner.runOnce(50);
      total += ran;
      if (ran === 0) return total;
    }
    return total;
  }
  const pendingJobs = async (task: string) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM job WHERE task = ${task} AND done_at IS NULL`.execute(
      database.db,
    );
    return rows[0]?.n ?? 0;
  };
  async function sideRowsMatch() {
    const report = await verifyFieldValues(database.db, await loadCatalog(database.db, 1), 1, {
      limit: 100_000,
    });
    expect(report.mismatched).toEqual([]);
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    runner = new JobRunner(database.db, 'formula-test');
    registerFormulaJobs(runner, database.db);
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    for (const key of ['FA', 'FB', 'FC']) {
      const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: members.id,
          user_id: users.alice?.id as number,
        })
        .execute();
    }
    for (const t of await database.db.selectFrom('ticket_type').select(['id', 'name']).execute()) {
      types[t.name] = t.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-011] computes {Points} * 2 in the answer to a create and an edit, within 1 s, with history', async () => {
    const points = await field({ name: 'Points', type: 'number' });
    const double = await formula('Double points', '{Points} * 2');
    const t = await ticket('FA', { fields: { [points]: 5 } });
    expect(t.fields[double]).toBe(10);
    // Acceptance criterion (1): the answer to the edit already holds the new value.
    const started = performance.now();
    const edited = await edit(t.id, { fields: { [points]: 7 } });
    const elapsed = performance.now() - started;
    expect(edited.fields[double]).toBe(14);
    expect(elapsed).toBeLessThan(1000);
    // Cleared input clears the formula; the side table follows.
    expect((await edit(t.id, { fields: { [points]: null } })).fields[double]).toBeUndefined();
    await edit(t.id, { fields: { [points]: 2.5 } });
    expect(await fieldValue(t.id, double)).toBe(5);
    const rows = (await history(t.id)).filter((c) => c.field === `cf[${double}]`);
    expect(rows.map((c) => [c.from.value, c.to.value])).toEqual([
      [null, '10'],
      ['10', '14'],
      ['14', null],
      [null, '5'],
    ]);
    const side = await database.db
      .selectFrom('v_number')
      .select('value')
      .where('ticket_id', '=', t.id)
      .where('field_id', '=', double)
      .executeTakeFirstOrThrow();
    expect(Number(side.value)).toBe(5);
    await sideRowsMatch();
  });

  it('[CORE-011] refuses invalid formulas at save time with the error position', async () => {
    const bad = formulaError(
      await post('admin', '/api/v1/fields', {
        name: 'Broken',
        type: 'formula',
        config: { expression: '{Points} * * 2', output: 'number' },
      }),
    );
    expect(bad).toMatchObject({
      code: 'unexpected_token',
      start: 11,
      end: 12,
      line: 1,
      column: 12,
    });
    expect(
      formulaError(
        await post('admin', '/api/v1/fields', {
          name: 'Broken',
          type: 'formula',
          config: { expression: '1 +\n {Nope}', output: 'number' },
        }),
      ),
    ).toMatchObject({ code: 'unknown_field', start: 5, end: 11, line: 2, column: 2 });
    expect(
      formulaError(
        await post('admin', '/api/v1/fields', {
          name: 'Broken',
          type: 'formula',
          config: { expression: '{Due date}', output: 'number' },
        }),
      ),
    ).toMatchObject({ code: 'output_mismatch', start: 0, end: 10 });
    // Settings that do not fit a formula, or a missing expression.
    for (const config of [
      { output: 'number' },
      { expression: '1', output: 'number', display: 'radio' },
      { expression: '1', output: 'date', decimals: 2 },
      { expression: '1', output: 'currency' },
    ]) {
      const res = await post('admin', '/api/v1/fields', {
        name: 'Broken',
        type: 'formula',
        config,
      });
      expect(res.statusCode, JSON.stringify(config)).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
    expect(
      (
        await post('admin', '/api/v1/fields', {
          name: 'Many',
          type: 'formula',
          multiple: true,
          config: { expression: '1', output: 'number' },
        })
      ).statusCode,
    ).toBe(400);
    // Cycles through formulas of the same ticket, named in order.
    const a = await formula('Cycle A', '1');
    const b = await formula('Cycle B', '{Cycle A} + 1');
    const cycle = formulaError(
      await patch('admin', `/api/v1/fields/${a}`, {
        config: { expression: '2 * {Cycle B}', output: 'number' },
      }),
    );
    expect(cycle).toMatchObject({ code: 'cycle', start: 4, end: 13 });
    expect(cycle.message).toContain('{Cycle A} → {Cycle B} → {Cycle A}');
    const self = formulaError(
      await patch('admin', `/api/v1/fields/${b}`, {
        config: { expression: '{Cycle B} + 1', output: 'number' },
      }),
    );
    expect(self.code).toBe('cycle');
    // A roll-up of the same field over the children is no cycle: the hierarchy has no loops.
    const total = await formula('Tree total', '1');
    expect(
      (
        await patch('admin', `/api/v1/fields/${total}`, {
          config: { expression: '1 + sum(children.{Tree total})', output: 'number' },
        })
      ).statusCode,
    ).toBe(200);
    // The checker answers while typing, without saving.
    const checked = await get(
      'admin',
      `/api/v1/formulas/check?expression=${encodeURIComponent('{Cycle A} * 2 + sum(children.{Points})')}`,
    );
    expect(checked.json()).toMatchObject({
      ok: true,
      type: 'number',
      reads: [`cf[${a}]`],
      readsChildren: true,
      volatile: false,
    });
    const wrong = await get(
      'admin',
      `/api/v1/formulas/check?expression=${encodeURIComponent('if({Cycle A}, 1, 2)')}`,
    );
    expect(wrong.json()).toMatchObject({ ok: false, error: { code: 'type_mismatch', start: 3 } });
    const looped = await get(
      'admin',
      `/api/v1/formulas/check?fieldId=${a}&expression=${encodeURIComponent('{Cycle B}')}`,
    );
    expect(looped.json()).toMatchObject({ ok: false, error: { code: 'cycle' } });
  });

  it('[CORE-011] stores formulas with field ids and shows names, so a rename changes nothing', async () => {
    const effort = await field({ name: 'Effort', type: 'number' });
    const made = await post('admin', '/api/v1/fields', {
      name: 'Effort cost',
      type: 'formula',
      config: {
        expression: '{effort} * 100 + {Time spent} / hours(1)',
        output: 'currency',
        currency: 'EUR',
        decimals: 2,
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    // The answer reads with names, as each field is called.
    expect(made.json().field.config.expression).toBe('{Effort} * 100 + {Time spent} / hours(1)');
    const f = made.json().field.id as number;
    const stored = await database.db
      .selectFrom('field')
      .select('config')
      .where('id', '=', f)
      .executeTakeFirstOrThrow();
    expect(stored.config.expression).toBe(`{cf[${effort}]} * 100 + {timeSpent} / hours(1)`);
    const shown = (await get('admin', `/api/v1/fields/${f}`)).json().field;
    expect(shown.config).toEqual({
      expression: '{Effort} * 100 + {Time spent} / hours(1)',
      output: 'currency',
      currency: 'EUR',
      decimals: 2,
    });
    expect(
      (await patch('admin', `/api/v1/fields/${effort}`, { name: 'Effort (days)' })).statusCode,
    ).toBe(200);
    const t = await ticket('FA', { fields: { [effort]: 3 } });
    expect(t.fields[f]).toBe(300);
    const renamed = (await get('admin', `/api/v1/fields/${f}`)).json().field.config;
    expect(renamed.expression).toBe('{Effort (days)} * 100 + {Time spent} / hours(1)');
    // Saving what was shown stores the same expression: nothing changes, nothing is queued.
    const before = await pendingJobs(FORMULA_REFRESH_TASK);
    expect((await patch('admin', `/api/v1/fields/${f}`, { config: renamed })).statusCode).toBe(200);
    expect(await pendingJobs(FORMULA_REFRESH_TASK)).toBe(before);
    await drainJobs();
  });

  it('[CORE-011] counts working days until due with the working week and says "Overdue"', async () => {
    const left = await formula(
      'Days left',
      'if(isEmpty({Due date}), "No due date", if(workingDaysUntil({Due date}) < 0, "Overdue", workingDaysUntil({Due date}) & " working days"))',
      'text',
    );
    const today = dayOfDate(new Date());
    const late = await ticket('FA', { dueDate: isoOfDay(today - 3) });
    expect(late.fields[left]).toBe('Overdue');
    const due = isoOfDay(today + 10);
    const soon = await ticket('FA', { dueDate: due });
    const five = workingDaysUntil(today + 10, today, workingWeek(5));
    expect(soon.fields[left]).toBe(`${five} working days`);
    // Moving the due date recomputes in the same answer.
    expect((await edit(late.id, { dueDate: due })).fields[left]).toBe(`${five} working days`);
    expect((await edit(late.id, { dueDate: null })).fields[left]).toBe('No due date');
    // The working week is the workspace's (CORE-011 (2)): a change recomputes every ticket.
    const res = await patch('admin', '/api/v1/time-tracking', { daysPerWeek: 7 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await pendingJobs(FORMULA_REFRESH_TASK)).toBeGreaterThan(0);
    await drainJobs();
    expect(await fieldValue(soon.id, left)).toBe('10 working days');
    await patch('admin', '/api/v1/time-tracking', { daysPerWeek: 5 });
    await drainJobs();
    expect(await fieldValue(soon.id, left)).toBe(`${five} working days`);
    // A formula on the date alone has no history: its value moves with the clock.
    expect((await history(soon.id)).some((c) => c.field === `cf[${left}]`)).toBe(false);
  });

  it('[CORE-011] rolls up over children in the same request, up the hierarchy, through every write', async () => {
    const size = await field({ name: 'Size', type: 'number' });
    const sum = await formula('Children size', 'sum(children.{Size})');
    const count = await formula('Children', 'count(children)');
    // Recursive: a ticket's size and all of its descendants'.
    const tree = await formula('Tree size', 'ifEmpty({Size}, 0) + sum(children.{Tree size})');
    const outcome = await ticket('FB', { ticketTypeId: types.Outcome, fields: { [size]: 100 } });
    const feature = await ticket('FB', {
      ticketTypeId: types.Feature,
      parent: outcome.id,
      fields: { [size]: 10 },
    });
    expect(await fieldValue(outcome.id, tree)).toBe(110);
    const sub1 = await ticket('FB', {
      ticketTypeId: types.Subticket,
      parent: feature.id,
      fields: { [size]: 1 },
    });
    const sub2 = await ticket('FB', {
      ticketTypeId: types.Subticket,
      parent: feature.id,
      fields: { [size]: 2 },
    });
    expect(await fieldValue(feature.id, sum)).toBe(3);
    expect(await fieldValue(feature.id, count)).toBe(2);
    expect(await fieldValue(feature.id, tree)).toBe(13);
    expect(await fieldValue(outcome.id, tree)).toBe(113);
    // An edit of a grandchild climbs two levels in the same request.
    await edit(sub1.id, { fields: { [size]: 5 } });
    expect(await fieldValue(feature.id, sum)).toBe(7);
    expect(await fieldValue(outcome.id, tree)).toBe(117);
    // The trash and back.
    expect((await del('admin', `/api/v1/tickets/${sub2.id}`)).statusCode).toBe(204);
    expect(await fieldValue(feature.id, sum)).toBe(5);
    expect(await fieldValue(feature.id, count)).toBe(1);
    expect(await fieldValue(outcome.id, tree)).toBe(115);
    expect((await post('admin', `/api/v1/tickets/${sub2.id}/restore`)).statusCode).toBe(200);
    expect(await fieldValue(feature.id, sum)).toBe(7);
    expect(await fieldValue(outcome.id, tree)).toBe(117);
    // A feature that changes parent leaves one outcome and joins another.
    const other = await ticket('FB', { ticketTypeId: types.Outcome });
    await edit(feature.id, { parent: other.id });
    expect(await fieldValue(outcome.id, tree)).toBe(100);
    expect(await fieldValue(other.id, tree)).toBe(17);
    // A move to another track takes the subtickets along; the parent keeps the link.
    const moved = await post('alice', `/api/v1/tickets/${feature.id}/move`, { track: 'FC' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await fieldValue(other.id, tree)).toBe(17);
    expect(moved.json().ticket.fields[sum]).toBe(7);
    // History names the computed changes on the parent, by the person whose edit caused them.
    const parentHistory = (await history(feature.id)).filter((c) => c.field === `cf[${sum}]`);
    // A new feature's sum over no children is 0.
    expect(parentHistory.map((c) => c.to.value)).toEqual(['0', '1', '3', '7', '5', '7']);
    expect(parentHistory.map((c) => c.actor?.id)).toEqual([
      users.alice?.id,
      users.alice?.id,
      users.alice?.id,
      users.alice?.id,
      users.admin?.id,
      users.admin?.id,
    ]);
    await sideRowsMatch();
  }, 60_000);

  it('[CORE-011] leaves a parent someone holds to the worker, and the worker catches up', async () => {
    const weight = await field({ name: 'Weight', type: 'number' });
    const heaviest = await formula('Heaviest child', 'max(children.{Weight})');
    await drainJobs();
    const parent = await ticket('FA', { ticketTypeId: types.Feature });
    const child = await ticket('FA', {
      ticketTypeId: types.Subticket,
      parent: parent.id,
      fields: { [weight]: 3 },
    });
    expect(await fieldValue(parent.id, heaviest)).toBe(3);
    // Someone holds the parent: the child's edit neither waits nor fails.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.db.transaction().execute(async (trx) => {
      await trx.selectFrom('ticket').select('id').where('id', '=', parent.id).forUpdate().execute();
      locked();
      await released;
    });
    await isLocked;
    const started = performance.now();
    await edit(child.id, { fields: { [weight]: 9 } });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await pendingJobs(FORMULA_RECOMPUTE_TASK)).toBe(1);
    release();
    await holder;
    expect(await fieldValue(parent.id, heaviest)).toBe(3);
    // The worker loop (polling every 500 ms when idle, as in production) picks it up.
    const bus = new EventBus(database.db);
    const loop = startWorker({ bus, runner, db: database.db });
    const freed = performance.now();
    let caughtUp = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 100; i++) {
      if ((await fieldValue(parent.id, heaviest)) === 9) {
        caughtUp = performance.now() - freed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await loop.stop();
    // Measured 0.1 to 0.6 s; the bound leaves room for a loaded machine.
    expect(caughtUp).toBeLessThan(1500);
    const { rows: left } = await sql<{ payload: unknown; last_error: string | null }>`
      SELECT payload, last_error FROM job
       WHERE task = ${FORMULA_RECOMPUTE_TASK} AND done_at IS NULL`.execute(database.db);
    expect(left).toEqual([]);
    await sideRowsMatch();
  });

  it('[CORE-011] recomputes every ticket in the background when a formula changes, in batches', async () => {
    const score = await field({ name: 'Score', type: 'number' });
    const scaled = await formula('Scaled score', '{Score} * 2');
    await drainJobs();
    const ids: number[] = [];
    // More than two batches of the walk.
    const rows = Array.from({ length: 450 }, (_, i) => i);
    for (const i of rows) {
      const t = await ticket('FC', { summary: `Bulk ${i}`, fields: { [score]: i } });
      ids.push(t.id);
    }
    expect(await fieldValue(ids[7] as number, scaled)).toBe(14);
    const res = await patch('admin', `/api/v1/fields/${scaled}`, {
      config: { expression: '{Score} * 3', output: 'number' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await pendingJobs(FORMULA_REFRESH_TASK)).toBe(1);
    expect(await fieldValue(ids[7] as number, scaled)).toBe(14);
    expect(await drainJobs()).toBeGreaterThan(0);
    for (const [i, id] of ids.entries()) {
      if (i % 37 === 0) expect(await fieldValue(id, scaled)).toBe(i * 3);
    }
    const { rows: wrong } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ticket
       WHERE id = ANY(${ids}::int[]) AND (fields ->> ${String(scaled)})::numeric
             <> (fields ->> ${String(score)})::numeric * 3`.execute(database.db);
    expect(wrong[0]?.n).toBe(0);
    // The walk's changes are history without a person.
    const last = (await history(ids[9] as number)).filter((c) => c.field === `cf[${scaled}]`);
    expect(last.at(-1)).toMatchObject({ actor: null, from: { value: '18' }, to: { value: '27' } });
    await sideRowsMatch();
  }, 240_000);

  it('[CORE-011] keeps formula values in the side table of their output, so queries filter and sort them', async () => {
    const rank = await field({ name: 'Rank', type: 'number' });
    const negated = await formula('Negated rank', '-{Rank}');
    const label = await formula('Rank label', 'if({Rank} > 1, "High " & {Rank}, "low")', 'text');
    const when = await formula('Rank day', 'date("2026-01-01") + {Rank}', 'date');
    const spent = await formula('Spent', '{Time spent} * 2', 'duration');
    const made: number[] = [];
    for (const r of [3, 1, 2]) made.push((await ticket('FA', { fields: { [rank]: r } })).id);
    const order = async (table: string, fieldId: number, column = 'value') => {
      const { rows } = await sql<{ ticket_id: number }>`
        SELECT ticket_id FROM ${sql.table(table)}
         WHERE field_id = ${fieldId} AND ticket_id = ANY(${made}::int[])
         ORDER BY ${sql.ref(column)}`.execute(database.db);
      return rows.map((r) => made.indexOf(r.ticket_id));
    };
    expect(await order('v_number', negated)).toEqual([0, 2, 1]);
    expect(await order('v_text', label, 'sort_key')).toEqual([2, 0, 1]);
    expect(await order('v_date', when)).toEqual([1, 2, 0]);
    expect(
      (
        await database.db
          .selectFrom('v_number')
          .select('value')
          .where('field_id', '=', spent)
          .where('ticket_id', '=', made[0] as number)
          .executeTakeFirstOrThrow()
      ).value,
    ).toBeDefined();
    // The query language reads each formula as its output type.
    const check = async (q: string) =>
      (await get('alice', `/api/v1/search/check?q=${encodeURIComponent(q)}`)).json();
    expect(await check(`cf[${negated}] < -1 ORDER BY cf[${negated}]`)).toMatchObject({ ok: true });
    expect(await check(`cf[${when}] >= 2026-01-02 ORDER BY cf[${when}] DESC`)).toMatchObject({
      ok: true,
    });
    expect(await check(`cf[${label}] ~ "High"`)).toMatchObject({ ok: true });
    expect(await check(`cf[${label}] > 1`)).toMatchObject({ ok: false });
    expect(await check(`cf[${spent}] > 3600`)).toMatchObject({ ok: true });
  });

  it('[CORE-011] never takes a formula value from a request, and keeps formulas off create forms', async () => {
    const f = await formula('Constant', '42');
    const refused = await post('alice', '/api/v1/tickets', {
      track: 'FA',
      summary: 'x',
      fields: { [f]: 1 },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().fields).toEqual({ [`fields.${f}`]: 'read_only' });
    const t = await ticket('FA');
    expect(t.fields[f]).toBe(42);
    const edited = await patch('alice', `/api/v1/tickets/${t.id}`, { fields: { [f]: 41 } });
    expect(edited.json().fields).toEqual({ [`fields.${f}`]: 'read_only' });
    // No default, no rule that would make it required; not on the create form, on the view.
    const context = (await get('admin', `/api/v1/fields/${f}`)).json().field.contexts[0].id;
    expect(
      (await patch('admin', `/api/v1/fields/${f}/contexts/${context}`, { defaultValue: 3 }))
        .statusCode,
    ).toBe(400);
    const setId = (await get('admin', '/api/v1/field-rule-sets')).json().fieldRuleSets[0].id;
    const rule = await patch('admin', `/api/v1/field-rule-sets/${setId}`, {
      rules: [{ field: `cf[${f}]`, required: true }],
    });
    expect(rule.statusCode).toBe(400);
    expect(rule.json().detail).toBe(`cf[${f}] is computed`);
    const keys = (layout: { tabs: { sections: { fields: { key: string }[] }[] }[] }) =>
      layout.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.fields.map((x) => x.key)));
    const create = (
      await get(
        'alice',
        `/api/v1/tracks/${tracks.FA}/layout?ticketTypeId=${types.Feature}&operation=create`,
      )
    ).json();
    const viewLayout = (await get('alice', `/api/v1/tickets/${t.id}/layout?operation=view`)).json();
    expect(keys(create.layout ?? create)).not.toContain(`cf[${f}]`);
    expect(keys(viewLayout.layout ?? viewLayout)).toContain(`cf[${f}]`);
  });

  it('[CORE-011] follows transitions and time entries, and the contexts formulas apply in', async () => {
    const closedDay = await formula(
      'Closed on',
      'if(isEmpty({Closed}), "open", "closed " & {Closed})',
      'text',
    );
    const hoursSpent = await formula('Hours spent', '{Time spent} / hours(1)');
    const t = await ticket('FA');
    expect(t.fields[closedDay]).toBe('open');
    const transitions = (await get('alice', `/api/v1/tickets/${t.id}/transitions`)).json()
      .transitions as { id: number; name: string }[];
    const close = transitions.find((x) => x.name === 'Close');
    const reason = await database.db
      .selectFrom('close_reason')
      .select('id')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const closed = await post('alice', `/api/v1/tickets/${t.id}/transitions`, {
      transitionId: close?.id,
      fields: { 'close-reason': reason.id },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().ticket.fields[closedDay]).toBe(
      `closed ${isoOfDay(dayOfDate(new Date()))}`,
    );
    const entry = await post('alice', `/api/v1/tickets/${t.id}/time-entries`, {
      duration: '1h 30m',
      startedAt: new Date().toISOString(),
    });
    expect(entry.statusCode, entry.body).toBe(201);
    expect(await fieldValue(t.id, hoursSpent)).toBe(1.5);
    // A formula limited to one track: moving out removes its value, a context change brings it.
    const context = (await get('admin', `/api/v1/fields/${hoursSpent}`)).json().field.contexts[0]
      .id;
    const narrowed = await patch('admin', `/api/v1/fields/${hoursSpent}/contexts/${context}`, {
      trackIds: [tracks.FA],
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const moved = await post('alice', `/api/v1/tickets/${t.id}/move`, { track: 'FB' });
    expect(moved.statusCode, moved.body).toBe(200);
    const raw = await database.db
      .selectFrom('ticket')
      .select('fields')
      .where('id', '=', t.id)
      .executeTakeFirstOrThrow();
    expect(raw.fields[String(hoursSpent)]).toBeUndefined();
    await patch('admin', `/api/v1/fields/${hoursSpent}/contexts/${context}`, { trackIds: null });
    expect(await pendingJobs(FORMULA_REFRESH_TASK)).toBeGreaterThan(0);
    await drainJobs();
    expect(await fieldValue(t.id, hoursSpent)).toBe(1.5);
    await sideRowsMatch();
  });

  it('[CORE-011] refuses to delete a field a formula reads, and deletes a formula with its values', async () => {
    const base = await field({ name: 'Base', type: 'number' });
    const first = await formula('First', '{Base} + 1');
    const second = await formula('Second', '{First} * 2');
    const t = await ticket('FA', { fields: { [base]: 1 } });
    expect(t.fields[second]).toBe(4);
    const refused = await del('admin', `/api/v1/fields/${base}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'used_by_formula', fields: [{ id: first }] });
    expect((await del('admin', `/api/v1/fields/${first}`)).statusCode).toBe(409);
    expect((await del('admin', `/api/v1/fields/${second}`)).statusCode).toBe(204);
    expect((await del('admin', `/api/v1/fields/${first}`)).statusCode).toBe(204);
    const raw = await database.db
      .selectFrom('ticket')
      .select('fields')
      .where('id', '=', t.id)
      .executeTakeFirstOrThrow();
    expect(Object.keys(raw.fields)).toContain(String(base));
    expect(Object.keys(raw.fields)).not.toContain(String(first));
    expect(Object.keys(raw.fields)).not.toContain(String(second));
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM v_number WHERE field_id IN (${first}, ${second})`.execute(
      database.db,
    );
    expect(rows[0]?.n).toBe(0);
    // Shared formulas read shared fields only.
    const local = await post('admin', '/api/v1/tracks', {
      key: 'LF',
      name: 'Local',
      mode: 'local',
    });
    const localField = await field({
      name: 'Local only',
      type: 'number',
      trackId: local.json().track.id,
    });
    expect(
      formulaError(
        await post('admin', '/api/v1/fields', {
          name: 'Leak',
          type: 'formula',
          config: { expression: `{cf[${localField}]} + 1`, output: 'number' },
        }),
      ).code,
    ).toBe('unknown_field');
  });

  it('[CORE-011] recomputes after a bulk edit through the hook M1-021 calls, within 1 s', async () => {
    const units = await field({ name: 'Units', type: 'number' });
    const total = await formula('Units total', 'ifEmpty({Units}, 0) * 2 + sum(children.{Units})');
    const parent = await ticket('FC', { ticketTypeId: types.Feature });
    const ids: number[] = [];
    for (let i = 0; i < 200; i++) {
      ids.push(
        (
          await ticket('FC', {
            ticketTypeId: types.Subticket,
            parent: parent.id,
            fields: { [units]: 1 },
          })
        ).id,
      );
    }
    expect(await fieldValue(parent.id, total)).toBe(200);
    // A bulk edit writes many tickets in one transaction, then calls the hook once.
    const catalog = await loadCatalog(database.db, 1);
    const started = performance.now();
    await database.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', 'in', ids)
        .orderBy('id')
        .forUpdate()
        .execute();
      await sql`
        UPDATE ticket SET fields = jsonb_set(fields, ${`{${units}}`}::text[], '5')
         WHERE id = ANY(${ids}::int[])`.execute(trx);
      await syncFieldValues(trx, catalog, ids, [units]);
      await refreshFormulas(trx, catalog, 1, ids);
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(await fieldValue(ids[0] as number, total)).toBe(10);
    expect(await fieldValue(parent.id, total)).toBe(1000);
    await sideRowsMatch();
  }, 120_000);
});
