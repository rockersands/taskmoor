import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import {
  datasetTickets,
  EVAL_NOW,
  EVAL_TIME_ZONE,
  GROUPS,
  type Handle,
  PEOPLE,
  type TicketSpec,
  TRACKS,
} from './dataset';

/**
 * Seeding the eval dataset (M1-133; ADR-107) through the app's own API, in process: people,
 * groups, tracks with roles, releases and areas, a Points field, then every ticket with its
 * transitions and comments, each written by the person the dataset names. What the API cannot
 * set, the past, is set with SQL afterwards: creation, update, close and comment times, and the
 * times of each ticket's change history, all before `EVAL_NOW`.
 */
export interface SeededTicket {
  id: number;
  key: string;
  spec: TicketSpec;
  /** Comment ids by their names in the thread (c1, c2, ...). */
  comments: Record<string, number>;
}

export interface EvalWorld {
  app: FastifyInstance;
  db: Kysely<Database>;
  workspaceId: number;
  now: Date;
  timeZone: string;
  people: Record<Handle, { id: number; name: string; email: string }>;
  tracks: Record<string, number>;
  /** Tickets by their dataset name. */
  tickets: Record<string, SeededTicket>;
  /** The dataset name of a ticket id. */
  ticketName(id: number): string | undefined;
  /** A request to the app as this person (their session cookie). */
  as(handle: Handle, options: InjectOptions): Promise<LightMyRequestResponse>;
  /**
   * The same request to another app on this database, as this person (their session holds
   * there too): a candidate's app with AI features (M1-079).
   */
  asOn(
    app: FastifyInstance,
    handle: Handle,
    options: InjectOptions,
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(EVAL_NOW.getTime() - daysAgo * DAY);

/** The transitions of the default workflow (migration 0024) that reach each status. */
const PATH: Record<TicketSpec['status'], number[]> = {
  New: [],
  Active: [1],
  'In Review': [1, 2],
  Closed: [1, 2, 4],
};

let address = 0;
const nextAddress = () => `100.88.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

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

/** A rich-text document of one paragraph. */
export const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Seeds the dataset into an empty migrated database (workspace 1) and returns its world. */
export async function seedEvalDataset(db: Kysely<Database>): Promise<EvalWorld> {
  const app = await buildApp({ db, version: 'eval', roles: ['api'] });
  try {
    return await seed(app, db);
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function seed(app: FastifyInstance, db: Kysely<Database>): Promise<EvalWorld> {
  const ws = 1;
  // Made for this run and never written down.
  const password = `eval-${randomBytes(18).toString('base64url')}`;
  const cookies: Record<string, string> = {};
  const as = (who: string, options: InjectOptions, on: FastifyInstance = app) =>
    on.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });
  const ok = async (
    res: LightMyRequestResponse | Promise<LightMyRequestResponse>,
    what: string,
  ) => {
    const r = await res;
    if (r.statusCode >= 300) throw new Error(`${what}: ${r.statusCode} ${r.body}`);
    return r.body ? (r.json() as Record<string, unknown>) : {};
  };
  const signIn = async (who: string, email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
    });
    if (res.statusCode !== 200) throw new Error(`sign-in ${email}: ${res.statusCode}`);
    cookies[who] = sessionCookie(res.headers['set-cookie']);
  };

  // The site administrator is the one row the API cannot make: first-run setup would.
  await db
    .insertInto('app_user')
    .values({
      workspace_id: ws,
      email: 'eval-admin@example.com',
      name: 'Eval Admin',
      password_hash: await hashPassword(password),
      is_site_admin: true,
    })
    .execute();
  await signIn('admin', 'eval-admin@example.com');
  const admin = (options: InjectOptions) => as('admin', options);

  const people = {} as EvalWorld['people'];
  for (const p of PEOPLE) {
    const body = await ok(
      admin({
        method: 'POST',
        url: '/api/v1/users',
        payload: {
          email: p.email,
          name: p.name,
          password,
          timeZone: EVAL_TIME_ZONE,
          locale: p.locale,
        },
      }),
      `user ${p.handle}`,
    );
    people[p.handle] = { id: (body.user as { id: number }).id, name: p.name, email: p.email };
    await signIn(p.handle, p.email);
  }
  const groups: Record<string, number> = {};
  for (const name of GROUPS) {
    const body = await ok(
      admin({ method: 'POST', url: '/api/v1/groups', payload: { name } }),
      name,
    );
    groups[name] = (body.group as { id: number }).id;
  }
  for (const p of PEOPLE) {
    for (const g of p.groups) {
      await ok(
        admin({ method: 'PUT', url: `/api/v1/groups/${groups[g]}/members/${people[p.handle].id}` }),
        `member ${g}`,
      );
    }
  }
  const roles = (
    (await ok(admin({ method: 'GET', url: '/api/v1/roles' }), 'roles')).roles as {
      id: number;
      name: string;
    }[]
  ).reduce<Record<string, number>>((m, r) => {
    m[r.name] = r.id;
    return m;
  }, {});
  const priorities = Object.fromEntries(
    (
      (await ok(admin({ method: 'GET', url: '/api/v1/priorities' }), 'priorities')).priorities as {
        id: number;
        name: string;
      }[]
    ).map((p) => [p.name, p.id]),
  );
  const reasons = Object.fromEntries(
    (
      (await ok(admin({ method: 'GET', url: '/api/v1/close-reasons' }), 'reasons'))
        .closeReasons as {
        id: number;
        name: string;
      }[]
    ).map((r) => [r.name, r.id]),
  );
  const points = (
    (
      await ok(
        admin({
          method: 'POST',
          url: '/api/v1/fields',
          payload: { name: 'Points', type: 'number' },
        }),
        'Points',
      )
    ).field as { id: number }
  ).id;

  const tracks: Record<string, number> = {};
  const releases: Record<string, number> = {};
  const areas: Record<string, number> = {};
  const types: Record<string, Record<string, number>> = {};
  for (const t of TRACKS) {
    const body = await ok(
      admin({
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: t.key, name: t.name, mode: 'shared', ownerId: people[t.owner].id },
      }),
      `track ${t.key}`,
    );
    const id = (body.track as { id: number }).id;
    tracks[t.key] = id;
    for (const [role, list] of [
      ['Members', t.members],
      ['Viewers', t.viewers],
    ] as const) {
      for (const who of list) {
        await ok(
          admin({
            method: 'PUT',
            url: `/api/v1/tracks/${id}/roles/${roles[role]}/users/${people[who].id}`,
          }),
          `${role} ${who}`,
        );
      }
    }
    for (const r of t.releases) {
      const created = await ok(
        admin({
          method: 'POST',
          url: `/api/v1/tracks/${id}/releases`,
          payload: { name: r.name, releaseDate: r.releaseDate },
        }),
        `release ${r.name}`,
      );
      releases[`${t.key}:${r.name}`] = (created.release as { id: number }).id;
    }
    for (const a of t.areas) {
      const created = await ok(
        admin({ method: 'POST', url: `/api/v1/tracks/${id}/areas`, payload: { name: a } }),
        `area ${a}`,
      );
      areas[`${t.key}:${a}`] = (created.area as { id: number }).id;
    }
    const list = (
      await ok(admin({ method: 'GET', url: `/api/v1/tracks/${id}/ticket-types` }), 'types')
    ).ticketTypes as { id: number; name: string }[];
    types[t.key] = Object.fromEntries(list.map((x) => [x.name, x.id]));
  }

  const tickets: Record<string, SeededTicket> = {};
  for (const spec of datasetTickets()) {
    const body = await ok(
      as(spec.creator, {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: {
          track: spec.track,
          ticketTypeId: types[spec.track]?.[spec.type],
          summary: spec.summary,
          description: doc(spec.description),
          assigneeId: spec.assignee ? people[spec.assignee].id : null,
          priorityId: spec.priority ? priorities[spec.priority] : null,
          labels: [...spec.labels],
          areaIds: spec.areas.map((a) => areas[`${spec.track}:${a}`]),
          targetReleaseIds: spec.targetRelease
            ? [releases[`${spec.track}:${spec.targetRelease}`]]
            : [],
          foundInReleaseIds: spec.foundIn ? [releases[`${spec.track}:${spec.foundIn}`]] : [],
          ...(spec.due ? { dueDate: spec.due } : {}),
          ...(spec.points ? { fields: { [String(points)]: spec.points } } : {}),
          ...(spec.parent ? { parent: tickets[spec.parent]?.key } : {}),
        },
      }),
      `ticket ${spec.name}`,
    );
    const t = body.ticket as { id: number; key: string };
    tickets[spec.name] = { id: t.id, key: t.key, spec, comments: {} };
    const actor = spec.assignee ?? spec.creator;
    for (const transitionId of PATH[spec.status]) {
      await ok(
        as(actor, {
          method: 'POST',
          url: `/api/v1/tickets/${t.id}/transitions`,
          payload: {
            transitionId,
            ...(transitionId === 4
              ? { fields: { 'close-reason': reasons[spec.closeReason ?? 'Completed'] } }
              : {}),
          },
        }),
        `transition ${spec.name} ${transitionId}`,
      );
    }
    for (const c of spec.comments) {
      const created = await ok(
        as(c.author, {
          method: 'POST',
          url: `/api/v1/tickets/${t.id}/comments`,
          payload: {
            body: doc(c.text),
            ...(c.restrictedTo ? { visibility: { groupId: groups[c.restrictedTo] } } : {}),
          },
        }),
        `comment ${spec.name} ${c.ref}`,
      );
      (tickets[spec.name] as SeededTicket).comments[c.ref] = (created.comment as { id: number }).id;
    }
  }
  // Shipped releases last, so their tickets were planned into them while they were open.
  for (const t of TRACKS) {
    for (const r of t.releases.filter((x) => x.shipped)) {
      await ok(
        admin({
          method: 'POST',
          url: `/api/v1/releases/${releases[`${t.key}:${r.name}`]}/ship`,
          payload: { releaseDate: r.releaseDate },
        }),
        `ship ${r.name}`,
      );
    }
  }
  await backdate(db, Object.values(tickets));

  const byId = new Map(Object.entries(tickets).map(([name, t]) => [t.id, name]));
  return {
    app,
    db,
    workspaceId: ws,
    now: EVAL_NOW,
    timeZone: EVAL_TIME_ZONE,
    people,
    tracks,
    tickets,
    ticketName: (id) => byId.get(id),
    as: (handle, options) => as(handle, options),
    asOn: (other, handle, options) => as(handle, options, other),
    close: () => app.close(),
  };
}

/** Moves every ticket into the past the dataset gives it (the API writes "now"). */
async function backdate(db: Kysely<Database>, tickets: readonly SeededTicket[]): Promise<void> {
  for (const t of tickets) {
    const created = at(t.spec.createdDaysAgo);
    const updated = at(t.spec.updatedDaysAgo);
    await sql`UPDATE ticket SET created_at = ${created}, updated_at = ${updated},
                closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE ${updated}::timestamptz END
              WHERE id = ${t.id}`.execute(db);
    // The change sets in the order they were written, spread from creation to the last update.
    const { rows } = await sql<{ change_set: string }>`
      SELECT change_set FROM ticket_change WHERE ticket_id = ${t.id}
       GROUP BY change_set ORDER BY min(id)`.execute(db);
    const span = updated.getTime() - created.getTime();
    for (const [i, r] of rows.entries()) {
      const when = new Date(
        created.getTime() + (rows.length > 1 ? (span * i) / (rows.length - 1) : 0),
      );
      await sql`UPDATE ticket_change SET at = ${when}
                 WHERE ticket_id = ${t.id} AND change_set = ${r.change_set}`.execute(db);
    }
    for (const c of t.spec.comments) {
      const when = at(c.daysAgo);
      await sql`UPDATE ticket_comment SET created_at = ${when}, updated_at = ${when}
                 WHERE id = ${t.comments[c.ref]}`.execute(db);
    }
  }
  // The side tables copy each ticket's creation time (ADR-008).
  for (const table of ['v_text', 'v_number', 'v_date', 'v_time', 'v_user', 'v_option']) {
    await sql`UPDATE ${sql.table(table)} v SET created_at = k.created_at
               FROM ticket k WHERE k.id = v.ticket_id`.execute(db);
  }
  await sql`ANALYZE`.execute(db);
}
