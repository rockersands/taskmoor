import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * The search perf set (M1-037; done-when: p95 < 300 ms on 50 queries at 10M tickets): what
 * people search for every day, written against placeholders the loaded dataset fills (track
 * keys, field names, option values, people, words, keys). History operators (M1-039), the
 * master text field and stemmed text search (M1-040) and functions beyond dates and
 * `currentUser()` (M1-038) have their own sets.
 *
 * `page: 2` measures the second page of the query before it, cut by its cursor.
 */
export interface PerfQuery {
  id: string;
  text: string;
  page?: 2;
}

export const PERF_QUERIES: readonly PerfQuery[] = [
  { id: 'all-newest', text: '' },
  { id: 'all-newest-p2', text: '', page: 2 },
  { id: 'all-updated', text: 'ORDER BY updated DESC' },
  { id: 'track-newest', text: 'track = {A}' },
  { id: 'track-newest-p2', text: 'track = {A}', page: 2 },
  { id: 'track-oldest', text: 'track = {A} ORDER BY created ASC' },
  { id: 'track-status', text: 'track = {A} AND status = "In Progress" ORDER BY updated DESC' },
  { id: 'tracks-bugs', text: 'track IN ({A}, {B}) AND type = Bug ORDER BY created DESC' },
  { id: 'track-by-key', text: 'track = {B} ORDER BY key ASC' },
  {
    id: 'mine-open',
    text: 'assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC',
  },
  {
    id: 'mine-open-p2',
    text: 'assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC',
    page: 2,
  },
  { id: 'mine-updated', text: 'assignee = currentUser() ORDER BY updated DESC' },
  { id: 'requested-by-me', text: 'requester = currentUser() ORDER BY created DESC' },
  {
    id: 'mine-or-requested',
    text: '(assignee = currentUser() OR requester = currentUser()) AND stage != closed ORDER BY updated DESC',
  },
  { id: 'unassigned-new', text: 'assignee IS EMPTY AND stage = new ORDER BY created DESC' },
  { id: 'someone-else', text: 'assignee = {other} AND stage = active ORDER BY updated DESC' },
  {
    id: 'status-priority-in',
    text: 'status IN (Backlog, "To Do") AND priority IN (High, Urgent) ORDER BY created DESC',
  },
  { id: 'active', text: 'stage = active ORDER BY updated DESC' },
  { id: 'urgent-open', text: 'priority = Urgent AND stage != closed ORDER BY created DESC' },
  {
    id: 'priority-above',
    text: 'priority > Normal AND track = {A} ORDER BY priority DESC, updated DESC',
  },
  {
    id: 'bugs-urgent',
    text: 'type = Bug AND priority IN (Urgent, High) AND stage != closed ORDER BY priority DESC, created ASC',
  },
  { id: 'labels-in', text: 'labels IN ({label}, {label2}) ORDER BY created DESC' },
  { id: 'label-track', text: 'labels = {label} AND track = {A}' },
  { id: 'unlabelled-track', text: 'labels IS EMPTY AND track = {A}' },
  { id: 'summary-word', text: 'summary ~ {word} ORDER BY created DESC' },
  { id: 'summary-two-words', text: 'summary ~ "{word} {word2}" ORDER BY created DESC' },
  { id: 'summary-rare', text: 'summary ~ {rare} ORDER BY created DESC' },
  { id: 'description-track', text: 'description ~ {word} AND track = {B}' },
  { id: 'recent-bugs', text: 'created >= -30d AND type = Bug ORDER BY created DESC' },
  { id: 'created-week', text: 'created >= -7d ORDER BY created DESC' },
  { id: 'updated-today', text: 'updated >= -1d ORDER BY updated DESC' },
  { id: 'stale-unresolved', text: 'closed IS EMPTY AND updated < -90d ORDER BY updated ASC' },
  { id: 'closed-recently', text: 'closed >= -7d ORDER BY closed DESC' },
  {
    id: 'due-soon',
    text: 'due >= startOfWeek() AND due <= endOfWeek(1w) AND stage != closed ORDER BY due ASC',
  },
  { id: 'number-gt-sorted', text: '"{number}" > 500 AND track = {A} ORDER BY "{number}" DESC' },
  {
    id: 'number-empty',
    text: '"{number}" IS EMPTY AND type IN (Feature, Chore) AND track = {A} ORDER BY created DESC',
  },
  { id: 'number-range', text: '"{number}" >= 100 AND "{number}" < 120 ORDER BY "{number}" ASC' },
  { id: 'option-eq', text: '"{option}" = "{optionValue}" AND stage = new ORDER BY created DESC' },
  {
    id: 'option-in-updated',
    text: '"{option}" IN ("{optionValue}", "{optionValue2}") ORDER BY updated DESC',
  },
  {
    id: 'date-window',
    text: '"{date}" <= endOfMonth() AND "{date}" >= startOfMonth() ORDER BY "{date}" ASC',
  },
  { id: 'user-field-mine', text: '"{user}" = currentUser() ORDER BY updated DESC' },
  {
    id: 'multi-in',
    text: '"{multi}" IN ("{multiA}", "{multiB}") AND status != Done ORDER BY created DESC',
  },
  { id: 'multi-track', text: '"{multi}" = "{multiA}" AND track = {A} ORDER BY created DESC' },
  { id: 'labels-field', text: '"{labelsField}" = "{labelsValue}" ORDER BY created DESC' },
  { id: 'text-field', text: '"{text}" ~ {textWord} ORDER BY created DESC' },
  { id: 'children', text: 'parent = {parent} ORDER BY created ASC' },
  { id: 'by-keys', text: 'key IN ({k1}, {k2}, {k3})' },
  {
    id: 'outcomes',
    text: 'parent IS EMPTY AND type = Outcome AND track = {A} ORDER BY created DESC',
  },
  { id: 'following', text: 'watcher = currentUser() ORDER BY updated DESC' },
  {
    id: 'not-or-tracks',
    text: 'NOT (labels IN ({label}) OR type = Subticket) AND track IN ({A}, {B}) ORDER BY created DESC',
  },
];

export interface BenchNames {
  A: string;
  B: string;
  other: string;
  label: string;
  label2: string;
  word: string;
  word2: string;
  rare: string;
  number: string;
  option: string;
  optionValue: string;
  optionValue2: string;
  date: string;
  user: string;
  multi: string;
  multiA: string;
  multiB: string;
  labelsField: string;
  labelsValue: string;
  text: string;
  textWord: string;
  parent: string;
  k1: string;
  k2: string;
  k3: string;
}

export function instantiate(template: string, names: BenchNames): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = names[key as keyof BenchNames];
    if (value === undefined) throw new Error(`No value for {${key}}`);
    return value;
  });
}

/**
 * Names from the loaded dataset: the viewer's two biggest tracks, the most used shared field of
 * each type and its common values, a common and a rare summary word, an outcome with children.
 */
export async function benchNames(
  db: Kysely<Database>,
  tracks: readonly number[],
): Promise<BenchNames> {
  const one = async <T>(query: ReturnType<typeof sql<T>>): Promise<T> => {
    const { rows } = await query.execute(db);
    if (!rows[0]) throw new Error('The dataset lacks something the perf set needs');
    return rows[0];
  };
  const big = (
    await sql<{ key: string }>`SELECT t.key FROM track t JOIN ticket_counter c ON c.track_id = t.id
      WHERE t.id = ANY(${[...tracks]}::int[]) ORDER BY c.last_number DESC LIMIT 2`.execute(db)
  ).rows;
  const field = (type: string, multiple = false) =>
    one(sql<{ id: number; name: string }>`
      SELECT f.id, f.name FROM field f
       WHERE f.track_id IS NULL AND f.type = ${type} AND f.multiple = ${multiple}
       ORDER BY (SELECT count(*) FROM field_option o WHERE o.field_id = f.id) DESC, f.id LIMIT 1`);
  const optionValues = async (fieldId: number) =>
    (
      await sql<{ value: string }>`SELECT o.value FROM field_option o WHERE o.field_id = ${fieldId}
        ORDER BY o.sort_order LIMIT 3`.execute(db)
    ).rows.map((r) => r.value);
  const labels = (
    await sql<{
      label: string;
    }>`SELECT l AS label FROM (SELECT unnest(labels) AS l FROM ticket TABLESAMPLE SYSTEM (2)) s
      GROUP BY l ORDER BY count(*) DESC LIMIT 2`.execute(db)
  ).rows;
  const words = (
    await sql<{ word: string; n: number }>`
      SELECT w AS word, count(*)::int AS n
        FROM (SELECT regexp_split_to_table(lower(summary), '[^a-z]+') AS w FROM ticket TABLESAMPLE SYSTEM (2)) s
       WHERE length(w) > 3 GROUP BY w ORDER BY count(*) DESC`.execute(db)
  ).rows;
  const number = await field('number');
  const option = await field('select');
  const multi = await field('select', true);
  const date = await field('date');
  const user = await field('user');
  const text = await field('text');
  const labelsField = await field('labels');
  const labelsValue = await one(
    sql<{ value: string }>`SELECT value FROM v_text WHERE field_id = ${labelsField.id}
      GROUP BY value ORDER BY count(*) DESC LIMIT 1`,
  );
  const textWord = await one(
    sql<{ word: string }>`SELECT w AS word FROM (
        SELECT regexp_split_to_table(lower(value), '[^a-z]+') AS w FROM v_text WHERE field_id = ${text.id} LIMIT 2000) s
      WHERE length(w) > 3 GROUP BY w ORDER BY count(*) DESC LIMIT 1`,
  );
  const options = await optionValues(option.id);
  const multis = await optionValues(multi.id);
  const parent = await one(
    sql<{
      key: string;
    }>`SELECT t.key || '-' || p.number AS key FROM ticket p JOIN track t ON t.id = p.track_id
      WHERE p.id = (SELECT parent_id FROM ticket WHERE parent_id IS NOT NULL AND track_id = ANY(${[...tracks]}::int[])
                     GROUP BY parent_id ORDER BY count(*) DESC LIMIT 1)`,
  );
  const keys = (
    await sql<{
      key: string;
    }>`SELECT t.key || '-' || k.number AS key FROM ticket k JOIN track t ON t.id = k.track_id
      WHERE k.track_id = ANY(${[...tracks]}::int[]) AND k.id % 997 = 1 ORDER BY k.id LIMIT 3`.execute(
      db,
    )
  ).rows;
  const other = await one(
    sql<{ id: number }>`SELECT assignee_id AS id FROM ticket TABLESAMPLE SYSTEM (2)
      WHERE assignee_id IS NOT NULL GROUP BY assignee_id ORDER BY count(*) DESC LIMIT 1`,
  );
  const rare = words.find((w) => w.n <= 3) ?? words[words.length - 1];
  return {
    A: big[0]?.key ?? '',
    B: big[1]?.key ?? big[0]?.key ?? '',
    other: String(other.id),
    label: labels[0]?.label ?? 'none',
    label2: labels[1]?.label ?? 'none',
    word: words[0]?.word ?? 'none',
    word2: words[1]?.word ?? 'none',
    rare: rare?.word ?? 'none',
    number: number.name,
    option: option.name,
    optionValue: options[2] ?? options[0] ?? '',
    optionValue2: options[1] ?? options[0] ?? '',
    date: date.name,
    user: user.name,
    multi: multi.name,
    multiA: multis[0] ?? '',
    multiB: multis[1] ?? '',
    labelsField: labelsField.name,
    labelsValue: labelsValue.value,
    text: text.name,
    textWord: textWord.word,
    parent: parent.key,
    k1: keys[0]?.key ?? '',
    k2: keys[1]?.key ?? '',
    k3: keys[2]?.key ?? '',
  };
}

export interface Timed {
  runs: number;
  p50: number;
  p95: number;
  max: number;
}

/** Percentiles of a list of milliseconds, rounded to hundredths. */
export function timed(samples: readonly number[]): Timed {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    runs: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}
