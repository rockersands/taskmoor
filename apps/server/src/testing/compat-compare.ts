import type { InjectOptions } from 'fastify';

/**
 * A workspace's imported content as plain data, for comparing a Cloud REST import's target with
 * its source (M1-095): tickets with their fields, comments, time entries and history, boards
 * with their columns, sprints with their tickets. Read through the native API as a site
 * administrator; ids are left out (they differ between the two), names and keys kept. Used by
 * the importer's tests only.
 */
type Call = (options: InjectOptions) => Promise<{ status: number; body: unknown }>;
// biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
type Any = any;

/** Keys that differ between two workspaces holding the same work, or are not imported. */
const DROPPED = new Set([
  'id',
  'version',
  'can',
  'reactions',
  'followerCount',
  'voteCount',
  'rank',
  'adfAttrs',
  'mentionSuggestionChar',
  'effortRatio',
  'mayManage',
  // What the reader may change: access, not content, and in the order of each side's layout.
  'mayEdit',
  'editableFields',
  'lock',
  'next',
]);

export function strip(value: unknown): Any {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    if (DROPPED.has(key)) continue;
    out[key] = strip((value as Record<string, unknown>)[key]);
  }
  return out;
}

async function get(call: Call, url: string): Promise<Any> {
  const res = await call({ method: 'GET', url });
  if (res.status !== 200) throw new Error(`GET ${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Custom values by field name, so two workspaces' field ids do not matter. */
async function fieldNames(call: Call): Promise<Map<string, string>> {
  const fields = (await get(call, '/api/v1/fields')).fields as Any[];
  return new Map(fields.map((f) => [String(f.id), String(f.name)]));
}

export interface ContentSnapshot {
  tickets: Record<string, Any>;
  boards: Any[];
}

/** History entries an import carries: the fields it maps, after the ticket was made. */
const HISTORY_FIELDS = new Set([
  'status',
  'assignee',
  'requester',
  'summary',
  'dueDate',
  'priority',
  'closeReason',
  'type',
  'labels',
  'originalEstimate',
  'remainingEstimate',
]);

export async function contentSnapshot(
  call: Call,
  tracks: readonly string[],
): Promise<ContentSnapshot> {
  const names = await fieldNames(call);
  const tickets: Record<string, Any> = {};
  const q = encodeURIComponent(`track in (${tracks.join(', ')}) ORDER BY key ASC`);
  const keys: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = await get(
      call,
      `/api/v1/search?q=${q}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    keys.push(...(page.tickets as Any[]).map((t) => String(t.key)));
    cursor = page.next ?? null;
    if (!cursor) break;
  }
  for (const key of keys) {
    const t = (await get(call, `/api/v1/tickets/${key}`)).ticket;
    const fields: Record<string, unknown> = {};
    for (const [id, value] of Object.entries((t.fields ?? {}) as Record<string, unknown>)) {
      fields[names.get(id) ?? id] = value;
    }
    const comments = (await get(call, `/api/v1/tickets/${key}/comments`)).comments as Any[];
    const time = (await get(call, `/api/v1/tickets/${key}/time-entries`)).timeEntries as Any[];
    const history = (await get(call, `/api/v1/tickets/${key}/history?order=asc&limit=200`))
      .changes as Any[];
    tickets[key] = strip({
      ...t,
      parent: t.parent?.key ?? null,
      fields,
      comments: comments.map((c) => ({
        author: c.author?.name ?? null,
        body: c.body,
        createdAt: c.createdAt,
        edited: c.edited ? { at: c.edited.at, by: c.edited.by?.name ?? null } : null,
      })),
      timeEntries: time.map((w) => ({
        author: w.author?.name ?? null,
        startedAt: w.startedAt,
        duration: w.duration,
        description: w.description,
      })),
      // What happened after creation, in the fields an import carries, by display text.
      history: history
        .filter((c) => HISTORY_FIELDS.has(String(c.field)) && c.at !== t.createdAt)
        .map((c) => ({
          field: c.field,
          at: c.at,
          by: c.by?.name ?? null,
          from: c.from?.display ?? c.from?.value ?? null,
          to: c.to?.display ?? c.to?.value ?? null,
        })),
    });
  }
  const statuses = (await get(call, '/api/v1/statuses')).statuses as Any[];
  const statusName = new Map(statuses.map((s) => [Number(s.id), String(s.name)]));
  const boards: Any[] = [];
  for (const b of (await get(call, '/api/v1/boards')).boards as Any[]) {
    const board = (await get(call, `/api/v1/boards/${b.id}`)).board;
    const sprints =
      board.kind === 'scrum'
        ? ((await get(call, `/api/v1/boards/${b.id}/sprints`)).sprints as Any[])
        : [];
    const withTickets = [];
    for (const s of sprints) {
      const found = await get(
        call,
        `/api/v1/search?q=${encodeURIComponent(`sprint = ${s.id} ORDER BY key ASC`)}&limit=200`,
      );
      withTickets.push({
        name: s.name,
        state: s.state,
        goal: s.goal,
        startAt: s.startAt,
        endAt: s.endAt,
        tickets: (found.tickets as Any[]).map((t) => t.key),
      });
    }
    boards.push({
      name: board.name,
      kind: board.kind,
      track: b.location?.track?.key ?? null,
      columns: ((board.columns ?? []) as Any[]).map((c) => ({
        name: c.name,
        statuses: ((c.statusIds ?? []) as number[]).map((id) => statusName.get(id) ?? id),
      })),
      sprints: withTickets,
    });
  }
  boards.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { tickets, boards };
}
