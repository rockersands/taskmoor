import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { issueApiToken } from '../tokens/api-tokens';
import {
  DEMO_TRACK_KEYS,
  DEMO_TRACKS,
  type DemoTrackKey,
  descriptionFor,
  labelsFor,
  loadedId,
  STATE_LABELS,
  type Stage,
  stageFor,
  stateLabels,
  summaryFor,
  type TicketRow,
} from './tickets-file';

/** One API call, with the token as its bearer; `path` starts after `/api/v1`. */
export type DemoRequest = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  token: string,
) => Promise<{ status: number; json: unknown }>;

export interface LoadSummary {
  tracksCreated: number;
  /** Of the three, those taken back out of the trash. */
  tracksRestored: number;
  ticketsCreated: number;
  /** New tickets moved to their state's stage. */
  moved: number;
  /** Tickets loaded before whose stage or state labels followed tickets.md. */
  updated: number;
  /** Tickets loaded before and left as they were. */
  unchanged: number;
  tracksTrashed: number;
  /** What could not be done, by ticket or track; never a token or a link. */
  problems: string[];
}

interface Track {
  id: number;
  key: string;
}
interface Ticket {
  id: number;
  summary: string;
  status: { stage: Stage };
  labels: string[];
}
interface Transition {
  id: number;
  to: { stage: Stage };
}

/** How long the loader's token could live if the process died before deleting it. */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Loads tickets.md's rows into a running Taskmoor as its first active site administrator,
 * through the API (T-239): the BE, FE and FL tracks, a ticket per row not loaded before, each
 * at its state's stage, then every other track to the trash. A ticket loaded before (its summary
 * starts with its T id) is not made again; its stage and state labels follow the file. The token
 * exists only for this call: it lives in memory and its row is deleted before this returns.
 */
export async function loadDemoTickets(
  db: Kysely<Database>,
  rows: readonly TicketRow[],
  request: DemoRequest,
): Promise<LoadSummary> {
  const admin = await db
    .selectFrom('app_user')
    .select(['id', 'workspace_id'])
    .where('is_site_admin', '=', true)
    .where('kind', '=', 'person')
    .where('deactivated_at', 'is', null)
    .orderBy('id')
    .executeTakeFirst();
  if (!admin) throw new Error('the site has no active site administrator');
  const issued = await issueApiToken(db, {
    workspaceId: admin.workspace_id,
    userId: admin.id,
    name: 'Demo ticket loader',
    scopes: ['read', 'write', 'admin'],
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
    createdBy: admin.id,
  });
  try {
    return await load(rows, (method, path, body) => request(method, path, body, issued.token));
  } finally {
    await db.deleteFrom('api_token').where('id', '=', issued.id).execute();
  }
}

type Call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

const brief = (json: unknown) => JSON.stringify(json ?? null).slice(0, 200);

async function load(rows: readonly TicketRow[], call: Call): Promise<LoadSummary> {
  const done: LoadSummary = {
    tracksCreated: 0,
    tracksRestored: 0,
    ticketsCreated: 0,
    moved: 0,
    updated: 0,
    unchanged: 0,
    tracksTrashed: 0,
    problems: [],
  };

  // The three tracks.
  const found = await call('GET', `/tracks?keys=${DEMO_TRACK_KEYS.join(',')}&archived=include`);
  if (found.status !== 200) throw new Error(`listing the tracks: ${found.status}`);
  const present = new Set(
    ((found.json as { tracks?: Track[] }).tracks ?? []).map((t) => t.key.toUpperCase()),
  );
  // One someone put in the trash comes back with its tickets, as its key is still taken.
  if (DEMO_TRACK_KEYS.some((key) => !present.has(key))) {
    const trash = await call('GET', '/trash/tracks');
    for (const t of (trash.json as { tracks?: Track[] }).tracks ?? []) {
      const key = t.key.toUpperCase();
      if (!(DEMO_TRACK_KEYS as string[]).includes(key) || present.has(key)) continue;
      const res = await call('POST', `/tracks/${t.id}/undelete`);
      if (res.status >= 300) throw new Error(`track ${key} from the trash: ${res.status}`);
      present.add(key);
      done.tracksRestored += 1;
    }
  }
  for (const key of DEMO_TRACK_KEYS) {
    if (present.has(key)) continue;
    const res = await call('POST', '/tracks', {
      key,
      ...DEMO_TRACKS[key],
      mode: 'shared',
      type: 'software',
      template: 'kanban',
    });
    if (res.status >= 300) throw new Error(`track ${key}: ${res.status} ${brief(res.json)}`);
    done.tracksCreated += 1;
  }

  // Tickets loaded before, by the T id their summary starts with.
  const loaded = new Map<string, Ticket>();
  for (const key of DEMO_TRACK_KEYS) {
    let cursor: string | null = null;
    do {
      const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await call('GET', `/tickets?track=${key}&format=text&limit=200${after}`);
      if (page.status !== 200) throw new Error(`listing ${key}: ${page.status}`);
      const json = page.json as { tickets?: Ticket[]; next?: string | null };
      for (const t of json.tickets ?? []) {
        const id = loadedId(t.summary);
        if (id && !loaded.has(id)) loaded.set(id, t);
      }
      cursor = json.next ?? null;
    } while (cursor);
  }

  /** Moves a ticket to a stage by a transition it offers there; false with a problem if none. */
  async function moveTo(row: TicketRow, ticketId: number, stage: Stage) {
    const list = await call('GET', `/tickets/${ticketId}/transitions`);
    const options = (list.json as { transitions?: Transition[] }).transitions ?? [];
    const pick = options.find((t) => t.to.stage === stage);
    if (!pick) {
      done.problems.push(`${row.id}: no transition to the ${stage} stage`);
      return false;
    }
    const moved = await call('POST', `/tickets/${ticketId}/transitions`, {
      transitionId: pick.id,
    });
    if (moved.status >= 300) {
      done.problems.push(`${row.id}: move ${moved.status} ${brief(moved.json)}`);
      return false;
    }
    return true;
  }

  for (const row of rows) {
    const want = stageFor(row.state);
    const before = loaded.get(row.id);
    if (before) {
      // Loaded before: the stage and the state's labels follow the file; the rest is the demo's.
      let changed = false;
      if (before.status.stage !== want && (await moveTo(row, before.id, want))) changed = true;
      const others = before.labels.filter((l) => !(STATE_LABELS as readonly string[]).includes(l));
      const labels = [...others, ...stateLabels(row.state)];
      const same =
        labels.length === before.labels.length && labels.every((l) => before.labels.includes(l));
      if (!same) {
        const res = await call('PATCH', `/tickets/${before.id}`, { labels });
        if (res.status >= 300) done.problems.push(`${row.id}: labels ${res.status}`);
        else changed = true;
      }
      if (changed) done.updated += 1;
      else done.unchanged += 1;
      continue;
    }
    const res = await call('POST', '/tickets?format=markdown', {
      track: row.track satisfies DemoTrackKey,
      summary: summaryFor(row),
      description: descriptionFor(row),
      labels: labelsFor(row),
    });
    if (res.status >= 300) {
      done.problems.push(`${row.id}: create ${res.status} ${brief(res.json)}`);
      continue;
    }
    done.ticketsCreated += 1;
    const ticket = (res.json as { ticket: Ticket }).ticket;
    if (ticket.status.stage !== want && (await moveTo(row, ticket.id, want))) done.moved += 1;
  }

  // The sample tracks go to the trash; only the three stay.
  const others: Track[] = [];
  let after: string | null = null;
  do {
    const from: string = after ? `&after=${encodeURIComponent(after)}` : '';
    const page = await call('GET', `/tracks?archived=include&limit=100${from}`);
    if (page.status !== 200) throw new Error(`listing the tracks: ${page.status}`);
    const json = page.json as { tracks?: Track[]; next?: string | null };
    for (const t of json.tracks ?? []) {
      if (!(DEMO_TRACK_KEYS as string[]).includes(t.key.toUpperCase())) others.push(t);
    }
    after = json.next ?? null;
  } while (after);
  for (const t of others) {
    const res = await call('DELETE', `/tracks/${t.id}`);
    // 409: already in the trash.
    if (res.status >= 300 && res.status !== 409) {
      done.problems.push(`trash ${t.key}: ${res.status}`);
    } else done.tracksTrashed += 1;
  }
  return done;
}

/**
 * A `DemoRequest` against a server at `baseUrl` (the demo's own), waiting out its rate limits.
 * The token goes only into the request's header.
 */
export function fetchRequest(baseUrl: string): DemoRequest {
  return async (method, path, body, token) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await fetch(`${baseUrl}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? '2');
        const seconds = Number.isFinite(wait) ? Math.min(Math.max(wait, 1), 30) : 2;
        await new Promise((r) => setTimeout(r, seconds * 1000));
        continue;
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
    throw new Error(`${method} ${path.split('?')[0]}: still rate limited`);
  };
}
