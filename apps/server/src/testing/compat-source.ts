import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import type { CloudResponse, Transport } from '../import/cloud/client';

/**
 * A Taskmoor server populated with synthetic work, as the source of a Cloud REST import's tests
 * (M1-095; ADR-094). It speaks the Jira-compatible API (ADR-086), so the importer reads it
 * exactly as it reads any such server; its answers are what the committed replay fixtures were
 * recorded from. Nothing here is real data, and the token is made at run time.
 */
export const SOURCE_URL = 'https://source.example.test';

export interface CompatSource {
  app: FastifyInstance;
  /** `Basic` with the administrator's email and a token made for this run. */
  authorization: string;
  email: string;
  token: string;
  /** The compatible API in process, as a transport. */
  transport: Transport;
  /** Native calls as the administrator, for comparing. */
  admin: (options: InjectOptions) => Promise<{ status: number; body: unknown }>;
  people: Record<'ada' | 'bea' | 'cyd', number>;
}

let address = 0;
const nextAddress = () => `100.95.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/** The compatible API of an app in process as a transport. */
export function injectTransport(app: FastifyInstance): Transport {
  return async (request, authorization) => {
    const res = await app.inject({
      method: request.method,
      url: request.path,
      remoteAddress: nextAddress(),
      headers: {
        authorization,
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { payload: JSON.stringify(request.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    const headers: CloudResponse['headers'] = {};
    const retry = res.headers['retry-after'];
    if (retry !== undefined) headers['retry-after'] = String(retry);
    return { status: res.statusCode, headers, body };
  };
}

const doc = (...parts: ({ text: string } | { mention: number; label: string })[]) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: parts.map((p) =>
        'text' in p
          ? { type: 'text', text: p.text }
          : { type: 'mention', attrs: { id: String(p.mention), label: p.label } },
      ),
    },
  ],
});

/** Builds the source app on `db` and fills it: two tracks, fields, tickets, boards, sprints. */
export async function buildCompatSource(db: Kysely<Database>): Promise<CompatSource> {
  const app = await buildApp({ db, version: 'test', roles: ['api'], publicUrl: SOURCE_URL });
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  const people = {} as CompatSource['people'];
  for (const [key, name, admin] of [
    ['ada', 'Ada Admin', true],
    ['bea', 'Bea Builder', false],
    ['cyd', 'Cyd Checker', false],
  ] as const) {
    const row = await db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: `${key}@example.com`,
        name,
        password_hash: hash,
        is_site_admin: admin,
        time_zone: 'Europe/Madrid',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    people[key] = row.id;
  }
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { email: 'ada@example.com', password },
    remoteAddress: nextAddress(),
  });
  const cookies = [signIn.headers['set-cookie']].flat().filter(Boolean) as string[];
  const cookie =
    (cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
  const admin = async (options: InjectOptions) => {
    const res = await app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  // biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
  const must = async (options: InjectOptions, status = 200): Promise<any> => {
    const res = await admin(options);
    if (res.status !== status) {
      throw new Error(
        `${options.method} ${options.url}: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body;
  };

  // Tracks, people's roles, releases and areas.
  const members = await db
    .selectFrom('role')
    .select('id')
    .where('name', '=', 'Members')
    .executeTakeFirstOrThrow();
  const tracks: Record<string, number> = {};
  for (const [key, name, type] of [
    ['ALP', 'Alpine', 'software'],
    ['BET', 'Beta desk', 'business'],
  ] as const) {
    tracks[key] = (
      await must(
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name, mode: 'shared', type, description: `The ${name} track.` },
        },
        201,
      )
    ).track.id;
    for (const who of [people.bea, people.cyd]) {
      await must(
        { method: 'PUT', url: `/api/v1/tracks/${tracks[key]}/roles/${members.id}/users/${who}` },
        204,
      );
    }
  }
  const r1 = (
    await must(
      {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.ALP}/releases`,
        payload: { name: '1.0', releaseDate: '2026-12-01' },
      },
      201,
    )
  ).release.id;
  const r2 = (
    await must(
      { method: 'POST', url: `/api/v1/tracks/${tracks.ALP}/releases`, payload: { name: '2.0' } },
      201,
    )
  ).release.id;
  const api = (
    await must(
      {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.ALP}/areas`,
        payload: { name: 'API', ownerId: people.bea, defaultAssignee: 'area_owner' },
      },
      201,
    )
  ).area.id;
  const ui = (
    await must(
      { method: 'POST', url: `/api/v1/tracks/${tracks.ALP}/areas`, payload: { name: 'UI' } },
      201,
    )
  ).area.id;

  // Custom fields of the kinds the importer reads.
  const field = async (payload: Record<string, unknown>) =>
    (await must({ method: 'POST', url: '/api/v1/fields', payload }, 201)).field;
  const severity = await field({
    name: 'Severity',
    type: 'select',
    context: { options: [{ value: 'S1' }, { value: 'S2' }, { value: 'S3' }] },
  });
  const tags = await field({
    name: 'Tags',
    type: 'select',
    multiple: true,
    context: { options: [{ value: 'alpha' }, { value: 'beta' }, { value: 'gamma' }] },
  });
  const points = await field({ name: 'Points', type: 'number' });
  const reviewer = await field({ name: 'Reviewer', type: 'user' });
  const topics = await field({ name: 'Topics', type: 'labels' });
  const notes = await field({ name: 'Notes', type: 'paragraph' });
  const customer = await field({ name: 'Customer', type: 'text' });
  const target = await field({ name: 'Target day', type: 'date' });
  const option = (f: { contexts: { options: { id: number; value: string }[] }[] }, v: string) =>
    f.contexts[0]?.options.find((o) => o.value === v)?.id as number;

  const subtype = (
    await db
      .selectFrom('ticket_type as t')
      .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
      .select('t.id')
      .where('l.kind', '=', 'subticket')
      .executeTakeFirstOrThrow()
  ).id;
  // The standard-level types each track offers: subtickets go under them.
  const standardTypes = new Set(
    (
      await db
        .selectFrom('ticket_type as t')
        .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
        .select('t.id')
        .where('l.kind', '=', 'standard')
        .execute()
    ).map((r) => r.id),
  );
  const offered: Record<string, number[]> = {};
  for (const [key, id] of Object.entries(tracks)) {
    const list = (await must({ method: 'GET', url: `/api/v1/tracks/${id}/ticket-types` }))
      .ticketTypes as { id: number }[];
    offered[key] = list.map((t) => t.id).filter((t) => standardTypes.has(t));
  }
  const priorities = (await must({ method: 'GET', url: '/api/v1/priorities' })).priorities as {
    id: number;
  }[];

  // Tickets: varied people, priorities, labels, dates, estimates and custom values.
  const ticket = async (payload: Record<string, unknown>) =>
    (await must({ method: 'POST', url: '/api/v1/tickets', payload }, 201)).ticket as {
      id: number;
      key: string;
    };
  const made: { id: number; key: string }[] = [];
  const assignees = [people.ada, people.bea, people.cyd, null];
  for (let i = 1; i <= 18; i++) {
    const values: Record<string, unknown> = {};
    if (i % 2 === 0) values[severity.id] = option(severity, ['S1', 'S2', 'S3'][i % 3] as string);
    if (i % 3 === 0) values[tags.id] = [option(tags, 'alpha'), option(tags, 'gamma')];
    if (i % 4 === 1) values[points.id] = i * 1.5;
    if (i % 5 === 0) values[reviewer.id] = people.cyd;
    if (i % 3 === 1) values[topics.id] = ['import', `topic-${i % 4}`];
    if (i % 6 === 0)
      values[notes.id] = doc({ text: 'Asked ' }, { mention: people.bea, label: 'Bea' });
    if (i % 4 === 2) values[customer.id] = `Customer ${i}`;
    if (i % 7 === 3) values[target.id] = `2026-12-${String(i).padStart(2, '0')}`;
    made.push(
      await ticket({
        track: i <= 12 ? 'ALP' : 'BET',
        ticketTypeId: (offered[i <= 12 ? 'ALP' : 'BET'] as number[])[
          i % (offered[i <= 12 ? 'ALP' : 'BET'] as number[]).length
        ],
        summary: `Synthetic ticket ${i}`,
        ...(i % 3 !== 2
          ? {
              description: doc(
                { text: `Steps for ticket ${i}, with ` },
                { mention: people.ada, label: 'Ada' },
              ),
            }
          : {}),
        assigneeId: assignees[i % assignees.length],
        ...(i % 2 === 1 ? { requesterId: people.bea } : {}),
        priorityId: priorities[i % priorities.length]?.id,
        labels: i % 2 === 0 ? ['synthetic', `wave-${i % 3}`] : [],
        ...(i % 5 === 1 ? { dueDate: `2026-11-${String(10 + i).padStart(2, '0')}` } : {}),
        ...(i % 4 === 0 ? { originalEstimate: 3600 * ((i % 5) + 1) } : {}),
        ...(i <= 12 && i % 3 === 0 ? { targetReleaseIds: [r1] } : {}),
        ...(i <= 12 && i % 4 === 0 ? { foundInReleaseIds: [r2] } : {}),
        ...(i <= 12 && i % 2 === 1 ? { areaIds: [i % 4 === 1 ? api : ui] } : {}),
        ...(Object.keys(values).length > 0 ? { fields: values } : {}),
      }),
    );
  }
  // Subtickets under three of them.
  for (const [n, parent] of [
    [1, 0],
    [2, 0],
    [3, 4],
    [4, 13],
  ] as const) {
    const p = made[parent] as { key: string };
    made.push(
      await ticket({
        track: p.key.split('-')[0],
        ticketTypeId: subtype,
        parent: p.key,
        summary: `Subticket ${n} of ${p.key}`,
        assigneeId: people.cyd,
      }),
    );
  }

  // History: renames, reassignments and transitions; comments, an edit; time.
  for (const t of made.slice(0, 6)) {
    await must({
      method: 'PATCH',
      url: `/api/v1/tickets/${t.key}`,
      payload: { summary: `${t.key} renamed`, assigneeId: people.bea },
    });
  }
  for (const t of made.filter((_, i) => i % 3 === 0)) {
    const transitions = (await must({ method: 'GET', url: `/api/v1/tickets/${t.key}/transitions` }))
      .transitions as { id: number; name: string }[];
    // The default workflow's first transition leads to New, where these tickets already are.
    const start = transitions.find((x) => x.name === 'Active');
    if (start) {
      await must({
        method: 'POST',
        url: `/api/v1/tickets/${t.key}/transitions`,
        payload: { transitionId: start.id },
      });
    }
  }
  for (const [i, t] of made.entries()) {
    if (i % 2 !== 0) continue;
    const c = (
      await must(
        {
          method: 'POST',
          url: `/api/v1/tickets/${t.key}/comments`,
          payload: {
            body: doc({ text: `First look at ${t.key}, ` }, { mention: people.cyd, label: 'Cyd' }),
          },
        },
        201,
      )
    ).comment;
    if (i % 4 === 0) {
      await must({
        method: 'PATCH',
        url: `/api/v1/tickets/${t.key}/comments/${c.id}`,
        payload: { body: doc({ text: `Edited look at ${t.key}` }) },
      });
    }
  }
  for (const [i, t] of made.entries()) {
    if (i % 3 !== 1) continue;
    await must(
      {
        method: 'POST',
        url: `/api/v1/tickets/${t.key}/time-entries`,
        payload: { duration: `${(i % 3) + 1}h 15m`, description: `Work on ${t.key}` },
      },
      201,
    );
  }

  // Boards: a Scrum board with an active and a future sprint, and a Kanban board.
  const scrum = (
    await must(
      {
        method: 'POST',
        url: '/api/v1/boards',
        payload: {
          name: 'Alpine sprints',
          kind: 'scrum',
          trackId: tracks.ALP,
          source: { query: 'track = ALP' },
        },
      },
      201,
    )
  ).board.id;
  await must(
    {
      method: 'POST',
      url: '/api/v1/boards',
      payload: {
        name: 'Beta flow',
        kind: 'kanban',
        trackId: tracks.BET,
        source: { query: 'track = BET' },
      },
    },
    201,
  );
  const sprint1 = (
    await must(
      {
        method: 'POST',
        url: `/api/v1/boards/${scrum}/sprints`,
        payload: { name: 'Alpine 1', goal: 'First slice' },
      },
      201,
    )
  ).sprint.id;
  const sprint2 = (
    await must(
      { method: 'POST', url: `/api/v1/boards/${scrum}/sprints`, payload: { name: 'Alpine 2' } },
      201,
    )
  ).sprint.id;
  const alp = made.filter((t) => t.key.startsWith('ALP-'));
  await must({
    method: 'POST',
    url: `/api/v1/sprints/${sprint1}/tickets`,
    payload: { tickets: alp.slice(0, 4).map((t) => t.key) },
  });
  await must({
    method: 'POST',
    url: `/api/v1/sprints/${sprint2}/tickets`,
    payload: { tickets: alp.slice(4, 7).map((t) => t.key) },
  });
  await must({
    method: 'POST',
    url: `/api/v1/sprints/${sprint1}/start`,
    payload: { startAt: '2026-10-26T09:00:00.000Z', endAt: '2026-11-09T17:00:00.000Z' },
  });

  // Scripts sign in with Basic: the email address and an API token made now.
  const made1 = await must(
    {
      method: 'POST',
      url: '/api/v1/account/tokens',
      payload: { name: 'cloud import source', scopes: ['read', 'admin'], expiresInDays: 1 },
    },
    201,
  );
  const token = String(made1.token);
  const email = 'ada@example.com';
  return {
    app,
    authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    email,
    token,
    transport: injectTransport(app),
    admin,
    people,
  };
}
