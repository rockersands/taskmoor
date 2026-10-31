import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type ClientStats, type CloudClient, CloudRequestError, withQuery } from './client';

/**
 * The fetch of a Cloud REST import (M1-095; IMP-002, IMP-009; ADR-094): reads the source over
 * its Jira-compatible API into the run's staging rows (`import_staged`), in steps, and commits
 * where it got to (`import_run.fetch_state`) with each page it staged. A run that stops, a
 * worker that dies or a server that keeps refusing loses at most the page in hand: the next
 * attempt starts from the committed state, and staging the same page again changes nothing.
 *
 * 1. `config`: custom fields, issue types, priorities, resolutions, statuses, link types and
 *    the projects (each with its lead, versions and components).
 * 2. `search`: issue ids by token search (`/search/jql`, `nextPageToken`), each page's issues
 *    by bulk fetch (`/issue/bulkfetch`). A page token the server no longer takes starts the
 *    search again (staging is idempotent).
 * 3. `details`: each issue's changelog, comments and worklogs, a few issues at a time.
 * 4. `agile`: boards (`/rest/agile/1.0`) with their configuration, sprints and the issues in
 *    each sprint; a server without the agile API leaves them out with a note.
 * 5. `people`: each person seen without an address, looked up (`/user?accountId=`), since
 *    issues and comments name people without one; the address stays hidden where the server
 *    hides it.
 * 6. `order`: each issue's depth below its parent, so parents load first.
 *
 * People are staged as they are seen (leads, issue people, authors, people values), the first
 * sighting kept. Options of select fields are staged from the values the issues hold, since
 * the compatible API this reads has no option listing.
 */
// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
type Any = any;
type Db = Kysely<Database>;

export const STEPS = ['config', 'search', 'details', 'agile', 'people', 'order'] as const;
export type FetchStep = (typeof STEPS)[number];

export interface FetchSettings {
  /** Project keys to import; null: every project the token sees. */
  projects: string[] | null;
  /** The issues to import, as a query; null: every issue of those projects. */
  jql: string | null;
  /** Issues per search page and bulk fetch (at most 100). */
  pageSize: number;
  /** Issues whose details are fetched per committed chunk. */
  detailChunk?: number;
}

export interface FetchState {
  step?: FetchStep;
  done?: boolean;
  /** The next ordinal to give a staged row. */
  seq?: number;
  search?: { token: string | null; pages: number; restarts: number };
  /** The last staged ticket (by ordinal) whose details are staged. */
  details?: { after: number };
  /** The last board (by id) staged; the agile API's absence. */
  agile?: { after: number; unavailable?: boolean };
  /** The last person (by ordinal) looked up. */
  people?: { after: number };
  /** The client's counters, summed over every attempt. */
  stats?: ClientStats;
}

interface Staged {
  kind: string;
  id: string;
  data: JsonValue;
  label?: string | null;
  /** First sighting wins: people and options seen again are not rewritten. */
  keep?: boolean;
}

const API = '/rest/api/3';
const AGILE = '/rest/agile/1.0';
const enc = encodeURIComponent;
const MAX_PAGES = 100_000;

/** A response without the `self` links and avatars, which the mapping never reads. */
export function trim(value: unknown): Any {
  if (Array.isArray(value)) return value.map(trim);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'self' || k === 'avatarUrls' || k === 'iconUrl' || k === 'expand') continue;
    out[k] = trim(v);
  }
  return out;
}

/** A person as the API gives one, or null; the source id is the account id. */
function person(u: Any): Staged | null {
  if (!u || typeof u !== 'object' || u.accountId === undefined || u.accountId === null) {
    return null;
  }
  return {
    kind: 'user',
    id: String(u.accountId),
    label: String(u.displayName ?? u.accountId),
    data: trim({
      accountId: String(u.accountId),
      displayName: u.displayName ?? null,
      emailAddress: u.emailAddress ?? null,
      active: u.active !== false,
      timeZone: u.timeZone ?? null,
      accountType: u.accountType ?? null,
    }),
    keep: true,
  };
}

const push = (out: Staged[], s: Staged | null) => {
  if (s) out.push(s);
};

/** The people an issue names and the options its select values name. */
function issueParts(issue: Any, fields: Map<string, FieldInfo>): Staged[] {
  const out: Staged[] = [];
  const f = issue.fields ?? {};
  for (const k of ['assignee', 'reporter', 'creator']) push(out, person(f[k]));
  for (const [key, value] of Object.entries(f as Record<string, Any>)) {
    const info = fields.get(key);
    if (!info || value === null || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (info.items === 'user') push(out, person(v));
      if (info.items === 'option' && v && typeof v === 'object' && v.id !== undefined) {
        out.push(option(info, v, null));
        if (v.child?.id !== undefined) out.push(option(info, v.child, String(v.id)));
      }
    }
  }
  return out;
}

function option(info: FieldInfo, v: Any, parent: string | null): Staged {
  return {
    kind: 'field_option',
    id: String(v.id),
    label: String(v.value ?? v.id),
    data: { field: info.id, value: String(v.value ?? ''), parent },
    keep: true,
  };
}

/** What the fetch needs to know of a custom field: its id and what its values name. */
interface FieldInfo {
  key: string;
  id: string;
  items: 'user' | 'option' | 'other';
}

/** The option and people fields among the custom fields, by key (`customfield_10010`). */
export function fieldInfo(fields: readonly Any[]): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  for (const f of fields) {
    const m = /^customfield_(\d+)$/.exec(String(f.id ?? ''));
    if (!f.custom || !m) continue;
    const custom = String(f.schema?.custom ?? '');
    const type = String(f.schema?.items ?? f.schema?.type ?? '');
    const kind = custom.split(':').pop() ?? '';
    const items: FieldInfo['items'] =
      type === 'user' || /userpicker$/.test(kind)
        ? 'user'
        : type === 'option' ||
            type === 'option-with-child' ||
            /select|radiobuttons|multicheckboxes|cascading/.test(kind)
          ? 'option'
          : 'other';
    out.set(String(f.id), { key: String(f.id), id: m[1] as string, items });
  }
  return out;
}

export class CloudFetcher {
  constructor(
    private readonly db: Db,
    private readonly target: { id: string; workspaceId: number },
    private readonly client: CloudClient,
    private readonly settings: FetchSettings,
  ) {}

  async state(): Promise<FetchState> {
    const row = await this.db
      .selectFrom('import_run')
      .select('fetch_state')
      .where('id', '=', this.target.id)
      .executeTakeFirstOrThrow();
    return row.fetch_state as FetchState;
  }

  /** The client's counters at the last commit: what came after joins the next one. */
  private committed: ClientStats = {
    requests: 0,
    retries: 0,
    throttled: 0,
    failures: 0,
    waitedMs: 0,
  };

  /** Stages rows and writes the new state in one transaction. */
  private async commit(state: FetchState, rows: readonly Staged[]): Promise<void> {
    const now = { ...this.client.stats };
    const was = state.stats ?? { requests: 0, retries: 0, throttled: 0, failures: 0, waitedMs: 0 };
    const c = this.committed;
    state.stats = {
      requests: was.requests + now.requests - c.requests,
      retries: was.retries + now.retries - c.retries,
      throttled: was.throttled + now.throttled - c.throttled,
      failures: was.failures + now.failures - c.failures,
      waitedMs: was.waitedMs + now.waitedMs - c.waitedMs,
    };
    await this.db.transaction().execute(async (trx) => {
      await this.stage(trx, state, rows);
      await trx
        .updateTable('import_run')
        .set({ fetch_state: JSON.stringify(state), updated_at: new Date() })
        .where('id', '=', this.target.id)
        .execute();
    });
    this.committed = now;
  }

  private async stage(trx: Transaction<Database>, state: FetchState, rows: readonly Staged[]) {
    // One row per kind and id within a page; the last sighting, or the first for kept kinds.
    const unique = new Map<string, Staged>();
    for (const r of rows) {
      const key = `${r.kind}\u0000${r.id}`;
      if (r.keep && unique.has(key)) continue;
      unique.set(key, r);
    }
    const list = [...unique.values()];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const values = chunk.map((r) => {
        state.seq = (state.seq ?? 0) + 1;
        return {
          run_id: this.target.id,
          workspace_id: this.target.workspaceId,
          kind: r.kind,
          source_id: r.id,
          ordinal: state.seq,
          label: r.label ?? null,
          data: JSON.stringify(r.data),
          keep: r.keep === true,
        };
      });
      const kept = values.filter((v) => v.keep).map(({ keep, ...v }) => v);
      const replaced = values.filter((v) => !v.keep).map(({ keep, ...v }) => v);
      if (kept.length > 0) {
        await trx
          .insertInto('import_staged')
          .values(kept)
          .onConflict((oc) => oc.columns(['run_id', 'kind', 'source_id']).doNothing())
          .execute();
      }
      if (replaced.length > 0) {
        await trx
          .insertInto('import_staged')
          .values(replaced)
          .onConflict((oc) =>
            oc.columns(['run_id', 'kind', 'source_id']).doUpdateSet((eb) => ({
              data: eb.ref('excluded.data'),
              label: eb.ref('excluded.label'),
            })),
          )
          .execute();
      }
    }
  }

  private get = (path: string) => this.client.request({ method: 'GET', path }) as Promise<Any>;
  private post = (path: string, body: unknown) =>
    this.client.request({ method: 'POST', path, body }) as Promise<Any>;

  /** Every page of an offset-paged list (`startAt`, `maxResults`, `total` or `isLast`). */
  private async offsetPages(
    path: string,
    key: string,
    max: number,
    extra: Record<string, string> = {},
  ): Promise<Any[]> {
    const out: Any[] = [];
    for (let startAt = 0, i = 0; i < MAX_PAGES; i++) {
      const page = await this.get(withQuery(path, { ...extra, startAt, maxResults: max }));
      const values = (Array.isArray(page) ? page : (page?.[key] ?? [])) as Any[];
      out.push(...values);
      startAt += values.length;
      const total = typeof page?.total === 'number' ? page.total : null;
      if (Array.isArray(page) || values.length === 0 || page?.isLast === true) break;
      if (total !== null && startAt >= total) break;
      if (total === null && page?.isLast === undefined && values.length < max) break;
    }
    return out;
  }

  /**
   * Fetches until the stage is complete ('ready') or `until` passes ('more'). Throws a
   * `CloudRequestError` the job retries; the state committed so far stays.
   */
  async run(until: number): Promise<'ready' | 'more'> {
    const state = await this.state();
    this.committed = { ...this.client.stats };
    while (!state.done) {
      const step = state.step ?? 'config';
      if (step === 'config') await this.config(state);
      else if (step === 'search') await this.search(state, until);
      else if (step === 'details') await this.details(state, until);
      else if (step === 'agile') await this.agile(state, until);
      else if (step === 'people') await this.people(state, until);
      else await this.order(state);
      if (!state.done && Date.now() >= until) return 'more';
    }
    return 'ready';
  }

  private next(state: FetchState, step: FetchStep | null) {
    if (step === null) {
      state.done = true;
      delete state.step;
    } else state.step = step;
  }

  private wanted(key: string): boolean {
    return this.settings.projects === null || this.settings.projects.includes(key);
  }

  private async customFields(): Promise<Map<string, FieldInfo>> {
    const rows = await this.db
      .selectFrom('import_staged')
      .select('data')
      .where('run_id', '=', this.target.id)
      .where('kind', '=', 'field')
      .execute();
    return fieldInfo(rows.map((r) => (r.data as Any).raw));
  }

  private async config(state: FetchState): Promise<void> {
    const rows: Staged[] = [];
    const named = (kind: string, list: Any[]) => {
      for (const x of list) {
        rows.push({ kind, id: String(x.id), label: String(x.name ?? x.id), data: trim(x) });
      }
    };
    const [fields, types, priorities, resolutions, statuses, linkTypes] = await Promise.all([
      this.get(`${API}/field`),
      this.get(`${API}/issuetype`),
      this.get(`${API}/priority`),
      this.get(`${API}/resolution`),
      this.get(`${API}/status`),
      this.get(`${API}/issueLinkType`),
    ]);
    for (const f of fields as Any[]) {
      const m = /^customfield_(\d+)$/.exec(String(f.id ?? ''));
      if (!f.custom || !m) continue;
      const id = m[1] as string;
      rows.push({ kind: 'field', id, label: String(f.name), data: { raw: trim(f) } });
      // The API this reads lists no contexts: each field gets one that applies everywhere.
      rows.push({ kind: 'field_context', id, label: String(f.name), data: { field: id } });
    }
    named('ticket_type', types);
    named('priority', priorities);
    named('close_reason', resolutions);
    named('status', statuses);
    named('link_type', linkTypes?.issueLinkTypes ?? []);
    const projects = (await this.offsetPages(`${API}/project/search`, 'values', 50)).filter((p) =>
      this.wanted(String(p.key)),
    );
    const details = await this.client.map(projects, async (p) => {
      const [project, versions, components] = await Promise.all([
        this.get(`${API}/project/${enc(String(p.id))}`),
        this.get(`${API}/project/${enc(String(p.id))}/versions`),
        this.get(`${API}/project/${enc(String(p.id))}/components`),
      ]);
      return { project, versions: versions as Any[], components: components as Any[] };
    });
    for (const { project, versions, components } of details) {
      push(rows, person(project.lead));
      rows.push({
        kind: 'track',
        id: String(project.id),
        label: String(project.key),
        data: trim({ ...project, issueTypes: undefined }),
      });
      for (const v of versions) {
        rows.push({
          kind: 'release',
          id: String(v.id),
          label: String(v.name),
          data: trim({ ...v, projectId: String(project.id) }),
        });
      }
      for (const c of components) {
        push(rows, person(c.lead));
        rows.push({
          kind: 'area',
          id: String(c.id),
          label: String(c.name),
          data: trim({ ...c, projectId: String(project.id) }),
        });
      }
    }
    this.next(state, 'search');
    state.search = { token: null, pages: 0, restarts: 0 };
    await this.commit(state, rows);
  }

  private async projectKeys(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('import_staged')
      .select('label')
      .where('run_id', '=', this.target.id)
      .where('kind', '=', 'track')
      .orderBy('ordinal')
      .execute();
    return rows.map((r) => String(r.label));
  }

  /** The query that picks the issues: the setting, or the staged projects' issues. */
  private async query(): Promise<string | null> {
    if (this.settings.jql) return this.settings.jql;
    const keys = await this.projectKeys();
    if (keys.length === 0) return null;
    return `project in (${keys.join(', ')}) ORDER BY key ASC`;
  }

  private async search(state: FetchState, until: number): Promise<void> {
    const jql = await this.query();
    const fields = await this.customFields();
    const search = state.search ?? { token: null, pages: 0, restarts: 0 };
    if (jql === null) {
      this.next(state, 'details');
      await this.commit(state, []);
      return;
    }
    const size = Math.min(100, Math.max(1, this.settings.pageSize));
    for (let i = 0; i < MAX_PAGES; i++) {
      let page: Any;
      try {
        page = await this.post(`${API}/search/jql`, {
          jql,
          maxResults: size,
          fields: ['id'],
          ...(search.token ? { nextPageToken: search.token } : {}),
        });
      } catch (error) {
        // A page token the server no longer takes (it expired while the run waited): start
        // over. Pages already staged are staged again, unchanged.
        if (
          error instanceof CloudRequestError &&
          error.status === 400 &&
          search.token !== null &&
          search.restarts < 3
        ) {
          state.search = { token: null, pages: 0, restarts: search.restarts + 1 };
          await this.commit(state, []);
          return;
        }
        throw error;
      }
      const ids = ((page.issues ?? []) as Any[]).map((x) => String(x.id));
      const rows: Staged[] = [];
      if (ids.length > 0) {
        const fetched = await this.post(`${API}/issue/bulkfetch`, {
          issueIdsOrKeys: ids,
          fields: ['*all'],
        });
        const byId = new Map(((fetched.issues ?? []) as Any[]).map((x) => [String(x.id), x]));
        // In the order the search gave them.
        for (const id of ids) {
          const issue = byId.get(id);
          if (!issue) continue;
          rows.push(...issueParts(issue, fields));
          rows.push({
            kind: 'ticket',
            id,
            label: String(issue.key),
            data: trim({ id: String(issue.id), key: issue.key, fields: issue.fields }),
          });
        }
        for (const e of (fetched.issueErrors ?? []) as Any[]) {
          rows.push({
            kind: 'issue_unreadable',
            id: String(e.issueIdOrKey),
            data: { messages: e.errorMessages ?? [] },
          });
        }
      }
      const token = page.nextPageToken ? String(page.nextPageToken) : null;
      search.token = token;
      search.pages += 1;
      state.search = search;
      if (token === null || page.isLast === true) this.next(state, 'details');
      await this.commit(state, rows);
      if (state.step !== 'search' || Date.now() >= until) return;
    }
  }

  private async details(state: FetchState, until: number): Promise<void> {
    const chunk = Math.max(1, this.settings.detailChunk ?? 25);
    for (;;) {
      const after = state.details?.after ?? 0;
      const tickets = await this.db
        .selectFrom('import_staged')
        .select(['source_id', 'ordinal', 'label'])
        .where('run_id', '=', this.target.id)
        .where('kind', '=', 'ticket')
        .where('ordinal', '>', String(after))
        .orderBy('ordinal')
        .limit(chunk)
        .execute();
      if (tickets.length === 0) {
        this.next(state, 'agile');
        await this.commit(state, []);
        return;
      }
      const parts = await this.client.map(tickets, (t) => this.issueDetails(t.source_id));
      state.details = {
        after: Number((tickets[tickets.length - 1] as { ordinal: string }).ordinal),
      };
      await this.commit(state, parts.flat());
      if (Date.now() >= until) return;
    }
  }

  private async issueDetails(issueId: string): Promise<Staged[]> {
    const path = `${API}/issue/${enc(issueId)}`;
    const [changes, comments, worklogs] = await Promise.all([
      this.offsetPages(`${path}/changelog`, 'values', 100),
      this.offsetPages(`${path}/comment`, 'comments', 100),
      this.offsetPages(`${path}/worklog`, 'worklogs', 100),
    ]);
    const rows: Staged[] = [];
    for (const c of changes) {
      push(rows, person(c.author));
      rows.push({
        kind: 'history',
        id: `${issueId}:${c.id}`,
        data: trim({ ...c, issueId }),
      });
    }
    for (const c of comments) {
      push(rows, person(c.author));
      push(rows, person(c.updateAuthor));
      rows.push({ kind: 'comment', id: String(c.id), data: trim({ ...c, issueId }) });
    }
    for (const w of worklogs) {
      push(rows, person(w.author));
      rows.push({ kind: 'time_entry', id: String(w.id), data: trim({ ...w, issueId }) });
    }
    return rows;
  }

  private async agile(state: FetchState, until: number): Promise<void> {
    let boards: Any[];
    try {
      boards = await this.offsetPages(`${AGILE}/board`, 'values', 50);
    } catch (error) {
      if (error instanceof CloudRequestError && (error.status === 404 || error.status === 403)) {
        state.agile = { after: 0, unavailable: true };
        this.next(state, 'people');
        await this.commit(state, []);
        return;
      }
      throw error;
    }
    const keys = new Set(await this.projectKeys());
    const after = state.agile?.after ?? 0;
    const pending = boards
      .map((b) => ({ ...b, id: Number(b.id) }))
      .filter((b) => b.id > after)
      .sort((a, b) => a.id - b.id);
    for (const b of pending) {
      const board = await this.get(`${AGILE}/board/${b.id}`);
      const key = board.location?.projectKey ? String(board.location.projectKey) : null;
      const rows: Staged[] = [];
      if (key !== null && keys.has(key)) {
        const configuration = await this.get(`${AGILE}/board/${b.id}/configuration`);
        // A board that shows a saved filter: its query, when the token may read it.
        const filterId = String(configuration.filter?.id ?? '0');
        let filterJql: string | null = null;
        if (filterId !== '0' && filterId !== '') {
          try {
            filterJql =
              String((await this.get(`${API}/filter/${enc(filterId)}`)).jql ?? '') || null;
          } catch (error) {
            if (!(error instanceof CloudRequestError) || error.transient) throw error;
          }
        }
        const sprints =
          board.type === 'scrum'
            ? await this.offsetPages(`${AGILE}/board/${b.id}/sprint`, 'values', 50)
            : [];
        const own = sprints.filter(
          (s) => s.originBoardId === undefined || Number(s.originBoardId) === b.id,
        );
        const members = await this.client.map(own, async (s) =>
          (
            await this.offsetPages(`${AGILE}/sprint/${s.id}/issue`, 'issues', 100, { fields: 'id' })
          ).map((x) => String(x.id)),
        );
        rows.push({
          kind: 'board',
          id: String(b.id),
          label: String(board.name),
          data: trim({ ...board, columns: configuration.columnConfig?.columns ?? [], filterJql }),
        });
        for (const [i, s] of own.entries()) {
          rows.push({
            kind: 'sprint',
            id: String(s.id),
            label: String(s.name),
            data: trim({ ...s, boardId: String(b.id), issues: members[i] ?? [] }),
          });
        }
      } else {
        rows.push({
          kind: 'board_not_imported',
          id: String(b.id),
          label: String(board.name ?? b.name),
          data: { project: key },
        });
      }
      state.agile = { after: b.id };
      await this.commit(state, rows);
      if (Date.now() >= until) return;
    }
    this.next(state, 'people');
    await this.commit(state, []);
  }

  private async people(state: FetchState, until: number): Promise<void> {
    for (;;) {
      const after = state.people?.after ?? 0;
      const people = await this.db
        .selectFrom('import_staged')
        .select(['source_id', 'ordinal', 'data'])
        .where('run_id', '=', this.target.id)
        .where('kind', '=', 'user')
        .where('ordinal', '>', String(after))
        .orderBy('ordinal')
        .limit(50)
        .execute();
      if (people.length === 0) {
        this.next(state, 'order');
        await this.commit(state, []);
        return;
      }
      const missing = people.filter((p) => !(p.data as Any)?.emailAddress);
      const found = await this.client.map(missing, async (p) => {
        try {
          return person(await this.get(withQuery(`${API}/user`, { accountId: p.source_id })));
        } catch (error) {
          // Someone the token may not look up (a deleted account, say) keeps what was seen.
          if (error instanceof CloudRequestError && !error.transient) return null;
          throw error;
        }
      });
      const rows = found.flatMap((s) =>
        s?.data && (s.data as Any).emailAddress ? [{ ...s, keep: false }] : [],
      );
      state.people = { after: Number((people[people.length - 1] as { ordinal: string }).ordinal) };
      await this.commit(state, rows);
      if (Date.now() >= until) return;
    }
  }

  /** Each staged issue's depth below the issues it descends from, so parents load first. */
  private async order(state: FetchState): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        WITH RECURSIVE tree (source_id, depth) AS (
          SELECT s.source_id, 0
            FROM import_staged s
           WHERE s.run_id = ${this.target.id} AND s.kind = 'ticket'
             AND NOT EXISTS (
               SELECT 1 FROM import_staged p
                WHERE p.run_id = s.run_id AND p.kind = 'ticket'
                  AND p.source_id = s.data #>> '{fields,parent,id}')
          UNION ALL
          SELECT c.source_id, t.depth + 1
            FROM tree t
            JOIN import_staged c
              ON c.run_id = ${this.target.id} AND c.kind = 'ticket'
             AND c.data #>> '{fields,parent,id}' = t.source_id
           WHERE t.depth < 10
        )
        UPDATE import_staged s SET depth = t.depth
          FROM tree t
         WHERE s.run_id = ${this.target.id} AND s.kind = 'ticket' AND s.source_id = t.source_id
           AND s.depth <> t.depth`.execute(trx);
    });
    this.next(state, null);
    await this.commit(state, []);
  }
}
