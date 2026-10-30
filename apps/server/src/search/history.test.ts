import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer, type Principal } from '../authz/authorizer';
import type { TicketAccessRow } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import { prepareSearch } from './run';

/**
 * WAS and CHANGED against a model of history (M1-039; QRY-005, QRY-008): in random worlds of
 * tickets whose status, assignee, labels and links change at random times by random people
 * (some at the same instant), each history query returns, for each person, exactly the tickets
 * a model of the history names among those `ticketPermissions` lets them browse.
 *
 * The model is spec 01b section 1.3 as ADR-010 "History operators (M1-039)" reads it: a value
 * is held from the row that set it until the field's next row (a link until the row that
 * removes it); a field without a first value was empty from the ticket's creation, as its
 * creator made it; WAS asks for a stretch with the value, begun BY the person, overlapping the
 * window (AFTER: it lasts past the instant; BEFORE: it began before; ON: the day; DURING: both
 * ends included); CHANGED asks for a row after the ticket's creation, FROM taking a value away
 * and TO bringing one (for lists, an item that left or arrived), BY the person, in the window.
 */
type FieldName = 'status' | 'assignee' | 'labels' | 'link';

interface Step {
  field: FieldName;
  day: number;
  /** Two steps at one instant are written in order (the later one wins). */
  hour: 12 | 18;
  actor: number;
  choice: number;
}
interface TicketSpec {
  track: 0 | 1;
  creator: number;
  /** Created on this day of January 2026 at 06:00 UTC. */
  day: number;
  status: number;
  assignee: number | null;
  labels: number;
  steps: Step[];
}

/** A history row as the model reads it: values by index into the world's lists. */
interface Row {
  field: FieldName;
  from: string | null;
  to: string | null;
  at: number;
  actor: number;
}

const TICKETS = 6;
const stepArb = fc.record({
  field: fc.constantFrom<FieldName>('status', 'assignee', 'labels', 'link'),
  day: fc.integer({ min: 1, max: 20 }),
  hour: fc.constantFrom<12 | 18>(12, 18),
  actor: fc.integer({ min: 0, max: 2 }),
  choice: fc.integer({ min: 0, max: 63 }),
});
const ticketArb: fc.Arbitrary<TicketSpec> = fc.record({
  track: fc.constantFrom<0 | 1>(0, 1),
  creator: fc.integer({ min: 0, max: 2 }),
  day: fc.integer({ min: 1, max: 4 }),
  status: fc.integer({ min: 0, max: 3 }),
  assignee: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
  labels: fc.integer({ min: 0, max: 7 }),
  steps: fc.array(stepArb, { maxLength: 8 }),
});
const worldArb = fc.tuple(...Array.from({ length: TICKETS }, () => ticketArb));

const at = (day: number, hour = 0) => Date.UTC(2026, 0, day, hour);
const LABELS = ['a', 'b', 'c'];
/** Labels as history writes them: by spaces, none as empty. */
const labelText = (bits: number) => {
  const list = LABELS.filter((_, i) => bits & (1 << i));
  return list.length === 0 ? null : list.join(' ');
};
const items = (text: string | null) => (text === null ? [] : text.split(' '));

interface Edge {
  at: number;
  inclusive: boolean;
}
interface Window {
  by?: number[];
  after?: Edge;
  before?: Edge;
}
const after = (day: number): Window => ({ after: { at: at(day), inclusive: false } });
const before = (day: number): Window => ({ before: { at: at(day), inclusive: false } });
const on = (day: number): Window => ({
  after: { at: at(day), inclusive: true },
  before: { at: at(day + 1), inclusive: false },
});
const during = (from: number, to: number): Window => ({
  after: { at: at(from), inclusive: true },
  before: { at: at(to), inclusive: true },
});

describe('WAS and CHANGED against a model of history (M1-039)', () => {
  const database = useMigratedDatabase();
  const ws = 1;
  const users: number[] = [];
  const tracks: number[] = [];
  const linkTypes: number[] = [];
  const statuses: { id: number; name: string; stage: string }[] = [];
  let typeId = 0;

  beforeAll(async () => {
    const db = database.db;
    for (const name of ['u0', 'u1', 'u2']) {
      const row = await db
        .insertInto('app_user')
        .values({ workspace_id: ws, email: `${name}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      users.push(row.id);
    }
    // PA: the default policy (anyone signed in browses). PB: browsed only by group g1 (u1).
    const g1 = await db
      .insertInto('user_group')
      .values({ workspace_id: ws, name: 'g1' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('group_member')
      .values({ workspace_id: ws, group_id: g1.id, user_id: users[1] as number })
      .execute();
    const shared = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const desk = await db
      .insertInto('access_policy')
      .values({ workspace_id: ws, name: 'Desk' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('access_grant')
      .values({
        workspace_id: ws,
        policy_id: desk.id,
        permission: 'browse_track',
        grantee: 'group',
        group_id: g1.id,
      })
      .execute();
    for (const [key, policy] of [
      ['PA', shared.id],
      ['PB', desk.id],
    ] as const) {
      const row = await db
        .insertInto('track')
        .values({ workspace_id: ws, key, name: key, access_policy_id: policy })
        .returning('id')
        .executeTakeFirstOrThrow();
      tracks.push(row.id);
    }
    for (const name of ['Blocks', 'Relates']) {
      const row = await db
        .selectFrom('link_type')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      linkTypes.push(row.id);
    }
    for (const name of ['New', 'Active', 'In Review', 'Closed']) {
      statuses.push(
        await db
          .selectFrom('status')
          .select(['id', 'name', 'stage'])
          .where('workspace_id', '=', ws)
          .where('name', '=', name)
          .executeTakeFirstOrThrow(),
      );
    }
    typeId = (await db.selectFrom('ticket_type').select('id').executeTakeFirstOrThrow()).id;
  });

  it('[QRY-005] [QRY-008] every history query names exactly what the model of history does, among the tickets each person may browse', async () => {
    const db = database.db;
    const catalogs = new FieldCatalogs(db);
    const authorizer = new Authorizer(db);
    let number = 0;
    let changeSet = 0;
    const sid = statuses.map((s) => String(s.id));
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        await db.deleteFrom('ticket_change').execute();
        await db.deleteFrom('ticket').execute();
        const ids: number[] = [];
        const keys: string[] = [];
        for (const t of world) {
          const created = new Date(at(t.day, 6)).toISOString();
          const { rows } = await sql<{ id: number; number: number }>`
            INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                                creator_id, created_at, updated_at)
            VALUES (${ws}, ${tracks[t.track]}, ${++number}, ${typeId}, 'Ticket',
                    ${`r${String(number).padStart(8, '0')}`}, ${users[t.creator]},
                    ${created}::timestamptz, ${created}::timestamptz)
            RETURNING id, number`.execute(db);
          const row = rows[0] as { id: number; number: number };
          ids.push(row.id);
          keys.push(`${t.track === 0 ? 'PA' : 'PB'}-${row.number}`);
        }
        // Each ticket's history: its first values by its creator, then the steps in time order.
        const history: Row[][] = world.map((t, i) => {
          const rows: Row[] = [];
          const start = at(t.day, 6);
          const current: Record<FieldName, string | null> = {
            status: sid[t.status] as string,
            assignee: t.assignee === null ? null : String(users[t.assignee]),
            labels: labelText(t.labels),
            link: null,
          };
          for (const field of ['status', 'assignee', 'labels'] as const) {
            if (current[field] !== null) {
              rows.push({ field, from: null, to: current[field], at: start, actor: t.creator });
            }
          }
          const links = new Set<string>();
          const steps = [...t.steps]
            .filter((s) => s.day > t.day)
            .sort((a, b) => a.day - b.day || a.hour - b.hour);
          for (const s of steps) {
            const when = at(s.day, s.hour);
            let next: string | null;
            switch (s.field) {
              case 'status':
                next = sid[s.choice % 4] as string;
                break;
              case 'assignee':
                next = s.choice % 4 === 3 ? null : String(users[s.choice % 4]);
                break;
              case 'labels':
                next = labelText(s.choice % 8);
                break;
              case 'link': {
                const other = s.choice % TICKETS;
                if (other === i) continue;
                const type = linkTypes[(s.choice >> 3) % 2];
                const direction = (s.choice >> 4) % 2 === 0 ? 'outward' : 'inward';
                const value = `${type}:${direction}:${ids[other]}`;
                const removing = links.has(value);
                if (removing) links.delete(value);
                else links.add(value);
                rows.push({
                  field: 'link',
                  from: removing ? value : null,
                  to: removing ? null : value,
                  at: when,
                  actor: s.actor,
                });
                continue;
              }
            }
            if (next === current[s.field]) continue;
            rows.push({
              field: s.field,
              from: current[s.field],
              to: next,
              at: when,
              actor: s.actor,
            });
            current[s.field] = next;
          }
          return rows;
        });
        for (const [i, rows] of history.entries()) {
          for (const r of rows) {
            await db
              .insertInto('ticket_change')
              .values({
                workspace_id: ws,
                ticket_id: ids[i] as number,
                change_set: String(++changeSet),
                at: new Date(r.at),
                actor_id: users[r.actor] as number,
                field: r.field,
                from_value: r.from,
                to_value: r.to,
              })
              .execute();
          }
        }

        // The model of section 1.3.
        const own = (i: number, field: FieldName) =>
          (history[i] as Row[]).filter((r) => r.field === field);
        const created = (i: number) => at((world[i] as TicketSpec).day, 6);
        const creator = (i: number) => (world[i] as TicketSpec).creator;
        const inWindow = (w: Window, start: number, end: number) =>
          (!w.before || (w.before.inclusive ? start <= w.before.at : start < w.before.at)) &&
          (!w.after || end > w.after.at);
        const was = (
          i: number,
          field: FieldName,
          match: (value: string | null) => boolean,
          w: Window = {},
        ) => {
          const rows = own(i, field);
          const stretches: { value: string | null; start: number; end: number; actor: number }[] =
            [];
          if (field !== 'link' && !rows.some((r) => r.at <= created(i))) {
            stretches.push({
              value: null,
              start: created(i),
              end: rows[0]?.at ?? Number.POSITIVE_INFINITY,
              actor: creator(i),
            });
          }
          for (const [n, r] of rows.entries()) {
            if (r.to === null && field === 'link') continue;
            const end =
              field === 'link'
                ? rows.slice(n + 1).find((x) => x.from === r.to)?.at
                : rows[n + 1]?.at;
            stretches.push({
              value: r.to,
              start: r.at,
              end: end ?? Number.POSITIVE_INFINITY,
              actor: r.actor,
            });
          }
          return stretches.some(
            (s) =>
              match(s.value) && (!w.by || w.by.includes(s.actor)) && inWindow(w, s.start, s.end),
          );
        };
        type Side = (from: string | null, to: string | null) => boolean;
        const changed = (
          i: number,
          field: FieldName,
          w: Window & { from?: Side; to?: Side } = {},
        ) =>
          own(i, field).some(
            (r) =>
              !(r.from === null && r.at <= created(i)) &&
              (!w.from || w.from(r.from, r.to)) &&
              (!w.to || w.to(r.from, r.to)) &&
              (!w.by || w.by.includes(r.actor)) &&
              (!w.after || (w.after.inclusive ? r.at >= w.after.at : r.at > w.after.at)) &&
              (!w.before || (w.before.inclusive ? r.at <= w.before.at : r.at < w.before.at)),
          );
        const is =
          (...values: (string | null)[]) =>
          (v: string | null) =>
            values.includes(v);
        const user = (n: number) => String(users[n]);
        const hasLabel =
          (...wanted: string[]) =>
          (v: string | null) =>
            items(v).some((x) => wanted.includes(x));
        /** A list item that the change brought (`into` 'to') or took away (`into` 'from'). */
        const moved =
          (label: string, into: 'to' | 'from'): Side =>
          (from, to) =>
            into === 'to'
              ? items(to).includes(label) && !items(from).includes(label)
              : items(from).includes(label) && !items(to).includes(label);
        const linkTo = (n: number) => (v: string | null) =>
          v !== null && v.split(':')[2] === String(ids[n]);
        const linkOf = (type: number, direction?: 'outward' | 'inward') => (v: string | null) =>
          v !== null &&
          v.split(':')[0] === String(linkTypes[type]) &&
          (direction === undefined || v.split(':')[1] === direction);

        const access: TicketAccessRow[] = await db
          .selectFrom('ticket')
          .select([
            'id',
            'track_id',
            'requester_id',
            'assignee_id',
            'visibility_level_id',
            'fields',
          ])
          .where('id', 'in', ids)
          .execute();
        const catalog = await catalogs.get(ws);
        const catalogue = await queryCatalogue(db, ws, catalog, 'all');
        for (const person of [0, 1]) {
          const principal: Principal = { userId: users[person] as number };
          const sees = new Set<number>();
          for (const row of access) {
            if ((await authorizer.ticketPermissions(ws, principal, row)).has('browse_track')) {
              sees.add(row.id);
            }
          }
          const seen = (i: number) => sees.has(ids[i] as number);
          const cases: [string, (i: number) => boolean][] = [
            ['status WAS "In Review"', (i) => was(i, 'status', is(sid[2] as string))],
            ['status WAS NOT "In Review"', (i) => !was(i, 'status', is(sid[2] as string))],
            [
              'status WAS IN (New, Closed) BY u1',
              (i) => was(i, 'status', is(sid[0] as string, sid[3] as string), { by: [1] }),
            ],
            [
              'status WAS Active AFTER 2026-01-10',
              (i) => was(i, 'status', is(sid[1] as string), after(10)),
            ],
            [
              'status WAS Active BEFORE 2026-01-05',
              (i) => was(i, 'status', is(sid[1] as string), before(5)),
            ],
            [
              'status WAS Closed DURING (2026-01-05, 2026-01-12)',
              (i) => was(i, 'status', is(sid[3] as string), during(5, 12)),
            ],
            [
              'status WAS "In Review" ON 2026-01-08',
              (i) => was(i, 'status', is(sid[2] as string), on(8)),
            ],
            [
              'status WAS NOT New AFTER 2026-01-06 BEFORE 2026-01-15',
              (i) => !was(i, 'status', is(sid[0] as string), { ...after(6), ...before(15) }),
            ],
            ['status CHANGED', (i) => changed(i, 'status')],
            ['NOT status CHANGED', (i) => !changed(i, 'status')],
            ['status CHANGED FROM New', (i) => changed(i, 'status', { from: (f) => f === sid[0] })],
            [
              'status CHANGED TO Closed BY u2',
              (i) => changed(i, 'status', { to: (_, t) => t === sid[3], by: [2] }),
            ],
            [
              'status CHANGED FROM Active TO "In Review" AFTER 2026-01-04',
              (i) =>
                changed(i, 'status', {
                  from: (f) => f === sid[1],
                  to: (_, t) => t === sid[2],
                  ...after(4),
                }),
            ],
            [
              'status CHANGED DURING (2026-01-05, 2026-01-10)',
              (i) => changed(i, 'status', during(5, 10)),
            ],
            ['status CHANGED ON 2026-01-07', (i) => changed(i, 'status', on(7))],
            ['assignee WAS u1', (i) => was(i, 'assignee', is(user(1)))],
            ['assignee WAS EMPTY', (i) => was(i, 'assignee', is(null))],
            ['assignee WAS EMPTY AFTER 2026-01-10', (i) => was(i, 'assignee', is(null), after(10))],
            ['assignee WAS EMPTY BY u0', (i) => was(i, 'assignee', is(null), { by: [0] })],
            [
              'assignee WAS IN (u0, EMPTY) BEFORE 2026-01-06',
              (i) => was(i, 'assignee', is(user(0), null), before(6)),
            ],
            ['assignee WAS NOT IN (u2, EMPTY)', (i) => !was(i, 'assignee', is(user(2), null))],
            [
              'assignee CHANGED FROM EMPTY',
              (i) => changed(i, 'assignee', { from: (f) => f === null }),
            ],
            [
              'assignee CHANGED TO EMPTY',
              (i) => changed(i, 'assignee', { to: (_, t) => t === null }),
            ],
            [
              'assignee CHANGED FROM u0 TO u1',
              (i) =>
                changed(i, 'assignee', { from: (f) => f === user(0), to: (_, t) => t === user(1) }),
            ],
            ['labels WAS a', (i) => was(i, 'labels', hasLabel('a'))],
            [
              'labels WAS IN (a, b) DURING (2026-01-03, 2026-01-09)',
              (i) => was(i, 'labels', hasLabel('a', 'b'), during(3, 9)),
            ],
            ['labels CHANGED TO b', (i) => changed(i, 'labels', { to: moved('b', 'to') })],
            [
              'labels CHANGED FROM a BY u1',
              (i) => changed(i, 'labels', { from: moved('a', 'from'), by: [1] }),
            ],
            ['labels WAS EMPTY ON 2026-01-12', (i) => was(i, 'labels', is(null), on(12))],
            [`ticketLink WAS ${keys[0]}`, (i) => seen(0) && was(i, 'link', linkTo(0))],
            [
              `ticketLink WAS ${keys[1]} AFTER 2026-01-08`,
              (i) => seen(1) && was(i, 'link', linkTo(1), after(8)),
            ],
            [
              `ticketLink CHANGED TO ${keys[2]}`,
              (i) => seen(2) && changed(i, 'link', { to: (_, t) => linkTo(2)(t) }),
            ],
            [
              `ticketLink CHANGED FROM ${keys[0]} BEFORE 2026-01-15`,
              (i) => seen(0) && changed(i, 'link', { from: (f) => linkTo(0)(f), ...before(15) }),
            ],
            // A type's name takes its links either way; a description, the links it reads on.
            ['ticketLinkType WAS blocks', (i) => was(i, 'link', linkOf(0))],
            ['ticketLinkType WAS "is blocked by"', (i) => was(i, 'link', linkOf(0, 'inward'))],
            [
              'ticketLinkType WAS Relates DURING (2026-01-04, 2026-01-11)',
              (i) => was(i, 'link', linkOf(1), during(4, 11)),
            ],
            ['ticketLink CHANGED', (i) => changed(i, 'link')],
            ['stage WAS closed', (i) => was(i, 'status', is(sid[3] as string))],
            [
              'stage WAS NOT active BY u2',
              (i) => !was(i, 'status', is(sid[1] as string, sid[2] as string), { by: [2] }),
            ],
            ['creator WAS u1', (i) => creator(i) === 1],
            ['creator WAS u1 BEFORE 2026-01-03', (i) => creator(i) === 1 && created(i) < at(3)],
            ['creator CHANGED', () => false],
            [
              'status WAS Closed BY u0 OR assignee CHANGED BY u1',
              (i) =>
                was(i, 'status', is(sid[3] as string), { by: [0] }) ||
                changed(i, 'assignee', { by: [1] }),
            ],
          ];
          const filter = await authorizer.ticketFilter(ws, principal);
          for (const [q, names] of cases) {
            const { compiled } = await prepareSearch({
              db,
              workspaceId: ws,
              catalog,
              catalogue,
              filter,
              q,
              currentUserId: principal.userId,
              now: new Date('2026-02-01T00:00:00Z'),
            });
            const got = (await compiled.page(100).execute(db)).rows.map((r) => r.id).sort();
            const count = (await compiled.count(100).execute(db)).rows[0]?.n;
            const expected = world
              .map((_, i) => (seen(i) && names(i) ? (ids[i] as number) : null))
              .filter((id): id is number => id !== null)
              .sort();
            expect(got, `u${person}: ${q}`).toEqual(expected);
            expect(count, `u${person}: ${q} (count)`).toBe(expected.length);
          }
        }
      }),
      { numRuns: Number(process.env.SEARCH_HISTORY_RUNS ?? 15) },
    );
    // Fifteen worlds of six tickets with up to eight changes each, two people, 44 queries.
  }, 240_000);
});
