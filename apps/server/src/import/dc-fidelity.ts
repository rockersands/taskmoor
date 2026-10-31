import { createHash } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { fromWiki, toPlainText } from '@taskmoor/richtext';
import type { Kysely } from 'kysely';
import { canonicalJson } from '../tickets/model';
import { DC_SOURCE } from './dc';
import { fieldWorldOf } from './dc-backup/fields';
import * as parts from './dc-backup/parts';
import { FIRST_ID, type IssueFacts, type Person, type World, walkIssues } from './dc-backup/world';

/**
 * Entity fidelity of a Data Center backup import against the synthetic fixture it came from
 * (M1-091; IMP-010; ADR-092): every ticket, follower, vote, earlier key, comment, history
 * entry, time entry, link, web link and attachment the generator wrote is looked up in the
 * target through the import's external ids and compared field by field with what the
 * fixture's instance says it must hold. The starting values that history corrects are checked
 * too. `every` checks one issue in that many (and everything that belongs to it), for runs too
 * large to compare whole; counts are exact for what is checked, and mismatches are listed.
 */
export interface KindFidelity {
  kind: string;
  expected: number;
  matched: number;
  /** Target rows for checked tickets that the fixture does not have (followers, votes). */
  extra: number;
  /** The first mismatches, each naming the source record and what differs. */
  examples: string[];
}

export interface DcFidelity {
  kinds: KindFidelity[];
  expected: number;
  matched: number;
  rate: number;
  issuesChecked: number;
}

const DAY = 86_400_000;
const MAX_EXAMPLES = 25;
const iso = (ms: number) => new Date(ms).toISOString();
const doc = (text: string) => canonicalJson(fromWiki(text.replace(/\r\n?/g, '\n')));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Db = Kysely<Database>;

class Tally {
  readonly kinds = new Map<string, KindFidelity>();

  of(kind: string): KindFidelity {
    let k = this.kinds.get(kind);
    if (!k) {
      k = { kind, expected: 0, matched: 0, extra: 0, examples: [] };
      this.kinds.set(kind, k);
    }
    return k;
  }

  /** Counts one expected entity: matched when nothing differs, else an example. */
  check(kind: string, source: string, differences: string[]): void {
    const k = this.of(kind);
    k.expected++;
    if (differences.length === 0) k.matched++;
    else if (k.examples.length < MAX_EXAMPLES) {
      k.examples.push(`${source}: ${differences.join('; ')}`);
    }
  }
}

/** Field-by-field differences between what was expected and what the target holds. */
function differ(expected: Record<string, unknown>, actual: Record<string, unknown> | undefined) {
  if (!actual) return ['missing'];
  const out: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) {
      out.push(
        `${key} ${JSON.stringify(got ?? null).slice(0, 80)} != ${JSON.stringify(want ?? null).slice(0, 80)}`,
      );
    }
  }
  return out;
}

interface Pending {
  issue: IssueFacts;
  comments: { id: number; c: parts.Comment }[];
  history: { id: number; g: parts.ChangeGroup }[];
  worklogs: { id: number; l: parts.Worklog }[];
  links: { id: number; l: parts.Link }[];
  webLinks: { id: number; w: parts.RemoteLink }[];
  attachments: { id: number; a: parts.Attachment }[];
}

export async function dcFidelity(
  db: Db,
  world: World,
  options: { workspaceId?: number; system?: string; every?: number; chunk?: number } = {},
): Promise<DcFidelity> {
  const ws = options.workspaceId ?? 1;
  const system = options.system ?? 'dc';
  const every = Math.max(1, options.every ?? 1);
  const chunkSize = options.chunk ?? 1000;
  const tally = new Tally();

  const external = async (kind: string, ids?: readonly string[]) => {
    let q = db
      .selectFrom('import_external_id')
      .select(['source_id', 'target_id'])
      .where('workspace_id', '=', ws)
      .where('import_source', '=', DC_SOURCE)
      .where('source_system', '=', system)
      .where('entity_kind', '=', kind);
    if (ids) {
      if (ids.length === 0) return new Map<string, number>();
      q = q.where('source_id', 'in', [...ids]);
    }
    return new Map((await q.execute()).map((r) => [r.source_id, Number(r.target_id)]));
  };
  const users = await external('user');
  const groups = await external('group');
  const roles = await external('role');
  const statuses = await external('status');
  const priorities = await external('priority');
  const closeReasons = await external('close_reason');
  const types = await external('ticket_type');
  const tracks = await external('track');
  const fields = await external('field');
  const linkTypeNames = new Map(world.linkTypes.map((t) => [t.id, t.name.toLowerCase()]));
  const effort = fields.get(String(effortFieldId(world)));
  const person = (p: Person | null) => (p ? (users.get(p.key.toLowerCase()) ?? -1) : null);
  const of = (map: Map<string, number>, id: number | string | null | undefined) =>
    id === null || id === undefined ? null : (map.get(String(id)) ?? -1);

  let issuesChecked = 0;
  const counters = { comment: FIRST_ID, group: FIRST_ID, worklog: FIRST_ID, link: FIRST_ID };
  const more = { webLink: FIRST_ID, attachment: FIRST_ID };
  let chunk: Pending[] = [];

  const verify = async (batch: Pending[]) => {
    const issueIds = new Set<string>();
    for (const p of batch) {
      issueIds.add(String(p.issue.id));
      if (p.issue.parent) issueIds.add(String(p.issue.parent.id));
      for (const { l } of p.links) {
        issueIds.add(String(l.source));
        issueIds.add(String(l.destination));
      }
    }
    const tickets = await external('ticket', [...issueIds]);
    const ticketOf = (id: number) => tickets.get(String(id)) ?? -1;
    const own = batch.map((p) => ticketOf(p.issue.id)).filter((t) => t > 0);
    const rows =
      own.length === 0
        ? []
        : await db.selectFrom('ticket').selectAll().where('id', 'in', own).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const peopleRows = async (table: 'ticket_follower' | 'ticket_vote') => {
      const out = new Map<number, Set<number>>();
      if (own.length === 0) return out;
      for (const r of await db
        .selectFrom(table)
        .select(['ticket_id', 'user_id'])
        .where('ticket_id', 'in', own)
        .execute()) {
        const set = out.get(r.ticket_id) ?? new Set<number>();
        out.set(r.ticket_id, set);
        set.add(r.user_id);
      }
      return out;
    };
    const followers = await peopleRows('ticket_follower');
    const votes = await peopleRows('ticket_vote');
    const keyRows =
      own.length === 0
        ? []
        : await db
            .selectFrom('ticket_key_history')
            .selectAll()
            .where('ticket_id', 'in', own)
            .where('replaced_at', 'is not', null)
            .execute();
    // The starting values: the change set holding each ticket's earliest key row.
    const startRows =
      own.length === 0
        ? []
        : await db
            .selectFrom('ticket_change')
            .select(['ticket_id', 'change_set', 'field', 'to_value', 'at', 'id'])
            .where('ticket_id', 'in', own)
            .where('field', 'in', ['key', 'status', 'track'])
            .orderBy('at')
            .orderBy('id')
            .execute();

    for (const p of batch) {
      const i = p.issue;
      const ticket = ticketOf(i.id);
      const row = byId.get(ticket);
      const logs = parts.worklogs(world, i);
      const spent = logs.reduce((n, l) => n + l.seconds, 0);
      const text = parts.description(world, i);
      tally.check(
        'ticket',
        i.key,
        differ(
          {
            track: of(tracks, i.project.id),
            number: i.number,
            type: of(types, i.type.id),
            status: of(statuses, i.status.id),
            priority: of(priorities, i.priority.id),
            closeReason: of(closeReasons, i.resolution?.id),
            summary: parts.summary(world, i).trim(),
            description: text === null ? null : doc(text),
            assignee: person(i.assignee),
            requester: person(i.reporter),
            creator: person(i.creator),
            parent: i.parent ? ticketOf(i.parent.id) : null,
            labels: [...new Set(parts.labels(world, i))].sort(),
            dueDate: i.due === null ? null : iso(i.due - (i.due % DAY)).slice(0, 10),
            createdAt: iso(i.created),
            updatedAt: iso(i.updated),
            closedAt: i.resolution ? iso(i.resolved as number) : null,
            originalEstimate: i.estimate,
            remainingEstimate: i.estimate === null ? null : Math.max(0, i.estimate - spent),
            timeSpent: spent,
          },
          row && {
            track: row.track_id,
            number: row.number,
            type: row.ticket_type_id,
            status: row.status_id,
            priority: row.priority_id,
            closeReason: row.close_reason_id,
            summary: row.summary,
            description: row.description === null ? null : canonicalJson(row.description),
            assignee: row.assignee_id,
            requester: row.requester_id,
            creator: row.creator_id,
            parent: row.parent_id,
            labels: [...row.labels].sort(),
            dueDate: row.due_date,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
            closedAt: row.closed_at?.toISOString() ?? null,
            originalEstimate: row.original_estimate,
            remainingEstimate: row.remaining_estimate,
            timeSpent: row.time_spent,
          },
        ),
      );

      // Followers and votes: each person the fixture names, and none it does not.
      for (const [kind, people, held] of [
        ['follower', parts.watchers(world, i), followers.get(ticket)],
        ['vote', parts.voters(world, i), votes.get(ticket)],
      ] as const) {
        const want = new Set(people.map((x) => person(x.person) as number));
        for (const id of want) {
          tally.check(kind, `${i.key} ${id}`, held?.has(id) ? [] : ['missing']);
        }
        for (const id of held ?? []) if (!want.has(id)) tally.of(kind).extra++;
      }

      // Earlier keys of a moved issue resolve to its ticket.
      if (i.moved) {
        const track = of(tracks, i.moved.project.id);
        const found = keyRows.find(
          (k) => k.ticket_id === ticket && k.track_id === track && k.number === i.moved?.number,
        );
        tally.check(
          'key_history',
          `${i.moved.project.key}-${i.moved.number}`,
          differ(
            { replacedAt: iso(i.moved.at) },
            found && { replacedAt: found.replaced_at?.toISOString() ?? null },
          ),
        );
      }

      // Starting values, worked out backwards from the history: the first status of the walk,
      // and the key and track a moved issue had.
      const start = startRows.filter((r) => r.ticket_id === ticket);
      const firstSet = start.find((r) => r.field === 'key')?.change_set;
      const startOf = (field: string) =>
        start.find((r) => r.change_set === firstSet && r.field === field)?.to_value ?? null;
      tally.check(
        'starting_value',
        i.key,
        differ(
          {
            status: String(of(statuses, i.status.path[0])),
            key: i.moved ? `${i.moved.project.key}-${i.moved.number}` : i.key,
            track: String(of(tracks, i.moved ? i.moved.project.id : i.project.id)),
          },
          firstSet === undefined
            ? undefined
            : { status: startOf('status'), key: startOf('key'), track: startOf('track') },
        ),
      );
    }

    // Comments.
    const commentIds = batch.flatMap((p) => p.comments.map((c) => String(c.id)));
    const comments = await external('comment', commentIds);
    const commentRows = await byIds([...comments.values()], (ids) =>
      db.selectFrom('ticket_comment').selectAll().where('id', 'in', ids).execute(),
    );
    for (const p of batch) {
      for (const { id, c } of p.comments) {
        const r = commentRows.get(comments.get(String(id)) ?? -1);
        const edited = c.updated !== c.created;
        tally.check(
          'comment',
          String(id),
          differ(
            {
              ticket: ticketOf(p.issue.id),
              author: person(c.author),
              body: doc(c.body),
              group: c.group === null ? null : of(groups, c.group.toLowerCase()),
              role: c.role === null ? null : of(roles, c.role),
              createdAt: iso(c.created),
              updatedAt: iso(c.updated),
              editedAt: edited ? iso(c.updated) : null,
              editedBy: edited ? person(c.updateAuthor) : null,
            },
            r && {
              ticket: r.ticket_id,
              author: r.author_id,
              body: canonicalJson(r.body),
              group: r.visible_group_id,
              role: r.visible_role_id,
              createdAt: r.created_at.toISOString(),
              updatedAt: r.updated_at.toISOString(),
              editedAt: r.edited_at?.toISOString() ?? null,
              editedBy: r.edited_by,
            },
          ),
        );
      }
    }

    // History entries, with their original authors and times.
    const historyIds = batch.flatMap((p) => p.history.map((h) => String(h.id)));
    const sets = await external('history', historyIds);
    const changeRows =
      sets.size === 0
        ? []
        : await db
            .selectFrom('ticket_change')
            .selectAll()
            .where('change_set', 'in', [...sets.values()].map(String))
            .execute();
    const bySet = new Map<string, typeof changeRows>();
    for (const r of changeRows) {
      const list = bySet.get(r.change_set) ?? [];
      bySet.set(r.change_set, list);
      list.push(r);
    }
    for (const p of batch) {
      for (const { id, g } of p.history) {
        const set = sets.get(String(id));
        const got = set === undefined ? undefined : bySet.get(String(set));
        const want = g.items.map((item) =>
          historyExpected(item, { of, tracks, statuses, priorities, closeReasons, users, effort }),
        );
        tally.check(
          'history',
          String(id),
          differ(
            {
              ticket: ticketOf(p.issue.id),
              actor: person(g.author),
              at: iso(g.created),
              items: want.sort(),
            },
            got && {
              ticket: got[0]?.ticket_id,
              actor: got[0]?.actor_id ?? null,
              at: got[0]?.at.toISOString(),
              items: got.map((r) => `${r.field}|${r.from_value ?? ''}|${r.to_value ?? ''}`).sort(),
            },
          ),
        );
      }
    }

    // Time entries.
    const worklogIds = batch.flatMap((p) => p.worklogs.map((w) => String(w.id)));
    const entries = await external('time_entry', worklogIds);
    const entryRows = await byIds([...entries.values()], (ids) =>
      db.selectFrom('time_entry').selectAll().where('id', 'in', ids).execute(),
    );
    for (const p of batch) {
      for (const { id, l } of p.worklogs) {
        const r = entryRows.get(entries.get(String(id)) ?? -1);
        tally.check(
          'time_entry',
          String(id),
          differ(
            {
              ticket: ticketOf(p.issue.id),
              author: person(l.author),
              startedAt: iso(l.started),
              seconds: l.seconds,
              description: l.body === null ? '' : toPlainText(fromWiki(l.body)).trim(),
              group: l.group === null ? null : of(groups, l.group.toLowerCase()),
              role: l.role === null ? null : of(roles, l.role),
              createdAt: iso(l.created),
            },
            r && {
              ticket: r.ticket_id,
              author: r.author_id,
              startedAt: r.started_at.toISOString(),
              seconds: r.duration,
              description: r.description,
              group: r.visible_group_id,
              role: r.visible_role_id,
              createdAt: r.created_at.toISOString(),
            },
          ),
        );
      }
    }

    // Links between tickets (sub-task links are the tickets' parents, checked above).
    const linkIds = batch.flatMap((p) => p.links.map((l) => String(l.id)));
    const links = await external('link', linkIds);
    const linkRows =
      links.size === 0
        ? new Map<number, { source_id: number; target_id: number; name: string }>()
        : new Map(
            (
              await db
                .selectFrom('ticket_link as l')
                .innerJoin('link_type as t', 't.id', 'l.link_type_id')
                .select(['l.id', 'l.source_id', 'l.target_id', 't.name'])
                .where('l.id', 'in', [...links.values()])
                .execute()
            ).map((r) => [r.id, r]),
          );
    for (const p of batch) {
      for (const { id, l } of p.links) {
        const r = linkRows.get(links.get(String(id)) ?? -1);
        tally.check(
          'link',
          String(id),
          differ(
            {
              source: ticketOf(l.source),
              target: ticketOf(l.destination),
              type: linkTypeNames.get(l.linkType),
            },
            r && { source: r.source_id, target: r.target_id, type: r.name.toLowerCase() },
          ),
        );
      }
    }

    // Web links.
    const webIds = batch.flatMap((p) => p.webLinks.map((w) => String(w.id)));
    const webs = await external('web_link', webIds);
    const webRows = await byIds([...webs.values()], (ids) =>
      db.selectFrom('ticket_web_link').selectAll().where('id', 'in', ids).execute(),
    );
    for (const p of batch) {
      for (const { id, w } of p.webLinks) {
        const r = webRows.get(webs.get(String(id)) ?? -1);
        tally.check(
          'web_link',
          String(id),
          differ(
            {
              ticket: ticketOf(p.issue.id),
              url: w.url,
              title: w.title,
              summary: w.summary ?? '',
              iconUrl: w.iconUrl,
              relationship: w.relationship ?? '',
              globalId: w.globalId,
            },
            r && {
              ticket: r.ticket_id,
              url: r.url,
              title: r.title,
              summary: r.summary,
              iconUrl: r.icon_url,
              relationship: r.relationship,
              globalId: r.global_id,
            },
          ),
        );
      }
    }

    // Attachments: name, type, size, author, time and the hash of the bytes the fixture wrote.
    const fileIds = batch.flatMap((p) => p.attachments.map((a) => String(a.id)));
    const files = await external('attachment', fileIds);
    const fileRows = await byIds([...files.values()], (ids) =>
      db.selectFrom('attachment').selectAll().where('id', 'in', ids).execute(),
    );
    for (const p of batch) {
      for (const { id, a } of p.attachments) {
        const r = fileRows.get(files.get(String(id)) ?? -1);
        tally.check(
          'attachment',
          String(id),
          differ(
            {
              ticket: ticketOf(p.issue.id),
              name: a.filename,
              declaredType: a.mimetype,
              size: a.size,
              sha256: sha256(parts.attachmentBytes(world, id, a.size)),
              author: person(a.author),
              createdAt: iso(a.created),
            },
            r && {
              ticket: r.ticket_id,
              name: r.name,
              declaredType: r.declared_type,
              size: Number(r.size),
              sha256: r.sha256,
              author: r.author_id,
              createdAt: r.created_at.toISOString(),
            },
          ),
        );
      }
    }
  };

  for (const issue of walkIssues(world)) {
    const take = issue.index % every === 0;
    const p: Pending = {
      issue,
      comments: [],
      history: [],
      worklogs: [],
      links: [],
      webLinks: [],
      attachments: [],
    };
    // Ids run over every issue in the generator's order, checked or not.
    for (const c of parts.comments(world, issue)) p.comments.push({ id: counters.comment++, c });
    for (const g of parts.history(world, issue)) p.history.push({ id: counters.group++, g });
    for (const l of parts.worklogs(world, issue)) p.worklogs.push({ id: counters.worklog++, l });
    for (const l of parts.links(world, issue)) {
      const id = counters.link++;
      if (l.sequence === null) p.links.push({ id, l });
    }
    for (const w of parts.remoteLinks(world, issue)) p.webLinks.push({ id: more.webLink++, w });
    for (const a of parts.attachments(world, issue))
      p.attachments.push({ id: more.attachment++, a });
    if (!take) continue;
    issuesChecked++;
    chunk.push(p);
    if (chunk.length >= chunkSize) {
      await verify(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) await verify(chunk);

  const kinds = [...tally.kinds.values()];
  const expected = kinds.reduce((n, k) => n + k.expected, 0);
  const matched = kinds.reduce((n, k) => n + k.matched, 0);
  return { kinds, expected, matched, rate: expected === 0 ? 1 : matched / expected, issuesChecked };
}

/** The custom field the fixture's history changes (`Effort`), by its source id. */
function effortFieldId(world: World): number | null {
  return fieldWorldOf(world).fields.find((f) => f.name === 'Effort')?.id ?? null;
}

/** Rows by id, loaded with one query (none for no ids). */
async function byIds<R extends { id: number }>(
  ids: readonly number[],
  load: (ids: number[]) => Promise<R[]>,
): Promise<Map<number, R>> {
  if (ids.length === 0) return new Map();
  return new Map((await load([...ids])).map((r) => [r.id, r]));
}

/** A history item as the target must hold it: `field|from|to` with target ids. */
function historyExpected(
  item: parts.ChangeItem,
  m: {
    of: (map: Map<string, number>, id: number | string | null | undefined) => number | null;
    tracks: Map<string, number>;
    statuses: Map<string, number>;
    priorities: Map<string, number>;
    closeReasons: Map<string, number>;
    users: Map<string, number>;
    effort: number | undefined;
  },
): string {
  const ids = (map: Map<string, number>, from: string | null, to: string | null, field: string) =>
    `${field}|${from === null ? '' : m.of(map, from)}|${to === null ? '' : m.of(map, to)}`;
  switch (item.field) {
    case 'status':
      return ids(m.statuses, item.oldvalue, item.newvalue, 'status');
    case 'resolution':
      return ids(m.closeReasons, item.oldvalue, item.newvalue, 'closeReason');
    case 'priority':
      return ids(m.priorities, item.oldvalue, item.newvalue, 'priority');
    case 'assignee':
      return ids(
        m.users,
        item.oldvalue?.toLowerCase() ?? null,
        item.newvalue?.toLowerCase() ?? null,
        'assignee',
      );
    case 'project':
      return ids(m.tracks, item.oldvalue, item.newvalue, 'track');
    case 'Key':
      return `key|${item.oldstring ?? ''}|${item.newstring ?? ''}`;
    case 'summary':
      return `summary|${item.oldstring ?? ''}|${item.newstring ?? ''}`;
    default:
      // The custom field the fixture changes.
      return `cf[${m.effort}]|${item.oldstring ?? ''}|${item.newstring ?? ''}`;
  }
}
