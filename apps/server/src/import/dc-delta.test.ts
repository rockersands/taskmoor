import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Database } from '@taskmoor/db';
import { migratedTemplate, useMigratedDatabase } from '@taskmoor/db/testing';
import { LocalStore } from '@taskmoor/storage';
import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { storesOf } from '../attachments/stores';
import { FieldCatalogs } from '../fields/catalog';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import { IMPORT_FORMATS } from './jobs';
import { type FidelityReport, fidelityReport } from './report';
import { createRun, runImport } from './run';

const OPTIONS = defaultOptions(300, 96, { projects: 3 });

async function unzip(path: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true }, (e, z) => (e || !z ? fail(e) : ok(z))),
  );
  const out = new Map<string, Buffer>();
  await new Promise<void>((done, fail) => {
    zip.on('end', () => done());
    zip.on('error', fail);
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, async (e, stream) => {
        if (e || !stream) return fail(e);
        const parts: Buffer[] = [];
        for await (const chunk of stream) parts.push(chunk as Buffer);
        out.set(entry.fileName, Buffer.concat(parts));
        zip.readEntry();
      });
    });
    zip.readEntry();
  });
  return out;
}

async function rezip(entries: Map<string, Buffer>, path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const chunk of zip.outputStream) parts.push(chunk as Buffer);
  await writeFile(path, Buffer.concat(parts));
}

/** What the later backup changed, by source id, for the assertions. */
interface Edits {
  renamed: string;
  editedComment: string;
  addedComment: string;
  deletedComment: string;
  addedWorklog: string;
  /** Issues whose `updated` moved: every edit above touches its issue. */
  touched: string[];
}

const attr = (line: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(line)?.[1] ?? null;
const setAttr = (line: string, name: string, value: string) =>
  attr(line, name) === null
    ? line.replace(/(\/?>)$/, ` ${name}="${value}"$1`)
    : line.replace(new RegExp(`(\\s${name}=")[^"]*(")`), `$1${value}$2`);

/**
 * The same instance some weeks later, as a later backup holds it: an issue renamed (with the
 * change group that records it), a comment edited, one added and one deleted, and time logged;
 * each touched issue's `updated` moves, as the source does. Ids for new rows come after the
 * highest of their element, and the id sequences move past them.
 */
function editBackup(xml: string): { xml: string; edits: Edits } {
  const lines = xml.split('\n');
  const find = (re: RegExp, skip = 0) => {
    let seen = 0;
    const i = lines.findIndex((l) => re.test(l) && seen++ === skip);
    if (i < 0) throw new Error(`no line matches ${re}`);
    return i;
  };
  const maxId = (element: string) =>
    Math.max(...lines.filter((l) => l.includes(`<${element} `)).map((l) => Number(attr(l, 'id'))));
  const at = '2026-02-02 10:00:00.000';
  const touched = new Set<string>();
  const touch = (issue: string) => {
    touched.add(issue);
    const i = find(new RegExp(`<Issue id="${issue}" `));
    lines[i] = setAttr(lines[i] as string, 'updated', at);
  };
  // One-line comments with a body attribute: easy to edit, copy and remove.
  const comment = /<Action id="\d+" [^>]* body="[^"]*"[^>]*\/>$/;
  const edited = find(comment, 2);
  const editedLine = lines[edited] as string;
  lines[edited] = setAttr(setAttr(editedLine, 'body', 'Edited before the cutover.'), 'updated', at);
  touch(attr(editedLine, 'issue') as string);
  const removed = find(comment, 5);
  const removedLine = lines[removed] as string;
  touch(attr(removedLine, 'issue') as string);
  const addedComment = String(maxId('Action') + 1);
  const copyOf = lines[find(comment, 8)] as string;
  const added = setAttr(
    setAttr(
      setAttr(setAttr(copyOf, 'id', addedComment), 'body', 'Added before the cutover.'),
      'created',
      at,
    ),
    'updated',
    at,
  );
  touch(attr(copyOf, 'issue') as string);
  const worklogLine = lines[find(/<Worklog id="\d+" /)] as string;
  const addedWorklog = String(maxId('Worklog') + 1);
  const worklog = setAttr(
    setAttr(setAttr(worklogLine, 'id', addedWorklog), 'created', at),
    'body',
    'Cutover checks',
  );
  touch(attr(worklogLine, 'issue') as string);
  // The rename, with its change group and item.
  const issueIndex = find(/<Issue id="\d+" [^>]*summary="/, 7);
  const issueLine = lines[issueIndex] as string;
  const renamed = attr(issueLine, 'id') as string;
  const oldSummary = attr(issueLine, 'summary') as string;
  lines[issueIndex] = setAttr(issueLine, 'summary', 'Renamed before the cutover');
  touch(renamed);
  const group = String(maxId('ChangeGroup') + 1);
  const item = String(maxId('ChangeItem') + 1);
  const author = attr(issueLine, 'reporter') as string;
  const groupLine = `    <ChangeGroup id="${group}" issue="${renamed}" author="${author}" created="${at}"/>`;
  const itemLine = `    <ChangeItem id="${item}" group="${group}" fieldtype="jira" field="summary" oldstring="${oldSummary}" newstring="Renamed before the cutover"/>`;

  // Insert after the last row of each element; remove the deleted comment last.
  const insertAfter = (element: string, row: string) => {
    let last = -1;
    lines.forEach((l, i) => {
      if (l.includes(`<${element} `)) last = i;
    });
    // A multi-line row ends at its closing tag.
    let end = last;
    if (!(lines[last] as string).endsWith('/>')) {
      while (!(lines[end] as string).includes(`</${element}>`)) end++;
    }
    lines.splice(end + 1, 0, row);
  };
  lines[removed] = '\u0000remove';
  insertAfter('Action', added);
  insertAfter('Worklog', worklog);
  insertAfter('ChangeGroup', groupLine);
  insertAfter('ChangeItem', itemLine);
  const out = lines
    .filter((l) => l !== '\u0000remove')
    .map((l) => {
      const m = /<SequenceValueItem seqName="(\w+)" seqId="(\d+)"/.exec(l);
      if (!m) return l;
      const next: Record<string, string> = {
        Action: addedComment,
        Worklog: addedWorklog,
        ChangeGroup: group,
        ChangeItem: item,
      };
      const id = next[m[1] as string];
      return id ? setAttr(l, 'seqId', String(Number(id) + 10)) : l;
    });
  return {
    xml: out.join('\n'),
    edits: {
      renamed,
      editedComment: attr(editedLine, 'id') as string,
      addedComment,
      deletedComment: attr(removedLine, 'id') as string,
      addedWorklog,
      touched: [...touched],
    },
  };
}

/**
 * The target's tickets, comments, time entries, links and history, with every id named by the
 * source record it came from (target ids differ between databases), for comparing two imports.
 */
async function snapshot(db: Kysely<Database>) {
  const ext = await db
    .selectFrom('import_external_id')
    .select(['entity_kind', 'source_id', 'target_id'])
    .execute();
  const back = new Map(ext.map((e) => [`${e.entity_kind}:${e.target_id}`, e.source_id]));
  const as = (kind: string, id: number | string | null) =>
    id === null ? null : (back.get(`${kind}:${id}`) ?? `native:${id}`);
  const tickets = await db
    .selectFrom('ticket')
    .selectAll()
    .where('deleted_at', 'is', null)
    .execute();
  const comments = await db.selectFrom('ticket_comment').selectAll().execute();
  const time = await db.selectFrom('time_entry').selectAll().execute();
  const links = await db.selectFrom('ticket_link').selectAll().execute();
  const changes = await db.selectFrom('ticket_change').selectAll().execute();
  const followers = await db.selectFrom('ticket_follower').selectAll().execute();
  const sorted = <T>(rows: T[]) =>
    rows.sort((a, b) => {
      const x = JSON.stringify(a);
      const y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const historyValue = (field: string, value: string | null) =>
    value === null ? null : field === 'comment' ? as('comment', value) : value;
  return {
    tickets: sorted(
      tickets.map((t) => ({
        k: as('ticket', t.id),
        track: t.track_id,
        number: t.number,
        type: t.ticket_type_id,
        status: t.status_id,
        parent: as('ticket', t.parent_id),
        people: [t.assignee_id, t.requester_id, t.creator_id],
        summary: t.summary,
        description: t.description,
        environment: t.environment,
        labels: t.labels,
        priority: t.priority_id,
        closeReason: t.close_reason_id,
        dates: [t.start_date, t.due_date, t.created_at.toISOString(), t.updated_at.toISOString()],
        closedAt: t.closed_at?.toISOString() ?? null,
        estimates: [t.original_estimate, t.remaining_estimate, t.time_spent],
        fields: t.fields,
        level: t.visibility_level_id,
        rank: t.rank,
      })),
    ),
    comments: sorted(
      comments.map((c) => ({
        k: as('comment', c.id),
        ticket: as('ticket', c.ticket_id),
        author: c.author_id,
        body: c.body,
        group: c.visible_group_id,
        role: c.visible_role_id,
        at: [c.created_at.toISOString(), c.updated_at.toISOString()],
        deleted: c.deleted_at?.toISOString() ?? null,
      })),
    ),
    time: sorted(
      time.map((e) => ({
        k: as('time_entry', e.id),
        ticket: as('ticket', e.ticket_id),
        author: e.author_id,
        startedAt: e.started_at.toISOString(),
        duration: e.duration,
        description: e.description,
      })),
    ),
    links: sorted(
      links.map((l) => ({
        k: as('link', l.id),
        type: l.link_type_id,
        source: as('ticket', l.source_id),
        target: as('ticket', l.target_id),
      })),
    ),
    followers: sorted(followers.map((f) => `${as('ticket', f.ticket_id)}:${f.user_id}`)),
    history: sorted(
      changes.map((c) => ({
        ticket: as('ticket', c.ticket_id),
        // Web links the source gives no time get the time of the import that made them.
        at: c.field === 'webLink' && c.actor_id === null ? 'at import' : c.at.toISOString(),
        actor: c.actor_id,
        field: c.field,
        from: historyValue(c.field, c.from_value),
        to: historyValue(c.field, c.to_value),
        display: [c.from_display, c.to_display],
      })),
    ),
  };
}

/** Rows of the product's own tables a run would change, as counts and sums. */
async function productState(db: Kysely<Database>) {
  const { rows } = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM ticket) AS tickets,
           (SELECT coalesce(sum(version), 0) FROM ticket) AS versions,
           (SELECT max(updated_at)::text FROM ticket) AS updated,
           (SELECT count(*) FROM ticket_change) AS changes,
           (SELECT count(*) FROM ticket_comment) AS comments,
           (SELECT max(updated_at)::text FROM ticket_comment) AS comment_updated,
           (SELECT count(*) FROM time_entry) AS time_entries,
           (SELECT count(*) FROM change_log) AS change_log,
           (SELECT count(*) FROM saved_search) AS searches`.execute(db);
  return rows[0];
}

/**
 * Delta runs from a later Data Center backup (M1-096; IMP-009 (3); ADR-102): the first backup
 * imported, then a later backup of the same instance with edits imported as a delta from that
 * run. The delta writes only what changed (the counts say so), reports the comment the later
 * backup no longer has (and keeps it), and the target then equals a fresh import of the later
 * backup into an empty database. A second delta from the same backup changes nothing.
 */
describe('Data Center delta runs (M1-096)', () => {
  const database = useMigratedDatabase();
  let dir = '';
  let edits: Edits;
  let deps: Parameters<typeof runImport>[0];

  const importInto = async (
    db: Kysely<Database>,
    path: string,
    deltaFrom: string | null,
  ): Promise<{ id: string; report: FidelityReport }> => {
    const run = await createRun(db, {
      workspaceId: 1,
      userId: null,
      importSource: 'dc-backup',
      system: 'dc',
      name: deltaFrom ? 'Delta' : 'Full',
      source: { format: 'dc-backup', path },
      dryRun: false,
      deltaFrom,
    });
    const mine = { ...deps, db, catalogs: new FieldCatalogs(db) };
    while ((await runImport(mine, run.id, { until: Date.now() + 60_000, batch: 100 })) === 'more');
    const row = await db
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row.status, row.last_error ?? '').toBe('done');
    return { id: run.id, report: fidelityReport.parse(row.report) };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-delta-'));
    await generateDcBackup(OPTIONS, join(dir, 'first.zip'));
    const entries = await unzip(join(dir, 'first.zip'));
    const edited = editBackup((entries.get('entities.xml') as Buffer).toString('utf8'));
    edits = edited.edits;
    entries.set('entities.xml', Buffer.from(edited.xml, 'utf8'));
    await rezip(entries, join(dir, 'later.zip'));
    deps = {
      db: database.db,
      catalogs: new FieldCatalogs(database.db),
      formats: IMPORT_FORMATS,
      stores: storesOf(await LocalStore.open(join(dir, 'files'))),
    };
  }, 300_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('[IMP-009] a delta run from a later backup writes only the changes and ends as a fresh import of it', async () => {
    const first = await importInto(database.db, join(dir, 'first.zip'), null);
    expect(first.report.failures).toEqual([]);
    const tickets = first.report.entities.find((e) => e.kind === 'ticket')?.source ?? 0;
    expect(tickets).toBe(300);

    const delta = await importInto(database.db, join(dir, 'later.zip'), first.id);
    expect(delta.report.failures).toEqual([]);
    expect(delta.report.run.deltaFrom).toBe(Number(first.id));
    const outcome = (kind: string) => delta.report.entities.find((e) => e.kind === kind)?.outcomes;
    expect(outcome('ticket')).toEqual({
      created: 0,
      updated: edits.touched.length,
      unchanged: tickets - edits.touched.length,
      linked: 0,
      failed: 0,
      skipped: 0,
    });
    expect(outcome('comment')).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect(outcome('time_entry')).toMatchObject({ created: 1, updated: 0, failed: 0 });
    expect(outcome('history')).toMatchObject({ created: 1, failed: 0 });
    // Everything else the later backup holds is as it was.
    for (const e of delta.report.entities) {
      if (['ticket', 'comment', 'time_entry', 'history'].includes(e.kind)) continue;
      expect(e.outcomes.created + e.outcomes.updated + e.outcomes.failed, e.kind).toBe(0);
    }
    const gone = delta.report.warnings.filter((w) => w.code === 'deleted_in_source');
    expect(gone.map((w) => [w.kind, w.count, w.examples])).toEqual([
      ['comment', 1, [edits.deletedComment]],
    ]);
    const records = await database.db
      .selectFrom('import_record')
      .select(['entity_kind', 'source_id', 'target_id'])
      .where('run_id', '=', delta.id)
      .where('outcome', '=', 'deleted')
      .execute();
    expect(records.map((r) => [r.entity_kind, r.source_id])).toEqual([
      ['comment', edits.deletedComment],
    ]);
    // The target keeps it.
    const kept = await database.db
      .selectFrom('ticket_comment')
      .select(['id', 'deleted_at'])
      .where('id', '=', Number(records[0]?.target_id))
      .executeTakeFirstOrThrow();
    expect(kept.deleted_at).toBeNull();

    // A fresh import of the later backup into an empty database.
    const created = await createDatabase(testPgAdminUrl(), { template: migratedTemplate.name });
    const freshDb = createDb({ connectionString: created.url, maxConnections: 3 });
    try {
      const full = await importInto(freshDb, join(dir, 'later.zip'), null);
      expect(full.report.failures).toEqual([]);
      const want = await snapshot(freshDb);
      const got = await snapshot(database.db);
      // What ADR-102 keeps: the comment the source deleted, and its history entry.
      const keptComment = got.comments.find((c) => c.k === edits.deletedComment);
      expect(keptComment).toBeDefined();
      got.comments = got.comments.filter((c) => c.k !== edits.deletedComment);
      got.history = got.history.filter(
        (h) =>
          !(
            h.field === 'comment' &&
            (h.to === edits.deletedComment || h.from === edits.deletedComment)
          ),
      );
      expect(got.tickets.length).toBe(want.tickets.length);
      expect(got.tickets).toEqual(want.tickets);
      expect(got.comments).toEqual(want.comments);
      expect(got.time).toEqual(want.time);
      expect(got.links).toEqual(want.links);
      expect(got.followers).toEqual(want.followers);
      expect(got.history).toEqual(want.history);
      // Not an empty comparison: the edits are there.
      expect(want.tickets.find((t) => t.k === edits.renamed)?.summary).toBe(
        'Renamed before the cutover',
      );
      expect(want.comments.find((c) => c.k === edits.addedComment)).toBeDefined();
      expect(want.time.find((e) => e.k === edits.addedWorklog)?.description).toBe('Cutover checks');
    } finally {
      await freshDb.destroy();
      await created.drop();
    }

    // The same later backup again: nothing created or updated, nothing written.
    const before = await productState(database.db);
    const again = await importInto(database.db, join(dir, 'later.zip'), delta.id);
    for (const e of again.report.entities) {
      expect(e.outcomes.created + e.outcomes.updated + e.outcomes.failed, e.kind).toBe(0);
    }
    expect(
      again.report.warnings.filter((w) => w.code === 'deleted_in_source').map((w) => w.count),
    ).toEqual([1]);
    expect(await productState(database.db)).toEqual(before);
  }, 900_000);
});
