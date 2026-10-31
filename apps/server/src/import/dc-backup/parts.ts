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
  WORDS,
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
  const text = r.chance(0.7) ? paragraphs(r, 3) : null;
  // Wiki markup from a stream of its own (M1-091), so the text above stays as it was.
  const m = Random.derive(world.options.seed, 'description-markup', issue.index);
  return text !== null && m.chance(0.25) ? `${text}\n\n${wikiSnippet(m)}` : text;
}

/**
 * A few lines of wiki markup, the format the backup's text fields are written in (M1-091):
 * headings, lists, emphasis, monospace, links, quotes, code blocks and tables, in our own
 * words.
 */
export function wikiSnippet(r: Random): string {
  const w = () => r.pick(WORDS);
  switch (r.int(0, 7)) {
    case 0:
      return `h3. ${capitalWord(w())} notes\n${w()} and ${w()} after the ${w()} change.`;
    case 1:
      return `* *${w()}* first\n* the ${w()} with {{${w()}.json}}\n* _${w()}_ last`;
    case 2:
      return `# open the ${w()}\n# check the ${w()}\n# close it again`;
    case 3:
      return `See [the ${w()} guide|https://docs.example.test/${r.int(1, 999)}] for -old- details.`;
    case 4:
      return `{quote}The ${w()} must not ${w()}.{quote}`;
    case 5:
      return `{code}\nretry(${w()}, ${r.int(1, 9)});\n{code}`;
    case 6:
      return `||Name||Value||\n|${w()}|${r.int(1, 99)}|\n|${w()}|${r.int(1, 99)}|`;
    default:
      return `A +${w()}+ note, ^${r.int(1, 9)}^ and ~${r.int(1, 9)}~ marks, and a ??${w()}?? cite.`;
  }
}

const capitalWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  // Wiki markup from a stream of its own (M1-091), so the comments above stay as they were.
  const m = Random.derive(world.options.seed, 'comment-markup', issue.index);
  for (const c of out) if (m.chance(0.15)) c.body = `${c.body}\n\n${wikiSnippet(m)}`;
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
  if (issue.moved) {
    // A move into the issue's project gave it a new key (M1-091), from a stream of its own.
    const m = Random.derive(world.options.seed, 'moved-history', issue.index);
    const from = issue.moved.project;
    groups.push({
      author: m.chance(0.01) ? null : world.pickPerson(m),
      created: issue.moved.at,
      items: [
        {
          fieldtype: 'jira',
          field: 'project',
          oldvalue: String(from.id),
          oldstring: from.name,
          newvalue: String(issue.project.id),
          newstring: issue.project.name,
        },
        {
          fieldtype: 'jira',
          field: 'Key',
          oldvalue: null,
          oldstring: `${from.key}-${issue.moved.number}`,
          newvalue: null,
          newstring: issue.key,
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
  /** Visible only to this group's members, or to this role in the project (M1-091). */
  group: string | null;
  role: number | null;
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
      group: null,
      role: null,
    });
  }
  // Restrictions and markup from streams of their own (M1-091), so the entries stay as they were.
  const v = Random.derive(world.options.seed, 'worklog-visibility', issue.index);
  for (const l of out) {
    const restricted = v.next();
    if (restricted < 0.03) l.group = v.pick(world.groups).name;
    else if (restricted < 0.06) l.role = v.pick(world.roles).id;
    if (l.body !== null && v.chance(0.1)) l.body = `${l.body} *${v.pick(WORDS)}*`;
  }
  return out;
}

/** The people who watch an issue (M1-091): its reporter first, then others, all present. */
export function watchers(world: World, issue: IssueFacts): { person: Person; at: number }[] {
  const r = Random.derive(world.options.seed, 'watchers', issue.index);
  return distinctPeople(
    world,
    r,
    issue,
    issue.watches,
    issue.reporter.deleted ? [] : [issue.reporter],
  );
}

/** The people who voted for an issue (M1-091), never its reporter. */
export function voters(world: World, issue: IssueFacts): { person: Person; at: number }[] {
  const r = Random.derive(world.options.seed, 'voters', issue.index);
  return distinctPeople(world, r, issue, issue.votes, [], issue.reporter);
}

function distinctPeople(
  world: World,
  r: Random,
  issue: IssueFacts,
  count: number,
  first: Person[],
  never: Person | null = null,
): { person: Person; at: number }[] {
  const chosen = new Map<string, Person>();
  for (const p of first) chosen.set(p.key, p);
  for (let tries = 0; chosen.size < count && tries < count * 8; tries++) {
    const p = world.pickPerson(r);
    if (p.deleted || p === never || chosen.has(p.key)) continue;
    chosen.set(p.key, p);
  }
  return [...chosen.values()]
    .slice(0, count)
    .map((person) => ({ person, at: between(r, issue.created, issue.updated) }));
}

export interface RemoteLink {
  url: string;
  title: string;
  summary: string | null;
  globalId: string | null;
  iconUrl: string | null;
  iconTitle: string | null;
  relationship: string | null;
  applicationType: string | null;
  applicationName: string | null;
}

/** Links from an issue to pages outside the tracker (M1-091). */
export function remoteLinks(world: World, issue: IssueFacts): RemoteLink[] {
  const r = Random.derive(world.options.seed, 'remote-links', issue.index);
  if (!r.chance(0.06)) return [];
  const out: RemoteLink[] = [];
  for (let n = r.int(1, 2); n > 0; n--) {
    const page = r.int(1, 99_999);
    const word = r.pick(WORDS);
    const app = r.chance(0.4);
    out.push({
      url: `https://docs.example.test/${encodeURIComponent(word)}/${page}`,
      title: `${capitalWord(word)} page ${page}`,
      summary: r.chance(0.5) ? words(r, r.int(3, 9)) : null,
      globalId: app ? `appId=docs-example&pageId=${page}` : null,
      iconUrl: r.chance(0.5) ? 'https://docs.example.test/favicon.ico' : null,
      iconTitle: app ? 'Example docs' : null,
      relationship: r.pick(['mentioned in', 'wiki page', 'relates to', null]),
      applicationType: app ? 'com.example.docs' : null,
      applicationName: app ? 'Example docs' : null,
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
