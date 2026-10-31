import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { sniff } from '../../attachments/sniff';
import { queryType } from '../../search/catalogue';
import { targetShape } from '../dc-fields';
import type { CleanStats } from './clean';
import {
  ACTIVE_OBJECTS_FILE,
  ATTACHMENTS_DIR,
  ENTITIES,
  ENTITIES_FILE,
  type EntitySpec,
  PROJECT_SCHEME,
} from './format';
import { parseXml, type XmlHandlers } from './parse';
import { readLines as readLinesOf } from './spill';
import { FIELD_ELEMENTS, FieldCollector } from './stage-fields';
import { FILTER_ELEMENTS, FilterCollector } from './stage-filters';
import { CONTENT_KINDS, ISSUE_ELEMENTS, IssueCollector, type StagedFile } from './stage-issues';
import { SCHEME_ELEMENTS, SchemeCollector } from './stage-schemes';
import { WORKFLOW_ELEMENTS, WorkflowCollector } from './stage-workflows';

/**
 * Stages a Data Center backup ZIP for import (M1-088; IMP-001, IMP-004; ADR-081): one streaming
 * pass over the ZIP reads `entities.xml` and `activeobjects.xml` through the byte cleaner and
 * saxes (ADR-025), keeps the small configuration tables (people, groups, roles, projects, types,
 * statuses, priorities, resolutions) in memory, and counts every other element, table and file.
 * Once the whole file is read it resolves the references between those tables (rows come in no
 * order the format promises) and writes one file of records per kind the importer maps, as JSON
 * lines, next to the ZIP. The import then reads those files a page at a time by byte offset,
 * so it resumes in the middle of a kind without reading the backup again.
 *
 * This is the format layer: records keep the backup's own vocabulary (project, issue type,
 * resolution); the mapper (`../dc.ts`) turns them into Taskmoor's. Memory grows with the
 * configuration only, never with issues, comments or history.
 */
export const STAGE_FORMAT = 'taskmoor-dc-stage';
export const STAGE_VERSION = 5;
export const STAGED = '.staged';
const SUMMARY = 'stage.json';

export class DcBackupError extends Error {}

/** The kinds the stage writes, in the importer's terms, each with the element it comes from. */
export const STAGED_KINDS = {
  user: 'User',
  group: 'Group',
  role: 'ProjectRole',
  status: 'Status',
  priority: 'Priority',
  close_reason: 'Resolution',
  ticket_type: 'IssueType',
  track: 'Project',
  field: 'CustomField',
  field_context: 'FieldConfigScheme',
  field_option: 'CustomFieldOption',
  field_rule_set: 'FieldLayoutScheme',
  layout_set: 'IssueTypeScreenScheme',
  access_policy: 'PermissionScheme',
  visibility_policy: 'IssueSecurityScheme',
  visibility_level: 'SchemeIssueSecurityLevels',
  notification_policy: 'NotificationScheme',
  global_grant: 'GlobalPermissionEntry',
  workflow: 'Workflow',
  workflow_map: 'WorkflowScheme',
  ticket: 'Issue',
  ...CONTENT_KINDS,
  // Saved filters, their subscriptions and dashboards (M1-094).
  saved_search: 'SearchRequest',
  subscription: 'FilterSubscription',
  dashboard: 'PortalPage',
} as const;

/** The schemes a project's `NodeAssociation` rows may name that the mapping reads. */
const READ_SCHEMES = new Set([
  'FieldLayoutScheme',
  'IssueTypeScreenScheme',
  'PermissionScheme',
  'IssueSecurityScheme',
  'NotificationScheme',
  'WorkflowScheme',
]);
export type StagedKind = keyof typeof STAGED_KINDS;

/**
 * Elements read into the staged kinds: the kinds' own and the ones folded into them (user keys,
 * directories, memberships, role actors, the parts of contexts, field configurations and
 * screens, the projects' scheme associations, issues' custom values, labels and sub-task
 * links). Every other element is counted and reported as not imported, with its reason; rows
 * of a consumed element that the mapping leaves out are counted in `partial`.
 */
export const CONSUMED = new Set<string>([
  ...Object.values(STAGED_KINDS),
  'ApplicationUser',
  'Directory',
  'Membership',
  'ProjectRoleActor',
  'IssueLinkType',
  'NodeAssociation',
  ...FIELD_ELEMENTS,
  ...ISSUE_ELEMENTS,
  ...SCHEME_ELEMENTS,
  ...WORKFLOW_ELEMENTS,
  ...FILTER_ELEMENTS,
]);

/** Elements only tickets consume: a configuration-only import leaves them out (M1-089). */
export const CONTENT_ELEMENTS: ReadonlySet<string> = new Set(ISSUE_ELEMENTS);

/** Elements of a ticket's content, which an import of tickets only leaves out (M1-091). */
export const TICKET_CONTENT_ELEMENTS: ReadonlySet<string> = new Set([
  'ChangeGroup',
  'ChangeItem',
  'Action',
  'Worklog',
  'FileAttachment',
  'RemoteIssueLink',
  'IssueLink',
]);

/** Kinds of issue content: a configuration-only import leaves them out. */
export const CONTENT_STAGED_KINDS: ReadonlySet<string> = new Set([
  'ticket',
  ...Object.keys(CONTENT_KINDS),
]);

/** Elements the importer has no use for: ids are Taskmoor's own. */
export const NOT_NEEDED = new Set<string>([
  'SequenceValueItem',
  // Each issue's workflow state: its status is the truth (M1-090; Verify).
  'OSWorkflowEntry',
  'OSCurrentStep',
  'OSHistoryStep',
]);

export interface StagedUser {
  key: string;
  userName: string | null;
  displayName: string | null;
  email: string | null;
  active: boolean;
  /** Deleted people are named by other rows but have no user row of their own. */
  deleted: boolean;
  /** Named by any other row (issues, comments, history, roles ...). */
  referenced: boolean;
}

export interface StagedGroup {
  name: string;
  description: string;
  /** Users by staged id (lower-case user key). */
  members: string[];
  /** Members whose user row is missing, by user name (at most 20). */
  unknownMembers: string[];
  /** Groups inside this one, by name (Taskmoor's nested groups come later). */
  nested: string[];
}

export interface StagedNamed {
  id: string;
  name: string;
  description: string;
  sequence: number | null;
}

export interface StagedStatus extends StagedNamed {
  category: string | null;
  /** A step of some workflow in the backup names it (M1-090). */
  inWorkflow?: true;
}

export interface StagedIssueType extends StagedNamed {
  style: string | null;
}

export interface StagedActor {
  role: string;
  roleKnown: boolean;
  type: string;
  parameter: string;
  /** The person (staged id) or the group (staged id), as the type says; null when unknown. */
  user: string | null;
  group: string | null;
}

export interface StagedProject {
  id: string;
  key: string;
  originalKey: string | null;
  name: string;
  description: string;
  lead: string | null;
  counter: number | null;
  type: string | null;
  actors: StagedActor[];
}

/** What a stage read: kept as `stage.json` beside the record files. */
export interface StageSummary {
  format: typeof STAGE_FORMAT;
  version: typeof STAGE_VERSION;
  /** The ZIP the stage was made from, so a changed file is staged again. */
  zip: { bytes: number; mtimeMs: number };
  /** Rows per element of the entities file. */
  entities: Record<string, number>;
  /** Rows per table of the active-objects file. */
  activeObjects: Record<string, number>;
  /** Other entries of the ZIP, by folder: avatars, logos, attachments no row names. */
  files: Record<string, number>;
  /** Attachment files an attachment row names (M1-091). */
  attachmentFiles: number;
  /** Records per staged kind. */
  kinds: Record<string, number>;
  /** Rows of consumed elements that no staged kind carries (links between issues, say). */
  partial: Record<string, number>;
  /** Characters XML forbids that the cleaner removed, with the first places of each kind. */
  removed: Record<keyof CleanStats['offsets'], { count: number; examples: string[] }>;
}

/** Reads the ZIP's central directory and streams its entries in order. */
async function openZip(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, file) =>
      error || !file ? fail(error ?? new Error('zip')) : ok(file),
    ),
  );
  const open = (entry: yauzl.Entry) =>
    new Promise<Readable>((ok, fail) =>
      zip.openReadStream(entry, (error, stream) =>
        error || !stream ? fail(error ?? new Error('zip entry')) : ok(stream),
      ),
    );
  return { zip, open };
}

/** The folder a ZIP entry counts under: `data/attachments`, `data/avatars`, `logos` ... */
function folderOf(name: string): string {
  if (name.startsWith(`${ATTACHMENTS_DIR}/`)) return ATTACHMENTS_DIR;
  const parts = name.split('/');
  if (parts.length === 1) return name;
  return parts[0] === 'data' && parts.length > 2 ? `data/${parts[1]}` : (parts[0] as string);
}

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const flag = (v: string | undefined) => v === '1' || v === 'true';

/** Person attributes outside the format's own list of user columns (`format.ts`). */
const PERSON_CHANGE_FIELDS = new Set(['assignee', 'reporter']);

/** The configuration a stage keeps while it reads, and the counts of everything else. */
class Collector {
  readonly entities: Record<string, number> = {};
  readonly activeObjects: Record<string, number> = {};
  readonly fileCounts: Record<string, number> = {};
  readonly directories = new Map<string, { position: number; active: boolean }>();
  readonly users: {
    row: number;
    directory: string;
    lowerName: string;
    userName: string;
    displayName: string | null;
    email: string | null;
    active: boolean;
  }[] = [];
  /** User key (lower case) to its lower-case user name. */
  readonly appUsers = new Map<string, { key: string; lowerName: string }>();
  readonly groups: {
    row: number;
    directory: string;
    lowerName: string;
    name: string;
    description: string;
  }[] = [];
  readonly memberships: { group: string; child: string; type: string; directory: string }[] = [];
  readonly roles = new Map<string, StagedNamed>();
  readonly actors: { project: string; role: string; type: string; parameter: string }[] = [];
  readonly projects: Omit<StagedProject, 'actors' | 'lead'>[] = [];
  readonly leads = new Map<string, string>();
  readonly issueTypes: StagedIssueType[] = [];
  readonly statuses: StagedStatus[] = [];
  readonly priorities: StagedNamed[] = [];
  readonly resolutions: StagedNamed[] = [];
  /** Every person reference as written, lower case. */
  readonly personRefs = new Set<string>();
  readonly fieldPart = new FieldCollector();
  readonly schemePart = new SchemeCollector();
  readonly workflowPart = new WorkflowCollector();
  readonly filterPart = new FilterCollector();
  readonly issuePart: IssueCollector;
  /** Link types by id (sub-task links make parents). */
  readonly linkTypes = new Map<
    string,
    { name: string; outward: string; inward: string; style: string }
  >();
  /** Attachment files of the ZIP by attachment id (M1-091). */
  readonly files = new Map<string, StagedFile>();
  /** Scheme element to scheme id to the projects naming it (`NodeAssociation`). */
  readonly associations = new Map<string, Map<string, string[]>>();
  /** Rows of consumed elements left out, by element. */
  readonly partial: Record<string, number> = {};

  constructor(dir: string) {
    this.issuePart = new IssueCollector(dir);
  }

  private leaveOut(name: string): void {
    this.partial[name] = (this.partial[name] ?? 0) + 1;
  }

  row(name: string, v: Record<string, string>): void {
    this.entities[name] = (this.entities[name] ?? 0) + 1;
    const spec = (ENTITIES as Record<string, EntitySpec>)[name];
    if (spec) {
      for (const [attr, def] of Object.entries(spec.attrs)) {
        const value = v[attr];
        if (def.type === 'user' && value) this.personRefs.add(value.toLowerCase());
      }
    }
    const id = v.id ?? '';
    const named = (): StagedNamed => ({
      id,
      name: v.name ?? '',
      description: v.description ?? '',
      sequence: int(v.sequence),
    });
    if ((FIELD_ELEMENTS as readonly string[]).includes(name)) {
      this.fieldPart.row(name, v);
      return;
    }
    if (name === 'ChangeItem') {
      // History names people by key in its values.
      if (v.fieldtype === 'jira' && PERSON_CHANGE_FIELDS.has(v.field ?? '')) {
        if (v.oldvalue) this.personRefs.add(v.oldvalue.toLowerCase());
        if (v.newvalue) this.personRefs.add(v.newvalue.toLowerCase());
      }
    }
    if ((ISSUE_ELEMENTS as readonly string[]).includes(name)) {
      this.issuePart.row(name, v);
      return;
    }
    if ((SCHEME_ELEMENTS as readonly string[]).includes(name)) {
      this.schemePart.row(name, v);
      return;
    }
    if ((WORKFLOW_ELEMENTS as readonly string[]).includes(name)) {
      this.workflowPart.row(name, v);
      return;
    }
    if (name === 'SearchRequest' || (FILTER_ELEMENTS as readonly string[]).includes(name)) {
      this.filterPart.row(name, v);
      return;
    }
    switch (name) {
      case 'IssueLinkType':
        this.linkTypes.set(id, {
          name: v.linkname ?? '',
          outward: v.outward ?? '',
          inward: v.inward ?? '',
          style: v.style ?? '',
        });
        return;
      case 'NodeAssociation': {
        // A project tied to one of its schemes; other associations are not read yet.
        if (
          v.sourceNodeEntity !== 'Project' ||
          v.associationType !== PROJECT_SCHEME ||
          !READ_SCHEMES.has(v.sinkNodeEntity ?? '')
        ) {
          this.leaveOut(name);
          return;
        }
        const entity = v.sinkNodeEntity ?? '';
        const byScheme = this.associations.get(entity) ?? new Map<string, string[]>();
        this.associations.set(entity, byScheme);
        const projects = byScheme.get(v.sinkNodeId ?? '') ?? [];
        byScheme.set(v.sinkNodeId ?? '', projects);
        projects.push(v.sourceNodeId ?? '');
        return;
      }
      case 'Directory':
        this.directories.set(id, {
          position: int(v.directoryPosition) ?? Number.MAX_SAFE_INTEGER,
          active: v.active === undefined || flag(v.active),
        });
        return;
      case 'User':
        this.users.push({
          row: int(id) ?? 0,
          directory: v.directoryId ?? '',
          lowerName: (v.lowerUserName ?? v.userName ?? '').toLowerCase(),
          userName: v.userName ?? v.lowerUserName ?? '',
          displayName: v.displayName ?? null,
          email: v.emailAddress ? v.emailAddress : null,
          active: v.active === undefined || flag(v.active),
        });
        return;
      case 'ApplicationUser':
        if (v.userKey) {
          this.appUsers.set(v.userKey.toLowerCase(), {
            key: v.userKey,
            lowerName: (v.lowerUserName ?? v.userKey).toLowerCase(),
          });
        }
        return;
      case 'Group':
        this.groups.push({
          row: int(id) ?? 0,
          directory: v.directoryId ?? '',
          lowerName: (v.lowerGroupName ?? v.groupName ?? '').toLowerCase(),
          name: v.groupName ?? v.lowerGroupName ?? '',
          description: v.description ?? '',
        });
        return;
      case 'Membership':
        this.memberships.push({
          group: (v.lowerParentName ?? v.parentName ?? '').toLowerCase(),
          child: (v.lowerChildName ?? v.childName ?? '').toLowerCase(),
          type: v.membershipType ?? '',
          directory: v.directoryId ?? '',
        });
        return;
      case 'ProjectRole':
        this.roles.set(id, named());
        return;
      case 'ProjectRoleActor':
        this.actors.push({
          project: v.pid ?? '',
          role: v.projectroleid ?? '',
          type: v.roletype ?? '',
          parameter: v.roletypeparameter ?? '',
        });
        if (v.roletype === 'atlassian-user-role-actor' && v.roletypeparameter) {
          this.personRefs.add(v.roletypeparameter.toLowerCase());
        }
        return;
      case 'Project':
        this.projects.push({
          id,
          key: v.key ?? '',
          originalKey: v.originalkey ?? null,
          name: v.name ?? '',
          description: v.description ?? '',
          counter: int(v.counter),
          type: v.projecttype ?? null,
        });
        if (v.lead) this.leads.set(id, v.lead);
        return;
      case 'IssueType':
        this.issueTypes.push({ ...named(), style: v.style ?? null });
        return;
      case 'Status':
        this.statuses.push({ ...named(), category: v.statuscategory ?? null });
        return;
      case 'Priority':
        this.priorities.push(named());
        return;
      case 'Resolution':
        this.resolutions.push(named());
        return;
    }
  }

  /** Directory rank: active before inactive, then by position (lowest wins), then row id. */
  private rank(directory: string): [number, number] {
    const d = this.directories.get(directory);
    return d ? [d.active ? 0 : 1, d.position] : [1, Number.MAX_SAFE_INTEGER];
  }

  private winners<T extends { row: number; directory: string; lowerName: string }>(
    rows: readonly T[],
  ): Map<string, T> {
    const out = new Map<string, T>();
    for (const r of rows) {
      const best = out.get(r.lowerName);
      if (!best) {
        out.set(r.lowerName, r);
        continue;
      }
      const [a1, a2] = this.rank(r.directory);
      const [b1, b2] = this.rank(best.directory);
      if (a1 < b1 || (a1 === b1 && (a2 < b2 || (a2 === b2 && r.row < best.row)))) {
        out.set(r.lowerName, r);
      }
    }
    return out;
  }

  /** The staged records of every configuration kind, with references resolved. */
  resolve(): {
    records: {
      [K in Exclude<StagedKind, 'ticket' | keyof typeof CONTENT_KINDS>]: {
        id: string;
        label: string;
        data: unknown;
      }[];
    };
    person: (raw: string) => string;
    group: (raw: string) => string | null;
  } {
    // People named by grants, levels and notifications (M1-092).
    for (const raw of this.schemePart.personRefs) this.personRefs.add(raw.toLowerCase());
    const userRows = this.winners(this.users);
    // People by staged id (the lower-case user key); user names point at the key.
    const people = new Map<string, StagedUser>();
    const byName = new Map<string, string>();
    for (const [lowerKey, app] of this.appUsers) {
      byName.set(app.lowerName, lowerKey);
      const row = userRows.get(app.lowerName);
      people.set(lowerKey, {
        key: app.key,
        userName: row?.userName ?? app.lowerName,
        displayName: row?.displayName ?? null,
        email: row?.email ?? null,
        active: row?.active ?? false,
        deleted: row === undefined,
        referenced: false,
      });
    }
    // A user row without a key row is keyed by its user name, as older people are.
    for (const [lowerName, row] of userRows) {
      if (byName.has(lowerName)) continue;
      byName.set(lowerName, lowerName);
      people.set(lowerName, {
        key: lowerName,
        userName: row.userName,
        displayName: row.displayName,
        email: row.email,
        active: row.active,
        deleted: false,
        referenced: false,
      });
    }
    /** A person named by key or, leniently, by user name; unknown ones are deleted people. */
    const person = (raw: string): string => {
      const lower = raw.toLowerCase();
      if (people.has(lower)) return lower;
      return byName.get(lower) ?? lower;
    };
    for (const raw of this.personRefs) {
      const id = person(raw);
      const known = people.get(id);
      if (known) known.referenced = true;
      else {
        people.set(id, {
          key: raw,
          userName: null,
          displayName: null,
          email: null,
          active: false,
          deleted: true,
          referenced: true,
        });
      }
    }

    const groupRows = this.winners(this.groups);
    const groups = new Map<string, StagedGroup>();
    for (const [lowerName, g] of groupRows) {
      groups.set(lowerName, {
        name: g.name,
        description: g.description,
        members: [],
        unknownMembers: [],
        nested: [],
      });
    }
    const seen = new Set<string>();
    for (const m of this.memberships) {
      const group = groups.get(m.group);
      if (!group) continue;
      if (m.type === 'GROUP_GROUP') {
        if (!group.nested.includes(m.child)) group.nested.push(m.child);
        continue;
      }
      const id = byName.get(m.child);
      const user = id === undefined ? undefined : people.get(id);
      if (id === undefined || !user || user.deleted) {
        if (group.unknownMembers.length < 20 && !group.unknownMembers.includes(m.child)) {
          group.unknownMembers.push(m.child);
        }
        continue;
      }
      const key = `${m.group}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      group.members.push(id);
    }

    const actors = new Map<string, StagedActor[]>();
    for (const a of this.actors) {
      const list = actors.get(a.project) ?? [];
      actors.set(a.project, list);
      const isUser = a.type === 'atlassian-user-role-actor';
      const isGroup = a.type === 'atlassian-group-role-actor';
      const groupId = a.parameter.toLowerCase();
      list.push({
        role: a.role,
        roleKnown: this.roles.has(a.role),
        type: a.type,
        parameter: a.parameter,
        user: isUser ? person(a.parameter) : null,
        group: isGroup && groups.has(groupId) ? groupId : null,
      });
    }

    const bySequence = <T extends StagedNamed>(rows: T[]) =>
      [...rows].sort(
        (a, b) =>
          (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
          Number(a.id) - Number(b.id),
      );
    const byId = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
    const named = <T extends StagedNamed>(rows: T[]) =>
      bySequence(rows).map((r) => ({ id: r.id, label: r.name, data: r }));

    const projectIds = new Set(this.projects.map((p) => p.id));
    const schemeRecords = this.schemePart.resolve(projectIds, this.associations, {
      person,
      group: (raw) => {
        const id = raw.toLowerCase();
        return groups.has(id) ? id : null;
      },
      role: (id) => this.roles.has(id),
    });
    const fieldRecords = this.fieldPart.resolve(
      new Set(this.projects.map((p) => p.id)),
      new Set(this.issueTypes.map((t) => t.id)),
      this.associations,
    );
    // Workflows and their schemes (M1-090); notifications name custom events by theirs.
    const workflowRecords = this.workflowPart.resolve(projectIds, this.associations, {
      statuses: new Set(this.statuses.map((s) => s.id)),
      types: new Set(this.issueTypes.map((t) => t.id)),
      roles: new Set(this.roles.keys()),
      group: (raw) => {
        const id = raw.toLowerCase();
        return groups.has(id) ? id : null;
      },
      screen: (id) => this.fieldPart.screen(id),
    });
    const events = this.workflowPart.eventNames();
    for (const { data } of schemeRecords.notification_policy) {
      for (const n of data.notifications) {
        const name = n.event === null ? undefined : events.get(n.event);
        if (name !== undefined) n.eventName = name;
      }
    }
    const inWorkflow = this.workflowPart.statusesInWorkflows();
    // Saved filters, dashboards and subscriptions (M1-094), queries analysed for translation.
    const filterRecords = this.filterPart.resolve({
      fields: this.fieldPart.fields,
      fieldType: (typeKey) => {
        const shape = targetShape(typeKey);
        return shape ? queryType(shape) : null;
      },
      person: (raw) => {
        const id = person(raw);
        return people.has(id) ? id : undefined;
      },
      group: (raw) => {
        const id = raw.toLowerCase();
        return groups.has(id) ? id : null;
      },
      projects: this.projects,
      role: (id) => this.roles.has(id),
    });
    const otherJobs = this.filterPart.otherJobs();
    if (otherJobs > 0) this.partial.ClusteredJob = otherJobs;
    const records = {
      user: [...people.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, u]) => ({
          id,
          label: u.deleted
            ? (u.userName ?? u.key)
            : `${u.displayName ?? u.userName ?? u.key}${u.email ? ` <${u.email}>` : ''}`,
          data: u,
        })),
      group: [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, g]) => ({ id, label: g.name, data: g })),
      role: named(byId([...this.roles.values()])),
      status: named(
        this.statuses.map((x) => (inWorkflow.has(x.id) ? { ...x, inWorkflow: true } : x)),
      ),
      priority: named(this.priorities),
      close_reason: named(this.resolutions),
      ticket_type: named(this.issueTypes),
      track: byId(this.projects).map((p) => {
        const lead = this.leads.get(p.id);
        const data: StagedProject = {
          ...p,
          lead: lead === undefined ? null : person(lead),
          actors: actors.get(p.id) ?? [],
        };
        return { id: p.id, label: `${p.key}: ${p.name}`, data };
      }),
      ...fieldRecords,
      ...schemeRecords,
      ...workflowRecords,
      ...filterRecords,
    };
    return {
      records,
      person,
      group: (raw: string) => {
        const id = raw.toLowerCase();
        return groups.has(id) ? id : null;
      },
    };
  }
}

function entitiesHandlers(collector: Collector): XmlHandlers & { rootSeen: () => boolean } {
  let rootSeen = false;
  let row: { name: string; values: Record<string, string> } | null = null;
  let child: string | null = null;
  let text = '';
  return {
    rootSeen: () => rootSeen,
    open(tag, depth) {
      if (depth === 1) rootSeen = true;
      else if (depth === 2) row = { name: tag.name, values: { ...tag.attributes } };
      else if (depth === 3 && row) {
        child = tag.name;
        text = '';
      }
    },
    text(t, depth) {
      if (depth === 3 && child) text += t;
    },
    close(_name, depth) {
      if (depth === 3 && row && child) {
        // A text value written as a child element (CDATA, possibly split at `]]>`).
        row.values[child] ??= text;
        child = null;
      } else if (depth === 2 && row) {
        collector.row(row.name, row.values);
        row = null;
      }
    },
  };
}

function aoHandlers(collector: Collector): XmlHandlers {
  let table: string | null = null;
  return {
    open(tag, depth) {
      if (depth === 2) table = tag.name === 'data' ? (tag.attributes.tableName ?? null) : null;
      else if (depth === 3 && table && tag.name === 'row') {
        collector.activeObjects[table] = (collector.activeObjects[table] ?? 0) + 1;
      }
    },
    text() {},
    close(_name, depth) {
      if (depth === 2) table = null;
    },
  };
}

/** Writes records as JSON lines, waiting for the stream when it asks to. */
async function writeLines(path: string, records: readonly unknown[]): Promise<void> {
  const out = createWriteStream(path);
  const done = new Promise<void>((ok, fail) => {
    out.on('finish', () => ok());
    out.on('error', fail);
  });
  for (const r of records) {
    if (!out.write(`${JSON.stringify(r)}\n`)) {
      await new Promise<void>((ok) => out.once('drain', () => ok()));
    }
  }
  out.end();
  await done;
}

/** Reads a backup ZIP and writes its staged records into `dir` (made fresh). */
async function stageInto(zipPath: string, dir: string, zipInfo: StageSummary['zip']) {
  const collector = new Collector(dir);
  await collector.issuePart.open();
  try {
    return await stageWith(collector, zipPath, dir, zipInfo);
  } finally {
    await collector.issuePart.dispose();
  }
}

/** The bytes an attachment file holds: its hash and sniffed type, read once while staging. */
async function readAttachment(
  stream: Readable,
): Promise<{ size: number; sha256: string; sniffed: string | null }> {
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    hash.update(b);
    size += b.length;
    if (head.length < 4096) head = Buffer.concat([head, b.subarray(0, 4096 - head.length)]);
  }
  return { size, sha256: hash.digest('hex'), sniffed: sniff(head, size <= head.length) };
}

/** `<...>/<issue key>/<attachment id>`, with or without the bucket folder (format notes 5). */
const ATTACHMENT_FILE = /^data\/attachments\/(?:[^/]+\/)+?([^/]+)\/(\d+)$/;

async function stageWith(
  collector: Collector,
  zipPath: string,
  dir: string,
  zipInfo: StageSummary['zip'],
) {
  const removed: StageSummary['removed'] = {
    nul: { count: 0, examples: [] },
    control: { count: 0, examples: [] },
    noncharacter: { count: 0, examples: [] },
    charRef: { count: 0, examples: [] },
  };
  const addRemoved = (file: string, stats: CleanStats) => {
    for (const kind of Object.keys(removed) as (keyof typeof removed)[]) {
      removed[kind].count += stats[kind];
      for (const at of stats.offsets[kind]) {
        if (removed[kind].examples.length < 5) removed[kind].examples.push(`${file}@${at}`);
      }
    }
  };
  let sawEntities = false;
  let entitiesRoot = true;
  const { zip, open } = await openZip(zipPath);
  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      const next = async () => {
        const name = entry.fileName;
        if (name.endsWith('/')) return;
        if (name === ENTITIES_FILE) {
          sawEntities = true;
          const handlers = entitiesHandlers(collector);
          const { cleaned } = await parseXml(await open(entry), handlers);
          entitiesRoot = handlers.rootSeen();
          addRemoved(ENTITIES_FILE, cleaned);
        } else if (name === ACTIVE_OBJECTS_FILE) {
          const { cleaned } = await parseXml(await open(entry), aoHandlers(collector));
          addRemoved(ACTIVE_OBJECTS_FILE, cleaned);
        } else {
          const folder = folderOf(name);
          const file = ATTACHMENT_FILE.exec(name);
          if (folder === ATTACHMENTS_DIR && file && !collector.files.has(file[2] as string)) {
            // Read once for its hash and type; the import reads it again from its place.
            const read = await readAttachment(await open(entry));
            collector.files.set(file[2] as string, {
              locator: `zip:${entry.relativeOffsetOfLocalHeader}:${entry.compressedSize}:${entry.compressionMethod}:${read.size}`,
              size: read.size,
              sha256: read.sha256,
              sniffed: read.sniffed,
              folderKey: file[1] as string,
            });
            return;
          }
          collector.fileCounts[folder] = (collector.fileCounts[folder] ?? 0) + 1;
        }
      };
      next().then(
        () => zip.readEntry(),
        (error: unknown) => {
          zip.close();
          fail(error);
        },
      );
    });
    zip.readEntry();
  });
  if (!sawEntities) throw new DcBackupError(`no ${ENTITIES_FILE} at the root of the ZIP`);
  if (!entitiesRoot) throw new DcBackupError(`${ENTITIES_FILE} has no root element`);

  // People named by custom values count as named (M1-089).
  for (const raw of await collector.issuePart.personValues(collector.fieldPart.fields)) {
    collector.personRefs.add(raw.toLowerCase());
  }
  const { records, person, group } = collector.resolve();
  const kinds: Record<string, number> = {};
  for (const kind of Object.keys(records) as (keyof typeof records)[]) {
    kinds[kind] = records[kind].length;
    await writeLines(join(dir, `${kind}.ndjson`), records[kind]);
  }
  const projects = new Map(collector.projects.map((p) => [p.id, { key: p.key }]));
  const projectByKey = new Map<string, string>();
  for (const p of [...collector.projects].sort((a, b) => Number(a.id) - Number(b.id))) {
    for (const key of [p.key, p.originalKey]) {
      if (key && !projectByKey.has(key.toUpperCase())) projectByKey.set(key.toUpperCase(), p.id);
    }
  }
  const content = await collector.issuePart.writeAll({
    person,
    group,
    roleKnown: (id) => collector.roles.has(id),
    fields: collector.fieldPart.fields,
    linkTypes: collector.linkTypes,
    projects,
    projectByKey,
    files: collector.files,
  });
  Object.assign(kinds, content);
  Object.assign(collector.partial, collector.issuePart.partial);
  // Files no attachment row names are counted as not imported.
  const named = new Set<string>();
  for await (const line of readLinesOf(join(dir, 'attachment.ndjson'))) {
    const file = (line as { data: { id: string; file: unknown } }).data;
    if (file.file) named.add(file.id);
  }
  const unnamed = [...collector.files.keys()].filter((id) => !named.has(id)).length;
  if (unnamed > 0) collector.fileCounts[ATTACHMENTS_DIR] = unnamed;
  const attachmentFiles = named.size;
  const summary: StageSummary = {
    format: STAGE_FORMAT,
    version: STAGE_VERSION,
    zip: zipInfo,
    entities: sortedRecord(collector.entities),
    activeObjects: sortedRecord(collector.activeObjects),
    files: sortedRecord(collector.fileCounts),
    attachmentFiles,
    kinds,
    partial: sortedRecord(collector.partial),
    removed,
  };
  // Written last: a folder with a summary is complete.
  await writeFile(join(dir, SUMMARY), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function readSummary(dir: string): Promise<StageSummary | null> {
  try {
    const summary = JSON.parse(await readFile(join(dir, SUMMARY), 'utf8')) as StageSummary;
    return summary.format === STAGE_FORMAT && summary.version === STAGE_VERSION ? summary : null;
  } catch {
    return null;
  }
}

/** Only checks that the ZIP opens and holds the entities file at its root (for the route). */
export async function checkDcBackup(zipPath: string): Promise<void> {
  const { zip } = await openZip(zipPath).catch((error: unknown) => {
    throw new DcBackupError(`not a ZIP file: ${(error as Error).message}`);
  });
  const found = await new Promise<boolean>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done(false));
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName === ENTITIES_FILE) {
        zip.close();
        done(true);
      } else zip.readEntry();
    });
    zip.readEntry();
  });
  if (!found) throw new DcBackupError(`no ${ENTITIES_FILE} at the root of the ZIP`);
}

/**
 * The staged folder of a backup ZIP (`<zip>.staged`), staged now unless a stage of this exact
 * file (size and modification time) is there already. A stage is written into a folder of its
 * own and renamed into place, so a worker that stops halfway leaves nothing a later run reads.
 */
export async function stageDcBackup(
  zipPath: string,
): Promise<{ dir: string; summary: StageSummary }> {
  const info = await stat(zipPath);
  const zipInfo = { bytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
  const dir = `${zipPath}${STAGED}`;
  const ready = await readSummary(dir);
  if (ready && ready.zip.bytes === zipInfo.bytes && ready.zip.mtimeMs === zipInfo.mtimeMs) {
    return { dir, summary: ready };
  }
  const partial = `${dir}.part-${randomBytes(6).toString('hex')}`;
  await mkdir(partial, { recursive: true });
  try {
    const summary = await stageInto(zipPath, partial, zipInfo);
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(partial, dir);
    } catch (error) {
      // Another worker staged the same file meanwhile: use theirs.
      const theirs = await readSummary(dir);
      if (!theirs) throw error;
      await rm(partial, { recursive: true, force: true });
      return { dir, summary: theirs };
    }
    return { dir, summary };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}
