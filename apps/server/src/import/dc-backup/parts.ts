import { effortOf } from './fields';
import { Random } from './random';
import {
  between,
  FILE_KINDS,
  type IssueFacts,
  LABELS,
  type Person,
  paragraphs,
  type Status,
  summaryOf,
  type World,
  words,
} from './world';

/**
 * What belongs to one issue besides its own row, each from its own stream of the seed, so any
 * pass can recompute one part without the others (`world.ts`). Ids are not given here: the pass
 * that writes a part numbers its rows in walk order.
 */

const MINUTE = 60_000;

export function summary(world: World, issue: IssueFacts): string {
  return summaryOf(Random.derive(world.options.seed, 'summary', issue.index));
}

export function description(world: World, issue: IssueFacts): string | null {
  const r = Random.derive(world.options.seed, 'description', issue.index);
  return r.chance(0.7) ? paragraphs(r, 3) : null;
}

export interface Comment {
  author: Person;
  body: string;
  created: number;
  updated: number;
  updateAuthor: Person;
  /** Visible only to this group's members, or to this role in the project. */
  group: string | null;
  role: number | null;
}

export function comments(world: World, issue: IssueFacts): Comment[] {
  const r = Random.derive(world.options.seed, 'comments', issue.index);
  const out: Comment[] = [];
  for (let n = r.geometric(1.2, 40); n > 0; n--) {
    const author = world.pickPerson(r);
    const created = between(r, issue.created, issue.updated);
    const edited = r.chance(0.1);
    const restricted = r.next();
    out.push({
      author,
      body: paragraphs(r, 2),
      created,
      updated: edited ? between(r, created, issue.updated) : created,
      updateAuthor: edited && r.chance(0.3) ? world.pickPerson(r) : author,
      group: restricted < 0.04 ? r.pick(world.groups).name : null,
      role: restricted >= 0.04 && restricted < 0.07 ? r.pick(world.roles).id : null,
    });
  }
  return out.sort((a, b) => a.created - b.created);
}

export interface ChangeItem {
  fieldtype: 'jira' | 'custom';
  field: string;
  oldvalue: string | null;
  oldstring: string | null;
  newvalue: string | null;
  newstring: string | null;
}

export interface ChangeGroup {
  /** Null for an anonymous change. */
  author: Person | null;
  created: number;
  items: ChangeItem[];
}

const named = (x: { id: number; name: string } | null): [string | null, string | null] =>
  x ? [String(x.id), x.name] : [null, null];
const person = (x: Person | null): [string | null, string | null] =>
  x ? [x.key, x.displayName] : [null, null];

/**
 * The issue's change history: its status from the initial one to the current one (the step
 * into a done status sets the resolution at the issue's resolution time), sometimes a change
 * of assignee, priority, summary or a custom field. Each change leads to the issue's current
 * values, so an importer can recompute the starting values from the history.
 */
export function history(world: World, issue: IssueFacts): ChangeGroup[] {
  const r = Random.derive(world.options.seed, 'history', issue.index);
  const groups: ChangeGroup[] = [];
  const actor = () => (r.chance(0.01) ? null : world.pickPerson(r));
  const last = issue.resolved ?? issue.updated;
  const path = issue.status.path;
  for (let s = 1; s < path.length; s++) {
    const from = world.statuses.find((x) => x.id === path[s - 1]) as Status;
    const to = world.statuses.find((x) => x.id === path[s]) as Status;
    const created =
      s === path.length - 1 && issue.resolved !== null
        ? issue.resolved
        : issue.created + Math.floor(((last - issue.created) * s) / path.length);
    const items: ChangeItem[] = [
      {
        fieldtype: 'jira',
        field: 'status',
        oldvalue: String(from.id),
        oldstring: from.name,
        newvalue: String(to.id),
        newstring: to.name,
      },
    ];
    if (s === path.length - 1 && issue.resolution) {
      const [newvalue, newstring] = named(issue.resolution);
      items.push({
        fieldtype: 'jira',
        field: 'resolution',
        oldvalue: null,
        oldstring: null,
        newvalue,
        newstring,
      });
    }
    groups.push({ author: actor(), created, items });
  }
  if (issue.assignee && r.chance(0.5)) {
    const before = r.chance(0.5) ? world.pickPerson(r) : null;
    const [oldvalue, oldstring] = person(before?.key === issue.assignee.key ? null : before);
    const [newvalue, newstring] = person(issue.assignee);
    groups.push({
      author: actor(),
      created: between(r, issue.created + MINUTE, issue.updated),
      items: [{ fieldtype: 'jira', field: 'assignee', oldvalue, oldstring, newvalue, newstring }],
    });
  }
  if (r.chance(0.1)) {
    const others = world.priorities.filter((p) => p.id !== issue.priority.id);
    const [oldvalue, oldstring] = named(r.pick(others));
    const [newvalue, newstring] = named(issue.priority);
    groups.push({
      author: actor(),
      created: between(r, issue.created + MINUTE, issue.updated),
      items: [{ fieldtype: 'jira', field: 'priority', oldvalue, oldstring, newvalue, newstring }],
    });
  }
  if (r.chance(0.05)) {
    groups.push({
      author: actor(),
      created: between(r, issue.created + MINUTE, issue.updated),
      items: [
        {
          fieldtype: 'jira',
          field: 'summary',
          oldvalue: null,
          oldstring: summaryOf(r),
          newvalue: null,
          newstring: summary(world, issue),
        },
      ],
    });
  }
  if (r.chance(0.05)) {
    const before = r.int(1, 13);
    const author = actor();
    const created = between(r, issue.created + MINUTE, issue.updated);
    const step = r.int(1, 8);
    // The change ends at the issue's current value, or clears it when it has none (M1-089).
    const now = effortOf(world, issue);
    groups.push({
      author,
      created,
      items: [
        {
          fieldtype: 'custom',
          field: 'Effort',
          oldvalue: null,
          oldstring: String(now === before ? before + step : before),
          newvalue: null,
          newstring: now === null ? null : String(now),
        },
      ],
    });
  }
  // Stable for equal times: the status path keeps its order.
  return groups
    .map((g, k) => ({ g, k }))
    .sort((a, b) => a.g.created - b.g.created || a.k - b.k)
    .map(({ g }) => g);
}

export interface Link {
  linkType: number;
  source: number;
  destination: number;
  /** Set on sub-task links: the sub-task's position under its parent, from 0. */
  sequence: number | null;
}

/** The sub-task link to the parent, and sometimes a link to an earlier issue. */
export function links(world: World, issue: IssueFacts): Link[] {
  const out: Link[] = [];
  if (issue.parent) {
    const type = world.linkTypes.find((t) => t.subtask);
    out.push({
      linkType: type?.id as number,
      source: issue.parent.id,
      destination: issue.id,
      sequence: issue.parent.sequence - 1,
    });
  }
  const r = Random.derive(world.options.seed, 'links', issue.index);
  if (issue.index > 0 && r.chance(0.08)) {
    const type = r.pick(world.linkTypes.filter((t) => !t.subtask));
    out.push({
      linkType: type.id,
      source: issue.id,
      destination: issue.id - 1 - r.int(0, Math.min(issue.index - 1, 5000)),
      sequence: null,
    });
  }
  return out;
}

export function labels(world: World, issue: IssueFacts): string[] {
  const r = Random.derive(world.options.seed, 'labels', issue.index);
  if (!r.chance(0.25)) return [];
  const out = new Set<string>();
  for (let n = r.int(1, 3); n > 0; n--) out.add(r.pick(LABELS));
  return [...out];
}

export interface Worklog {
  author: Person;
  updateAuthor: Person;
  body: string | null;
  started: number;
  created: number;
  updated: number;
  seconds: number;
}

export function worklogs(world: World, issue: IssueFacts): Worklog[] {
  const r = Random.derive(world.options.seed, 'worklogs', issue.index);
  if (!r.chance(0.15)) return [];
  const out: Worklog[] = [];
  for (let n = r.int(1, 4); n > 0; n--) {
    const author = world.pickPerson(r);
    const started = between(r, issue.created, issue.updated);
    const created = between(r, started, issue.updated);
    out.push({
      author,
      updateAuthor: author,
      body: r.chance(0.6) ? words(r, r.int(2, 12)) : null,
      started,
      created,
      updated: created,
      seconds: r.int(1, 32) * 900,
    });
  }
  return out;
}

export interface Attachment {
  filename: string;
  mimetype: string;
  size: number;
  created: number;
  author: Person;
}

export function attachments(world: World, issue: IssueFacts): Attachment[] {
  const r = Random.derive(world.options.seed, 'attachments', issue.index);
  if (!r.chance(world.options.attachmentRate)) return [];
  const out: Attachment[] = [];
  for (let n = r.int(1, 3); n > 0; n--) {
    const kind = r.pick(FILE_KINDS);
    out.push({
      filename: `${r.pick(LABELS)}-${r.int(1, 999)}.${kind.ext}`,
      mimetype: kind.mime,
      size: r.int(16, 4096),
      created: between(r, issue.created, issue.updated),
      author: world.pickPerson(r),
    });
  }
  return out;
}

/** An attachment's bytes, recomputed from its id: lines of words, cut to the size. */
export function attachmentBytes(world: World, attachmentId: number, size: number): Buffer {
  const r = Random.derive(world.options.seed, 'file', attachmentId);
  const lines: string[] = [];
  let length = 0;
  while (length < size) {
    const line = `${attachmentId} ${words(r, 8)}\n`;
    lines.push(line);
    length += Buffer.byteLength(line);
  }
  return Buffer.from(lines.join(''), 'utf8').subarray(0, size);
}
