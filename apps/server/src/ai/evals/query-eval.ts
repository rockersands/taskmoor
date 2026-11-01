import { parseQuery, QueryError } from '@taskmoor/query';
import { Authorizer } from '../../authz/authorizer';
import { FieldCatalogs } from '../../fields/catalog';
import { SearchError } from '../../search/bind';
import { queryCatalogue } from '../../search/catalogue';
import type { Cursor } from '../../search/compile';
import { prepareSearch, readOnly } from '../../search/run';
import { LABELS, PEOPLE, person, TRACKS } from './dataset';
import type { Handle } from './model';
import { QUERY_PAIRS, type QueryPair } from './query-corpus';
import type { EvalWorld } from './seed';

/**
 * The natural-language-to-query eval (M1-133; AI-014; ADR-107): each pair's reference runs on
 * the dataset as its person, through the same parse, resolve, bind and compile as the search
 * API, at the dataset's fixed now. A candidate's query scores when it finds exactly the same
 * tickets; where the prompt asks for an order, in the same order, with tickets the reference
 * ranks equal (the same sort values) in any order among themselves. A candidate that does not
 * parse scores 0 and is never run (AI-014 (2)).
 */
export interface QueryResult {
  ok: true;
  ids: number[];
  /** The sizes of the runs of tickets with equal sort values, in order. */
  ties: number[];
}
export interface QueryRefusal {
  ok: false;
  stage: 'parse' | 'resolve';
  message: string;
}

/** What a candidate is told besides the prompt: the person, the clock and the names in use. */
export interface QueryContext {
  prompt: string;
  language: QueryPair['language'];
  user: { handle: Handle; name: string; email: string };
  now: string;
  timeZone: string;
  /** Weeks start on Sunday (`startOfWeek()`). */
  weekStart: 'sunday';
  vocabulary: QueryVocabulary;
}

export interface QueryVocabulary {
  tracks: { key: string; name: string }[];
  people: { name: string; email: string }[];
  groups: string[];
  statuses: string[];
  stages: string[];
  priorities: string[];
  ticketTypes: string[];
  closeReasons: string[];
  labels: string[];
  releases: { track: string; name: string; shipped: boolean }[];
  areas: { track: string; name: string }[];
  customFields: { name: string; type: string }[];
}

/** The names a person may use, as a query editor would offer them (tracks they see only). */
export function vocabularyFor(handle: Handle): QueryVocabulary {
  const visible = TRACKS.filter(
    (t) => t.owner === handle || t.members.includes(handle) || t.viewers.includes(handle),
  );
  return {
    tracks: visible.map((t) => ({ key: t.key, name: t.name })),
    people: PEOPLE.map((p) => ({ name: p.name, email: p.email })),
    groups: ['web-team', 'platform-team', 'mobile-team', 'security'],
    statuses: ['New', 'Active', 'In Review', 'Closed'],
    stages: ['new', 'active', 'closed'],
    priorities: ['Urgent', 'High', 'Normal', 'Low'],
    ticketTypes: ['Outcome', 'Feature', 'Bug', 'Chore', 'Subticket'],
    closeReasons: ['Completed', 'Not planned', 'Duplicate', 'Not reproducible'],
    labels: [...LABELS],
    releases: visible.flatMap((t) =>
      t.releases.map((r) => ({ track: t.key, name: r.name, shipped: r.shipped })),
    ),
    areas: visible.flatMap((t) => t.areas.map((a) => ({ track: t.key, name: a }))),
    customFields: [{ name: 'Points', type: 'number' }],
  };
}

export function queryContext(world: EvalWorld, pair: QueryPair): QueryContext {
  const p = person(pair.asUser);
  return {
    prompt: pair.prompt,
    language: pair.language,
    user: { handle: p.handle, name: p.name, email: p.email },
    now: world.now.toISOString(),
    timeZone: world.timeZone,
    weekStart: 'sunday',
    vocabulary: vocabularyFor(pair.asUser),
  };
}

/** Runs a query as a person of the dataset: every matching ticket, in the query's order. */
export async function runAs(
  world: EvalWorld,
  handle: Handle,
  q: string,
): Promise<QueryResult | QueryRefusal> {
  try {
    parseQuery(q);
  } catch (error) {
    if (error instanceof QueryError) return { ok: false, stage: 'parse', message: error.message };
    throw error;
  }
  const { db, workspaceId } = world;
  const principal = { userId: world.people[handle].id };
  const authorizer = new Authorizer(db);
  const filter = await authorizer.ticketFilter(workspaceId, principal);
  const catalog = await new FieldCatalogs(db).get(workspaceId);
  const catalogue = await queryCatalogue(db, workspaceId, catalog, filter.tracks);
  let compiled: Awaited<ReturnType<typeof prepareSearch>>['compiled'];
  try {
    ({ compiled } = await prepareSearch({
      db,
      workspaceId,
      catalog,
      catalogue,
      filter,
      q,
      currentUserId: principal.userId,
      now: world.now,
      timeZone: world.timeZone,
      allowedTracks: (permission) => authorizer.allowedTracks(workspaceId, principal, permission),
    }));
  } catch (error) {
    if (error instanceof QueryError || error instanceof SearchError) {
      return { ok: false, stage: 'resolve', message: error.message };
    }
    throw error;
  }
  const ids: number[] = [];
  const ties: number[] = [];
  let previous: string | undefined;
  let after: Cursor | undefined;
  for (;;) {
    const rows = await readOnly(
      db,
      30_000,
      async (trx) => (await compiled.page(500, after).execute(trx)).rows,
    );
    for (const row of rows) {
      const values = JSON.stringify(compiled.keys.map((_, i) => row[`c${i}`] ?? null));
      if (values === previous) ties[ties.length - 1] = (ties[ties.length - 1] ?? 0) + 1;
      else ties.push(1);
      previous = values;
      ids.push(row.id);
    }
    const last = rows[rows.length - 1];
    if (rows.length < 500 || !last) break;
    after = { values: compiled.keys.map((_, i) => last[`c${i}`] ?? null), id: last.id };
  }
  return { ok: true, ids, ties };
}

/**
 * Whether a candidate's result matches the reference's: the same set, and for an ordered pair
 * the same order up to ties in the reference's sort values.
 */
export function sameResult(
  reference: QueryResult,
  candidate: QueryResult,
  ordered: boolean,
): boolean {
  if (reference.ids.length !== candidate.ids.length) return false;
  const want = new Set(reference.ids);
  if (!candidate.ids.every((id) => want.has(id)) || new Set(candidate.ids).size !== want.size) {
    return false;
  }
  if (!ordered) return true;
  let start = 0;
  for (const size of reference.ties) {
    const a = new Set(reference.ids.slice(start, start + size));
    if (!candidate.ids.slice(start, start + size).every((id) => a.has(id))) return false;
    start += size;
  }
  return true;
}

/** Turns a prompt into a query: what M1-079's feature does, or a stand-in. */
export type QueryCandidate = (context: QueryContext) => Promise<string> | string;

export interface QueryPairOutcome {
  id: string;
  language: QueryPair['language'];
  prompt: string;
  query: string;
  pass: boolean;
  /** Why it failed: parse or resolve refusal, or a different result. */
  problem?: string;
  expected: number;
  found?: number;
}

export interface QueryReport {
  feature: 'query';
  candidate: string;
  total: number;
  passed: number;
  score: number;
  byLanguage: Record<string, { total: number; passed: number; score: number }>;
  failures: QueryPairOutcome[];
  outcomes: QueryPairOutcome[];
}

/** The references themselves: they must score 100%, which proves the runner. */
export const referenceCandidate = (pairs: readonly QueryPair[]): QueryCandidate => {
  const byPrompt = new Map(
    pairs.map((p) => [`${p.language}:${p.asUser}:${p.prompt}`, p.reference]),
  );
  return (c) => byPrompt.get(`${c.language}:${c.user.handle}:${c.prompt}`) ?? '';
};

/** A weak baseline: the prompt itself as a text search. */
export const textSearchBaseline: QueryCandidate = (c) =>
  `text ~ "${c.prompt.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export async function runQueryEval(
  world: EvalWorld,
  candidate: QueryCandidate,
  name: string,
  pairs: readonly QueryPair[] = QUERY_PAIRS,
): Promise<QueryReport> {
  const outcomes: QueryPairOutcome[] = [];
  for (const pair of pairs) {
    const reference = await runAs(world, pair.asUser, pair.reference);
    if (!reference.ok)
      throw new Error(`${pair.id}: the reference is refused: ${reference.message}`);
    const query = String(await candidate(queryContext(world, pair)));
    const base = {
      id: pair.id,
      language: pair.language,
      prompt: pair.prompt,
      query,
      expected: reference.ids.length,
    };
    // Parsed before anything runs: a query that does not parse is never executed.
    const found = await runAs(world, pair.asUser, query);
    if (!found.ok) {
      outcomes.push({ ...base, pass: false, problem: `${found.stage}: ${found.message}` });
      continue;
    }
    const pass = sameResult(reference, found, pair.ordered === true);
    outcomes.push({
      ...base,
      pass,
      found: found.ids.length,
      ...(pass ? {} : { problem: 'a different result' }),
    });
  }
  const byLanguage: QueryReport['byLanguage'] = {};
  for (const o of outcomes) {
    const entry = byLanguage[o.language] ?? { total: 0, passed: 0, score: 0 };
    byLanguage[o.language] = entry;
    entry.total++;
    if (o.pass) entry.passed++;
  }
  for (const entry of Object.values(byLanguage)) entry.score = ratio(entry.passed, entry.total);
  const passed = outcomes.filter((o) => o.pass).length;
  return {
    feature: 'query',
    candidate: name,
    total: outcomes.length,
    passed,
    score: ratio(passed, outcomes.length),
    byLanguage,
    failures: outcomes.filter((o) => !o.pass),
    outcomes,
  };
}

export const ratio = (n: number, d: number) =>
  d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000;
