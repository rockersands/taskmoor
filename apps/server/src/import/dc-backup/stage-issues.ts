import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GROUP_FIELD_TYPES,
  MOVE_FIELDS,
  PERSON_FIELD_TYPES,
  VOTE_ISSUE,
  WATCH_ISSUE,
} from './format';
import { Buckets, byId, SpillFile } from './spill';
import type { StagedField } from './stage-fields';

/**
 * The issue part of the stage (M1-089, M1-091; IMP-001, IMP-004; ADR-089, ADR-092): each issue
 * with its custom values, labels, parent, watchers, voters and earlier keys as one ticket
 * record, and its comments, change history, time entries, links, web links and attachments as
 * records of their own.
 *
 * Memory stays flat however many issues there are (IMP-001 (1)). While the backup is read,
 * rows go to files: the rows that make up a ticket (the issue, its values, labels, watchers and
 * voters) into buckets by issue id range, change groups and their items into buckets by change
 * group id range, and every other row into one file per element. After the file, since rows
 * come in no order the format promises, each bucket is read on its own and joined in memory,
 * and the other files are read once and rewritten as records. Tickets are written in issue id
 * order, issues without a parent first, so a parent is always loaded before its children.
 * Memory holds one bucket, the sub-task links (one entry per sub-task), the earlier keys of
 * moved issues, and an index of the attachment files.
 */

/** One stored row of a custom value: a parent key (cascades), and one of four values. */
export interface StagedValueRow {
  parentKey: string | null;
  string: string | null;
  number: number | null;
  text: string | null;
  date: string | null;
}

/** A custom field's values on an issue, with the field's type key (null: no field row). */
export interface StagedValue {
  field: string;
  type: string | null;
  rows: StagedValueRow[];
  /** Values a labels field keeps as label rows. */
  labels?: string[];
}

/** A key an issue had before a move (M1-091): the project by its id when the key names one. */
export interface StagedFormerKey {
  key: string;
  project: string | null;
  number: number | null;
  /** When the issue left the key, from its history; null when the history does not say. */
  at: string | null;
}

export interface StagedIssue {
  id: string;
  project: string;
  number: number | null;
  type: string;
  status: string;
  priority: string | null;
  resolution: string | null;
  /** People by staged id (lower-case user key). */
  reporter: string | null;
  assignee: string | null;
  creator: string | null;
  summary: string;
  description: string | null;
  environment: string | null;
  created: string | null;
  updated: string | null;
  resolved: string | null;
  due: string | null;
  estimate: number | null;
  remaining: number | null;
  /** The issue's security level id (M1-092). */
  security: string | null;
  /** The parent of a sub-task, from its sub-task link. */
  parent: string | null;
  labels: string[];
  values: StagedValue[];
  /** Watchers and voters by staged id, in the order of their rows (M1-091). */
  followers: string[];
  voters: string[];
  formerKeys: StagedFormerKey[];
}

/** A comment (M1-091): visibility by group (staged id) or role, as the backup restricts it. */
export interface StagedComment {
  id: string;
  issue: string;
  author: string | null;
  updateAuthor: string | null;
  body: string;
  created: string | null;
  updated: string | null;
  /** The group's name as written, and its staged id (null: no such group). */
  groupName: string | null;
  group: string | null;
  role: string | null;
  roleKnown: boolean;
}

export interface StagedChangeItem {
  fieldtype: string;
  field: string;
  oldvalue: string | null;
  oldstring: string | null;
  newvalue: string | null;
  newstring: string | null;
  /** A custom field's id, by its name (custom items only; null when no field has it). */
  customField?: string | null;
  /** Display text the backup lacks: a project's key for project changes. */
  oldDisplay?: string | null;
  newDisplay?: string | null;
}

/** A change group with its items, people resolved (M1-091). */
export interface StagedChange {
  id: string;
  issue: string;
  author: string | null;
  created: string | null;
  items: StagedChangeItem[];
}

export interface StagedWorklog {
  id: string;
  issue: string;
  author: string | null;
  updateAuthor: string | null;
  body: string | null;
  created: string | null;
  updated: string | null;
  started: string | null;
  seconds: number | null;
  groupName: string | null;
  group: string | null;
  role: string | null;
  roleKnown: boolean;
}

/** A link between issues other than a sub-task's to its parent (M1-091). */
export interface StagedLink {
  id: string;
  source: string;
  destination: string;
  /** The link type; null when the link names no type row. */
  type: { id: string; name: string; outward: string; inward: string } | null;
}

export interface StagedWebLink {
  id: string;
  issue: string;
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

/** Where an attachment's bytes are in the ZIP, and what the stage read of them. */
export interface StagedFile {
  /** `zip:<local header offset>:<compressed size>:<method>:<size>`, for `DcBackupSource`. */
  locator: string;
  size: number;
  sha256: string;
  sniffed: string | null;
  /** The issue key of the file's folder. */
  folderKey: string | null;
}

export interface StagedAttachment {
  id: string;
  issue: string;
  /** The issue's key now, for comparing with the file's folder. */
  issueKey: string | null;
  filename: string;
  mimetype: string | null;
  size: number | null;
  created: string | null;
  author: string | null;
  /** Null when the backup holds no file for it. */
  file: StagedFile | null;
}

/** Elements this part reads (`IssueLink`, `UserAssociation`, `Action` in part: `partial`). */
export const ISSUE_ELEMENTS = [
  'Issue',
  'CustomFieldValue',
  'Label',
  'IssueLink',
  'UserAssociation',
  'MovedIssueKey',
  'ChangeGroup',
  'ChangeItem',
  'Action',
  'Worklog',
  'FileAttachment',
  'RemoteIssueLink',
] as const;

/** The staged kinds this part writes besides tickets, with the element each comes from. */
export const CONTENT_KINDS = {
  comment: 'Action',
  link: 'IssueLink',
  web_link: 'RemoteIssueLink',
  time_entry: 'Worklog',
  attachment: 'FileAttachment',
  history: 'ChangeGroup',
} as const;

/** Issues per ticket bucket and change groups per history bucket (ids are close to dense). */
const ISSUES_PER_BUCKET = 16_384;
const GROUPS_PER_BUCKET = 65_536;

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type ValueRow = [
  'V',
  issue: string,
  field: string,
  parentKey: string | null,
  string: string | null,
  number: number | null,
  text: string | null,
  date: string | null,
];
type LabelRow = ['L', issue: string, field: string | null, label: string];
/** Ticket bucket rows: an issue, a value, a label, a watcher (W) or a voter (O). */
type TicketRow =
  | ['I', Record<string, string>]
  | ValueRow
  | LabelRow
  | ['W' | 'O', issue: string, person: string];

/** History bucket rows: a change group or an item. */
type HistoryRow =
  | ['G', id: string, issue: string, author: string | null, created: string | null]
  | ['C', group: string, id: string, item: StagedChangeItem];

/** What the stage resolves after the file, for this part to name things by. */
export interface IssueResolve {
  person: (raw: string) => string;
  group: (raw: string) => string | null;
  roleKnown: (id: string) => boolean;
  fields: ReadonlyMap<string, StagedField>;
  linkTypes: ReadonlyMap<string, { name: string; outward: string; inward: string; style: string }>;
  /** Projects by id (their key now), and project ids by every key they had (upper case). */
  projects: ReadonlyMap<string, { key: string }>;
  projectByKey: ReadonlyMap<string, string>;
  /** Attachment files of the ZIP by attachment id. */
  files: ReadonlyMap<string, StagedFile>;
}

type RawElement = 'Action' | 'Worklog' | 'FileAttachment' | 'RemoteIssueLink' | 'IssueLink';

export class IssueCollector {
  private readonly tickets: Buckets;
  private readonly history: Buckets;
  private readonly raw: Record<RawElement, SpillFile>;
  /** Earlier keys of moved issues, by issue (few: moves are rare). */
  private readonly moved = new Map<string, string[]>();
  /** Rows of consumed elements this part leaves out, by element. */
  readonly partial: Record<string, number> = {};
  private issues = 0;

  constructor(private readonly dir: string) {
    this.tickets = new Buckets(join(dir, 'spill', 'ticket'), ISSUES_PER_BUCKET);
    this.history = new Buckets(join(dir, 'spill', 'history'), GROUPS_PER_BUCKET);
    const file = (name: string) => new SpillFile(join(dir, 'spill', `${name}.ndjson`));
    this.raw = {
      Action: file('action'),
      Worklog: file('worklog'),
      FileAttachment: file('attachment'),
      RemoteIssueLink: file('remote-link'),
      IssueLink: file('link'),
    };
  }

  /** Makes the spill folder; call before the first row. */
  async open(): Promise<void> {
    await mkdir(join(this.dir, 'spill'), { recursive: true });
  }

  /** Removes the spill files (a stage that failed or finished). */
  async dispose(): Promise<void> {
    await rm(join(this.dir, 'spill'), { recursive: true, force: true });
  }

  private leaveOut(name: string): void {
    this.partial[name] = (this.partial[name] ?? 0) + 1;
  }

  row(name: string, v: Record<string, string>): void {
    switch (name) {
      case 'Issue':
        this.issues++;
        this.tickets.add(v.id ?? '', ['I', v] satisfies TicketRow);
        return;
      case 'CustomFieldValue': {
        const issue = v.issue ?? '';
        this.tickets.add(issue, [
          'V',
          issue,
          v.customfield ?? '',
          v.parentkey ?? null,
          v.stringvalue ?? null,
          num(v.numbervalue),
          v.textvalue ?? null,
          v.datevalue ?? null,
        ] satisfies TicketRow);
        return;
      }
      case 'Label': {
        const issue = v.issue ?? '';
        this.tickets.add(issue, ['L', issue, v.fieldid ?? null, v.label ?? ''] satisfies TicketRow);
        return;
      }
      case 'UserAssociation': {
        const type = v.associationType;
        if (v.sinkNodeEntity !== 'Issue' || (type !== WATCH_ISSUE && type !== VOTE_ISSUE)) {
          // Other associations (favourite filters, say) are not read yet.
          this.leaveOut(name);
          return;
        }
        const issue = v.sinkNodeId ?? '';
        const tag = type === WATCH_ISSUE ? 'W' : 'O';
        this.tickets.add(issue, [tag, issue, v.sourceName ?? ''] satisfies TicketRow);
        return;
      }
      case 'MovedIssueKey': {
        const issue = v.issueId ?? '';
        const keys = this.moved.get(issue) ?? [];
        this.moved.set(issue, keys);
        if (v.oldIssueKey) keys.push(v.oldIssueKey);
        return;
      }
      case 'ChangeGroup': {
        const id = v.id ?? '';
        this.history.add(id, [
          'G',
          id,
          v.issue ?? '',
          v.author ?? null,
          v.created ?? null,
        ] satisfies HistoryRow);
        return;
      }
      case 'ChangeItem': {
        const group = v.group ?? '';
        this.history.add(group, [
          'C',
          group,
          v.id ?? '',
          {
            fieldtype: v.fieldtype ?? '',
            field: v.field ?? '',
            oldvalue: v.oldvalue ?? null,
            oldstring: v.oldstring ?? null,
            newvalue: v.newvalue ?? null,
            newstring: v.newstring ?? null,
          },
        ] satisfies HistoryRow);
        return;
      }
      case 'Action':
      case 'Worklog':
      case 'FileAttachment':
      case 'RemoteIssueLink':
      case 'IssueLink':
        this.raw[name].add(v);
        return;
    }
  }

  get issueCount(): number {
    return this.issues;
  }

  /**
   * People named by custom values of person fields, for the people the stage keeps (M1-089):
   * read from the ticket buckets once the fields are known.
   */
  async personValues(fields: ReadonlyMap<string, StagedField>): Promise<string[]> {
    const out: string[] = [];
    for (const bucket of this.tickets.buckets()) {
      for await (const row of bucket.read()) {
        const r = row as TicketRow;
        if (r[0] !== 'V') continue;
        const type = fields.get(r[2])?.typeKey;
        if (r[4] && type && PERSON_FIELD_TYPES.has(type)) out.push(r[4]);
      }
    }
    return out;
  }

  /**
   * Writes the ticket records and the content records (`<kind>.ndjson` in the stage's folder)
   * and returns the number of records per kind. Call once, after the whole backup is read.
   */
  async writeAll(resolve: IssueResolve): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const person = (v: string | null | undefined) => (v ? resolve.person(v) : null);

    // Links: sub-task links make parents; every other link is a record of its own.
    const parents = new Map<string, string>();
    const links = new RecordFile(join(this.dir, 'link.ndjson'));
    for await (const row of this.raw.IssueLink.read()) {
      const v = row as Record<string, string>;
      const type = resolve.linkTypes.get(v.linktype ?? '');
      const destination = v.destination ?? '';
      if (type?.style === 'jira_subtask') {
        if (!parents.has(destination)) parents.set(destination, v.source ?? '');
        else this.leaveOut('IssueLink');
        continue;
      }
      const record: StagedLink = {
        id: v.id ?? '',
        source: v.source ?? '',
        destination,
        type: type
          ? { id: v.linktype ?? '', name: type.name, outward: type.outward, inward: type.inward }
          : null,
      };
      await links.write(record.id, record);
    }
    counts.link = await links.close();

    // History before tickets: it says when moved issues left their earlier keys.
    const leftKey = new Map<string, string>();
    const history = new RecordFile(join(this.dir, 'history.ndjson'));
    const fieldByName = new Map<string, string>();
    for (const f of [...resolve.fields.values()].sort((a, b) => byId(a.id, b.id))) {
      if (!fieldByName.has(f.name.toLowerCase())) fieldByName.set(f.name.toLowerCase(), f.id);
    }
    for (const bucket of this.history.buckets()) {
      const groups = new Map<string, StagedChange>();
      const items: { group: string; id: string; item: StagedChangeItem }[] = [];
      for await (const row of bucket.read()) {
        const r = row as HistoryRow;
        if (r[0] === 'G') {
          groups.set(r[1], {
            id: r[1],
            issue: r[2],
            author: person(r[3]),
            created: r[4],
            items: [],
          });
        } else items.push({ group: r[1], id: r[2], item: r[3] });
      }
      items.sort((a, b) => byId(a.id, b.id));
      for (const { group, item } of items) {
        const g = groups.get(group);
        if (!g) {
          this.leaveOut('ChangeItem');
          continue;
        }
        g.items.push(changeItem(item, resolve, fieldByName));
      }
      for (const g of [...groups.values()].sort((a, b) => byId(a.id, b.id))) {
        if (this.moved.has(g.issue)) {
          for (const item of g.items) {
            if (item.fieldtype === 'jira' && item.field === MOVE_FIELDS.key && item.oldstring) {
              leftKey.set(`${g.issue}\u0000${item.oldstring}`, g.created ?? '');
            }
          }
        }
        await history.write(g.id, g);
      }
    }
    counts.history = await history.close();

    // Attachments need their issue's key: the issues that have one are noted first.
    const withFiles = new Set<string>();
    for await (const row of this.raw.FileAttachment.read()) {
      withFiles.add((row as Record<string, string>).issue ?? '');
    }
    const issueKeys = new Map<string, string>();

    // Tickets, a bucket at a time, issues without a parent first.
    const roots = new RecordFile(join(this.dir, 'ticket.ndjson'));
    const children = new SpillFile(join(this.dir, 'spill', 'children.ndjson'));
    for (const bucket of this.tickets.buckets()) {
      const issues: Record<string, string>[] = [];
      const values = new Map<string, ValueRow[]>();
      const labels = new Map<string, LabelRow[]>();
      const people = new Map<string, { followers: string[]; voters: string[] }>();
      for await (const row of bucket.read()) {
        const r = row as TicketRow;
        switch (r[0]) {
          case 'I':
            issues.push(r[1]);
            break;
          case 'V':
            listOf(values, r[1]).push(r);
            break;
          case 'L':
            listOf(labels, r[1]).push(r);
            break;
          case 'W':
          case 'O': {
            let p = people.get(r[1]);
            if (!p) {
              p = { followers: [], voters: [] };
              people.set(r[1], p);
            }
            const id = resolve.person(r[2]);
            const into = r[0] === 'W' ? p.followers : p.voters;
            if (!into.includes(id)) into.push(id);
            break;
          }
        }
      }
      issues.sort((a, b) => byId(a.id ?? '', b.id ?? ''));
      for (const v of issues) {
        const id = v.id ?? '';
        const parent = parents.get(id) ?? null;
        const number = int(v.number);
        const project = v.project ?? '';
        if (withFiles.has(id) && number !== null) {
          const key = resolve.projects.get(project)?.key;
          if (key) issueKeys.set(id, `${key}-${number}`);
        }
        const record: StagedIssue = {
          id,
          project,
          number,
          type: v.type ?? '',
          status: v.status ?? '',
          priority: v.priority ?? null,
          resolution: v.resolution ?? null,
          reporter: person(v.reporter),
          assignee: person(v.assignee),
          creator: person(v.creator),
          summary: v.summary ?? '',
          description: v.description ?? null,
          environment: v.environment ?? null,
          created: v.created ?? null,
          updated: v.updated ?? null,
          resolved: v.resolutiondate ?? null,
          due: v.duedate ?? null,
          estimate: int(v.timeoriginalestimate),
          remaining: int(v.timeestimate),
          security: v.security ?? null,
          parent,
          labels: [],
          values: valuesOf(values.get(id) ?? [], labels.get(id) ?? [], resolve),
          followers: people.get(id)?.followers ?? [],
          voters: people.get(id)?.voters ?? [],
          formerKeys: (this.moved.get(id) ?? []).map((key) => {
            const m = /^(.+)-(\d+)$/.exec(key);
            return {
              key,
              project: m
                ? (resolve.projectByKey.get((m[1] as string).toUpperCase()) ?? null)
                : null,
              number: m ? Number(m[2]) : null,
              at: leftKey.get(`${id}\u0000${key}`) || null,
            };
          }),
        };
        for (const [, , field, label] of labels.get(id) ?? []) {
          if (field === null) record.labels.push(label);
        }
        if (parent === null) await roots.write(id, record);
        else children.add({ id, label: '', data: record });
      }
    }
    for await (const line of children.read()) await roots.writeLine(line);
    counts.ticket = await roots.close();

    // Comments, time entries and web links: one record per row.
    const comments = new RecordFile(join(this.dir, 'comment.ndjson'));
    for await (const row of this.raw.Action.read()) {
      const v = row as Record<string, string>;
      if (v.type !== undefined && v.type !== 'comment') {
        this.leaveOut('Action');
        continue;
      }
      const groupName = v.level ?? null;
      const record: StagedComment = {
        id: v.id ?? '',
        issue: v.issue ?? '',
        author: person(v.author),
        updateAuthor: person(v.updateauthor),
        body: v.body ?? '',
        created: v.created ?? null,
        updated: v.updated ?? null,
        groupName,
        group: groupName === null ? null : resolve.group(groupName),
        role: v.rolelevel ?? null,
        roleKnown: v.rolelevel === undefined || resolve.roleKnown(v.rolelevel),
      };
      await comments.write(record.id, record);
    }
    counts.comment = await comments.close();

    const worklogs = new RecordFile(join(this.dir, 'time_entry.ndjson'));
    for await (const row of this.raw.Worklog.read()) {
      const v = row as Record<string, string>;
      const groupName = v.grouplevel ?? null;
      const record: StagedWorklog = {
        id: v.id ?? '',
        issue: v.issue ?? '',
        author: person(v.author),
        updateAuthor: person(v.updateauthor),
        body: v.body ?? null,
        created: v.created ?? null,
        updated: v.updated ?? null,
        started: v.startdate ?? null,
        seconds: int(v.timeworked),
        groupName,
        group: groupName === null ? null : resolve.group(groupName),
        role: v.rolelevel ?? null,
        roleKnown: v.rolelevel === undefined || resolve.roleKnown(v.rolelevel),
      };
      await worklogs.write(record.id, record);
    }
    counts.time_entry = await worklogs.close();

    const webLinks = new RecordFile(join(this.dir, 'web_link.ndjson'));
    for await (const row of this.raw.RemoteIssueLink.read()) {
      const v = row as Record<string, string>;
      const record: StagedWebLink = {
        id: v.id ?? '',
        issue: v.issueid ?? '',
        url: v.url ?? '',
        title: v.title ?? '',
        summary: v.summary ?? null,
        globalId: v.globalid ?? null,
        iconUrl: v.iconurl ?? null,
        iconTitle: v.icontitle ?? null,
        relationship: v.relationship ?? null,
        applicationType: v.applicationtype ?? null,
        applicationName: v.applicationname ?? null,
      };
      await webLinks.write(record.id, record);
    }
    counts.web_link = await webLinks.close();

    const attachments = new RecordFile(join(this.dir, 'attachment.ndjson'));
    for await (const row of this.raw.FileAttachment.read()) {
      const v = row as Record<string, string>;
      const id = v.id ?? '';
      const record: StagedAttachment = {
        id,
        issue: v.issue ?? '',
        issueKey: issueKeys.get(v.issue ?? '') ?? null,
        filename: v.filename ?? '',
        mimetype: v.mimetype ?? null,
        size: int(v.filesize),
        created: v.created ?? null,
        author: person(v.author),
        file: resolve.files.get(id) ?? null,
      };
      await attachments.write(id, record);
    }
    counts.attachment = await attachments.close();
    return counts;
  }
}

function listOf<T>(map: Map<string, T[]>, key: string): T[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

/** An item with its people resolved, a custom field named by id, a project by its key. */
function changeItem(
  item: StagedChangeItem,
  resolve: IssueResolve,
  fieldByName: ReadonlyMap<string, string>,
): StagedChangeItem {
  if (item.fieldtype === 'custom') {
    return { ...item, customField: fieldByName.get(item.field.toLowerCase()) ?? null };
  }
  const field = item.field.toLowerCase();
  if (field === 'assignee' || field === 'reporter') {
    return {
      ...item,
      oldvalue: item.oldvalue ? resolve.person(item.oldvalue) : null,
      newvalue: item.newvalue ? resolve.person(item.newvalue) : null,
    };
  }
  if (field === MOVE_FIELDS.project) {
    return {
      ...item,
      oldDisplay: item.oldvalue ? (resolve.projects.get(item.oldvalue)?.key ?? null) : null,
      newDisplay: item.newvalue ? (resolve.projects.get(item.newvalue)?.key ?? null) : null,
    };
  }
  return item;
}

/** An issue's custom values by field, people and groups by staged id (M1-089). */
function valuesOf(
  rows: readonly ValueRow[],
  labels: readonly LabelRow[],
  resolve: IssueResolve,
): StagedValue[] {
  const byField = new Map<string, StagedValue>();
  const of = (field: string) => {
    let value = byField.get(field);
    if (!value) {
      value = { field, type: resolve.fields.get(field)?.typeKey ?? null, rows: [] };
      byField.set(field, value);
    }
    return value;
  };
  for (const [, , field, parentKey, string, number, text, date] of rows) {
    const value = of(field);
    let s = string;
    if (s !== null && value.type !== null && PERSON_FIELD_TYPES.has(value.type)) {
      s = resolve.person(s);
    } else if (s !== null && value.type !== null && GROUP_FIELD_TYPES.has(value.type)) {
      s = resolve.group(s) ?? s;
    }
    value.rows.push({ parentKey, string: s, number, text, date });
  }
  for (const [, , field, label] of labels) {
    if (field === null) continue;
    const value = of(field);
    value.labels = [...(value.labels ?? []), label];
  }
  return [...byField.values()].sort((a, b) => Number(a.field) - Number(b.field));
}

/** A staged kind's file of `{ id, label, data }` lines, waiting for the stream when it asks. */
class RecordFile {
  private readonly out;
  private readonly done: Promise<void>;
  private count = 0;

  constructor(path: string) {
    this.out = createWriteStream(path);
    this.done = new Promise<void>((ok, fail) => {
      this.out.on('finish', () => ok());
      this.out.on('error', fail);
    });
  }

  write(id: string, data: unknown): Promise<void> {
    return this.writeLine({ id, label: '', data });
  }

  async writeLine(line: unknown): Promise<void> {
    this.count++;
    if (!this.out.write(`${JSON.stringify(line)}\n`)) {
      await new Promise<void>((ok) => this.out.once('drain', () => ok()));
    }
  }

  async close(): Promise<number> {
    this.out.end();
    await this.done;
    return this.count;
  }
}
