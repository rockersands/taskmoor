import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { loadCatalog } from './catalog';
import {
  checkFormula,
  computeValues,
  displayExpression,
  type FormulaRow,
  formulaEnv,
  formulaPlan,
  formulaResolver,
} from './formulas';
import { verifyFieldValues } from './storage';

/**
 * Formula values stay right through every write (M1-013; CORE-011): random sequences of
 * creates, edits, moves, changes of parent, deletions and restores across a three-level
 * hierarchy; after every step every live ticket's stored formula values equal a fresh
 * computation from what is stored now, and the side tables match.
 */
const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.74.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

describe('formula values through every write (M1-013)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const types: Record<string, number> = {};
  const ids: Record<string, number> = {};

  const as = (options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    as({ method: 'POST', url, payload });
  const patch = (url: string, payload: Record<string, unknown>) =>
    as({ method: 'PATCH', url, payload });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
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
    cookie = sessionCookie(res.headers['set-cookie']);
    for (const key of ['PA', 'PB']) {
      const track = await post('/api/v1/tracks', { key, name: key, mode: 'shared' });
      expect(track.statusCode, track.body).toBe(201);
      ids[key] = track.json().track.id;
    }
    for (const t of await database.db.selectFrom('ticket_type').select(['id', 'name']).execute()) {
      types[t.name] = t.id;
    }
    const make = async (name: string, body: Record<string, unknown>) => {
      const created = await post('/api/v1/fields', { name, ...body });
      expect(created.statusCode, created.body).toBe(201);
      ids[name] = created.json().field.id;
    };
    await make('Effort', { type: 'number' });
    await make('Double', {
      type: 'formula',
      config: { expression: '{Effort} * 2', output: 'number' },
    });
    await make('Child points', {
      type: 'formula',
      config: { expression: 'sum(children.{Effort})', output: 'number' },
    });
    // Reads another formula, and itself on the children: the whole tree's doubles.
    await make('Tree double', {
      type: 'formula',
      config: {
        expression: 'ifEmpty({Double}, 0) + sum(children.{Tree double})',
        output: 'number',
      },
    });
    await make('Due state', {
      type: 'formula',
      config: {
        expression:
          'if(isEmpty({Due date}), "none", if(workingDaysUntil({Due date}) < 0, "Overdue", "ok"))',
        output: 'text',
      },
    });
    // Only in track PA: a move to PB takes it away, a move back brings it.
    await make('Children in A', {
      type: 'formula',
      config: { expression: 'count(children)', output: 'number' },
      context: { trackIds: [ids.PA] },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  /** Every live ticket's formula values against a fresh computation. */
  async function check() {
    const catalog = await loadCatalog(database.db, 1);
    const plan = formulaPlan(catalog);
    const env = await formulaEnv(database.db, plan, 1);
    const rows = (await database.db
      .selectFrom('ticket')
      .select([
        'id',
        'track_id',
        'ticket_type_id',
        'parent_id',
        'summary',
        'due_date',
        'start_date',
        'created_at',
        'updated_at',
        'closed_at',
        'original_estimate',
        'remaining_estimate',
        'time_spent',
        'fields',
      ])
      .where('deleted_at', 'is', null)
      .execute()) as FormulaRow[];
    const formulaKeys = plan.order.map((d) => String(d.field.id));
    const pick = (fields: Record<string, unknown>) =>
      Object.fromEntries(formulaKeys.filter((k) => k in fields).map((k) => [k, fields[k]]));
    for (const row of rows) {
      const children = rows.filter((r) => r.parent_id === row.id);
      const fresh = computeValues(catalog, plan, row, children, env);
      expect(pick(row.fields), `ticket ${row.id}`).toEqual(pick(fresh));
    }
    const report = await verifyFieldValues(database.db, catalog, 1, { limit: 100_000 });
    expect(report.mismatched).toEqual([]);
  }

  it('[CORE-011] keeps every formula value equal to a fresh computation through random writes', async () => {
    type Step =
      | {
          kind: 'create';
          level: 'Outcome' | 'Feature' | 'Subticket';
          pick: number;
          points: number | null;
          due: number | null;
          track: 'PA' | 'PB';
        }
      | { kind: 'edit'; pick: number; points: number | null; due: number | null }
      | { kind: 'reparent'; pick: number; to: number }
      | { kind: 'move'; pick: number }
      | { kind: 'delete'; pick: number }
      | { kind: 'restore' };
    const points = fc.option(fc.integer({ min: -50, max: 50 }), { nil: null });
    const due = fc.option(fc.integer({ min: -20, max: 20 }), { nil: null });
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        kind: fc.constant('create' as const),
        level: fc.constantFrom('Outcome' as const, 'Feature' as const, 'Subticket' as const),
        pick: fc.nat(),
        points,
        due,
        track: fc.constantFrom('PA' as const, 'PB' as const),
      }),
      fc.record({ kind: fc.constant('edit' as const), pick: fc.nat(), points, due }),
      fc.record({ kind: fc.constant('reparent' as const), pick: fc.nat(), to: fc.nat() }),
      fc.record({ kind: fc.constant('move' as const), pick: fc.nat() }),
      fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }),
      fc.constant({ kind: 'restore' as const }),
    );
    const day = (offset: number | null) =>
      offset === null
        ? null
        : new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const tree = fc.array(points, { minLength: 8, maxLength: 8 });
    await fc.assert(
      fc.asyncProperty(
        tree,
        fc.array(step, { minLength: 6, maxLength: 16 }),
        async (start, steps) => {
          const live: { id: number; level: string; track: string }[] = [];
          const trashed: number[] = [];
          const of = (level: string) => live.filter((t) => t.level === level);
          // Every run starts from a small tree: two outcomes, three features (one in the other
          // track), three subtickets.
          const shape: [string, string, number | null][] = [
            ['Outcome', 'PA', null],
            ['Outcome', 'PB', null],
            ['Feature', 'PA', 0],
            ['Feature', 'PB', 0],
            ['Feature', 'PA', 1],
            ['Subticket', 'PA', 2],
            ['Subticket', 'PA', 2],
            ['Subticket', 'PB', 3],
          ];
          for (const [i, [level, track, parent]] of shape.entries()) {
            const res = await post('/api/v1/tickets', {
              track,
              summary: 'Start',
              ticketTypeId: types[level],
              fields: { [ids.Effort as number]: start[i] ?? null },
              ...(parent === null ? {} : { parent: live[parent]?.id }),
            });
            expect(res.statusCode, res.body).toBe(201);
            live.push({ id: res.json().ticket.id, level, track });
          }
          for (const s of steps) {
            // After every step, so a later write cannot hide a recompute an earlier one missed.
            await check();
            if (s.kind === 'create') {
              const parents =
                s.level === 'Feature'
                  ? of('Outcome')
                  : s.level === 'Subticket'
                    ? of('Feature')
                    : [];
              if (s.level === 'Subticket' && parents.length === 0) continue;
              const parent = parents.length > 0 ? parents[s.pick % parents.length] : undefined;
              const track = s.level === 'Subticket' ? (parent?.track as string) : s.track;
              const res = await post('/api/v1/tickets', {
                track,
                summary: 'Generated',
                ticketTypeId: types[s.level],
                dueDate: day(s.due),
                fields: { [ids.Effort as number]: s.points },
                ...(parent && s.pick % 3 !== 0 ? { parent: parent.id } : {}),
                ...(s.level === 'Subticket' && parent ? { parent: parent.id } : {}),
              });
              expect(res.statusCode, res.body).toBe(201);
              live.push({ id: res.json().ticket.id, level: s.level, track });
            } else if (s.kind === 'edit' && live.length > 0) {
              const t = live[s.pick % live.length] as (typeof live)[number];
              const res = await patch(`/api/v1/tickets/${t.id}`, {
                dueDate: day(s.due),
                fields: { [ids.Effort as number]: s.points },
              });
              expect(res.statusCode, res.body).toBe(200);
            } else if (s.kind === 'reparent' && of('Feature').length > 0) {
              const features = of('Feature');
              const t = features[s.pick % features.length] as (typeof live)[number];
              const outcomes = of('Outcome');
              const to = outcomes.length === 0 ? null : outcomes[s.to % outcomes.length]?.id;
              const res = await patch(`/api/v1/tickets/${t.id}`, {
                parent: s.to % 4 === 0 ? null : (to ?? null),
              });
              expect(res.statusCode, res.body).toBe(200);
            } else if (s.kind === 'move') {
              const movable = live.filter((t) => t.level !== 'Subticket');
              if (movable.length === 0) continue;
              const t = movable[s.pick % movable.length] as (typeof live)[number];
              const to = t.track === 'PA' ? 'PB' : 'PA';
              const res = await post(`/api/v1/tickets/${t.id}/move`, { track: to });
              expect(res.statusCode, res.body).toBe(200);
              for (const x of live) {
                if (x.id === t.id) x.track = to;
              }
              // Subtickets travel with their feature.
              const subs = await database.db
                .selectFrom('ticket')
                .select('id')
                .where('parent_id', '=', t.id)
                .execute();
              for (const x of live) {
                if (x.level === 'Subticket' && subs.some((r) => r.id === x.id)) x.track = to;
              }
            } else if (s.kind === 'delete' && live.length > 0) {
              const t = live[s.pick % live.length] as (typeof live)[number];
              const res = await as({ method: 'DELETE', url: `/api/v1/tickets/${t.id}` });
              expect(res.statusCode, res.body).toBe(204);
              trashed.push(t.id);
              // Subtickets go along; other children only lose the link.
              const gone = await database.db
                .selectFrom('ticket')
                .select('id')
                .where('deleted_at', 'is not', null)
                .execute();
              for (let i = live.length - 1; i >= 0; i--) {
                if (gone.some((g) => g.id === live[i]?.id)) live.splice(i, 1);
              }
            } else if (s.kind === 'restore' && trashed.length > 0) {
              const id = trashed.pop() as number;
              const res = await post(`/api/v1/tickets/${id}/restore`);
              if (res.statusCode === 200) {
                const rows = await database.db
                  .selectFrom('ticket as k')
                  .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
                  .innerJoin('track as t', 't.id', 'k.track_id')
                  .select(['k.id', 'ty.name', 't.key'])
                  .where('k.deleted_at', 'is', null)
                  .execute();
                live.splice(
                  0,
                  live.length,
                  ...rows.map((r) => ({ id: r.id, level: r.name, track: r.key })),
                );
              }
            }
          }
          await check();
        },
      ),
      // A failure is reported as found: shrinking sequences of requests outlasts any timeout.
      { numRuns: 12, endOnFailure: true },
    );
  }, 300_000);

  it('[CORE-011] shows stored formulas with names and reads them back to the same ids', async () => {
    const catalog = await loadCatalog(database.db, 1);
    const tree = catalog.fields.get(ids['Tree double'] as number);
    expect(tree?.config.expression).toBe(
      `ifEmpty({cf[${ids.Double}]}, 0) + sum(children.{cf[${ids['Tree double']}]})`,
    );
    const shown = displayExpression(catalog, tree as NonNullable<typeof tree>);
    expect(shown).toBe('ifEmpty({Double}, 0) + sum(children.{Tree double})');
    const again = checkFormula(catalog, { id: tree?.id ?? 0, trackId: null }, shown, 'number');
    expect(again.ok && again.expression).toBe(tree?.config.expression);
    // System fields by id, name or alias, any case; custom ones by id too.
    const resolve = formulaResolver(catalog, null);
    for (const name of ['due', 'Due date', 'dueDate', 'DUE DATE']) {
      expect(resolve(name)).toEqual({ id: 'due', type: 'date' });
    }
    expect(resolve(`cf[${ids.Effort}]`)).toEqual({ id: `cf[${ids.Effort}]`, type: 'number' });
    expect(resolve('cf[999999]')).toMatchObject({ problem: 'unknown_field' });
  });
});
