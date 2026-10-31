import { closeSync, createReadStream, createWriteStream, openSync, writeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { GROUP_FIELD_TYPES, PERSON_FIELD_TYPES } from './format';
import type { StagedField } from './stage-fields';

/**
 * The issue part of the stage (M1-089; IMP-001, IMP-004; ADR-089): each issue's own row with
 * its custom values, labels and parent, written as one ticket record. Issue rows go to a raw
 * file while the backup is read (memory stays flat however many there are); custom values,
 * labels and sub-task links are kept per issue until the end of the file, since they come
 * before or after their issues in no order the format promises, and the tickets are then
 * written from the raw file: issues without a parent first, then sub-tasks, so a parent is
 * always loaded before its children. History, comments, time, links between issues and
 * attachments stay with M1-091.
 *
 * Memory: the custom values and labels of every issue (tens of bytes each) are held until the
 * end. M1-091's million-issue run decides whether that needs a sort on disk instead.
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
}

/** Elements this part reads (`Label` and `IssueLink` in part: see `partial`). */
export const ISSUE_ELEMENTS = ['Issue', 'CustomFieldValue', 'Label', 'IssueLink'] as const;

const RAW = 'issues.raw.ndjson';
const FLUSH = 1 << 20;

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type ValueTuple = [
  field: string,
  parentKey: string | null,
  string | null,
  number | null,
  string | null,
  string | null,
];

export class IssueCollector {
  private readonly fd: number;
  private buffer = '';
  private issues = 0;
  private readonly values = new Map<string, ValueTuple[]>();
  private readonly labels = new Map<string, [field: string | null, label: string][]>();
  private readonly links: [type: string, source: string, destination: string][] = [];

  private open = true;

  constructor(private readonly dir: string) {
    this.fd = openSync(`${dir}/${RAW}`, 'w');
  }

  /** Closes the raw file (a stage that failed); the stage's folder is removed with it. */
  dispose(): void {
    if (this.open) closeSync(this.fd);
    this.open = false;
  }

  row(name: string, v: Record<string, string>): void {
    switch (name) {
      case 'Issue': {
        this.issues++;
        this.buffer += `${JSON.stringify(v)}\n`;
        if (this.buffer.length >= FLUSH) this.flush();
        return;
      }
      case 'CustomFieldValue': {
        const issue = v.issue ?? '';
        const list = this.values.get(issue) ?? [];
        this.values.set(issue, list);
        list.push([
          v.customfield ?? '',
          v.parentkey ?? null,
          v.stringvalue ?? null,
          num(v.numbervalue),
          v.textvalue ?? null,
          v.datevalue ?? null,
        ]);
        return;
      }
      case 'Label': {
        const issue = v.issue ?? '';
        const list = this.labels.get(issue) ?? [];
        this.labels.set(issue, list);
        list.push([v.fieldid ?? null, v.label ?? '']);
        return;
      }
      case 'IssueLink':
        this.links.push([v.linktype ?? '', v.source ?? '', v.destination ?? '']);
        return;
    }
  }

  private flush(): void {
    if (this.buffer.length > 0) writeSync(this.fd, this.buffer);
    this.buffer = '';
  }

  /** Raw people named by custom values of person fields, for the people the stage keeps. */
  personValues(fields: ReadonlyMap<string, StagedField>): string[] {
    const out: string[] = [];
    for (const list of this.values.values()) {
      for (const [field, , string] of list) {
        const type = fields.get(field)?.typeKey;
        if (string && type && PERSON_FIELD_TYPES.has(type)) out.push(string);
      }
    }
    return out;
  }

  /**
   * Writes the ticket records to `path` and removes the raw file. Returns the number written
   * and the link rows left for M1-091 (every link but a sub-task's to its parent).
   */
  async writeTickets(
    path: string,
    resolve: {
      person: (raw: string) => string;
      group: (raw: string) => string | null;
      fields: ReadonlyMap<string, StagedField>;
      subtaskLinkTypes: ReadonlySet<string>;
    },
  ): Promise<{ count: number; otherLinks: number }> {
    this.flush();
    this.dispose();
    const parents = new Map<string, string>();
    let otherLinks = 0;
    for (const [type, source, destination] of this.links) {
      if (resolve.subtaskLinkTypes.has(type) && !parents.has(destination)) {
        parents.set(destination, source);
      } else otherLinks++;
    }
    const raw = `${this.dir}/${RAW}`;
    const out = createWriteStream(path);
    const done = new Promise<void>((ok, fail) => {
      out.on('finish', () => ok());
      out.on('error', fail);
    });
    let count = 0;
    const person = (v: string | undefined) => (v ? resolve.person(v) : null);
    for (const children of [false, true]) {
      const lines = createInterface({
        input: createReadStream(raw),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of lines) {
        if (line === '') continue;
        const v = JSON.parse(line) as Record<string, string>;
        const id = v.id ?? '';
        const parent = parents.get(id) ?? null;
        if ((parent !== null) !== children) continue;
        const record: StagedIssue = {
          id,
          project: v.project ?? '',
          number: int(v.number),
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
          values: this.valuesOf(id, resolve),
        };
        for (const [field, label] of this.labels.get(id) ?? []) {
          if (field === null) record.labels.push(label);
        }
        if (!out.write(`${JSON.stringify({ id, label: '', data: record })}\n`)) {
          await new Promise<void>((ok) => out.once('drain', () => ok()));
        }
        count++;
      }
    }
    out.end();
    await done;
    await rm(raw, { force: true });
    return { count, otherLinks };
  }

  private valuesOf(
    issue: string,
    resolve: {
      person: (raw: string) => string;
      group: (raw: string) => string | null;
      fields: ReadonlyMap<string, StagedField>;
    },
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
    for (const [field, parentKey, string, number, text, date] of this.values.get(issue) ?? []) {
      const value = of(field);
      let s = string;
      if (s !== null && value.type !== null && PERSON_FIELD_TYPES.has(value.type)) {
        s = resolve.person(s);
      } else if (s !== null && value.type !== null && GROUP_FIELD_TYPES.has(value.type)) {
        s = resolve.group(s) ?? s;
      }
      value.rows.push({ parentKey, string: s, number, text, date });
    }
    for (const [field, label] of this.labels.get(issue) ?? []) {
      if (field === null) continue;
      const value = of(field);
      value.labels = [...(value.labels ?? []), label];
    }
    return [...byField.values()].sort((a, b) => Number(a.field) - Number(b.field));
  }

  get issueCount(): number {
    return this.issues;
  }
}
