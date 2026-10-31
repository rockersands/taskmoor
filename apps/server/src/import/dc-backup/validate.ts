import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { XmlCleaner } from './clean';
import {
  ACTIVE_OBJECTS_FILE,
  AO_NAMESPACE,
  AO_ROOT,
  AO_TABLES,
  AO_VALUE_TYPES,
  type Attr,
  attachmentPath,
  ENTITIES,
  ENTITIES_FILE,
  ENTITIES_ROOT,
  type EntitySpec,
  parseAttachmentPath,
  TIMESTAMP,
} from './format';
import { type Manifest, manifestSchema } from './manifest';
import { parseXml, type XmlHandlers } from './parse';
import { AgileChecks } from './validate-agile';
import { WorkflowChecks } from './validate-workflows';
import type { Written } from './xml';

/**
 * Checks a backup ZIP against the documented structure (`format.ts`) and, when given, the
 * manifest the generator wrote (M1-087): the entries, every row's element and attributes,
 * ids, references (resolved after the whole file, since the order of rows is not part of the
 * format), issue numbers, attachment files against their rows, the active-objects tables and
 * rows, the counts per element and table, the cases the manifest lists and the characters XML
 * forbids. It streams; memory grows by a few bytes per issue and per attachment.
 */
export interface ValidationReport {
  ok: boolean;
  /** The first 200 problems; `problemCount` has them all. */
  problems: string[];
  problemCount: number;
  files: { entities: Written | null; activeObjects: Written | null };
  attachments: { files: number; bytes: number; sha256: string };
  entities: Record<string, number>;
  activeObjects: Record<string, number>;
  cases: Record<string, number>;
  forbidden: { nul: number; control: number; noncharacter: number; charRef: number };
}

const MAX_PROBLEMS = 200;

/** A set of non-negative integer ids as a growing bitmap. */
class IdSet {
  private bits = new Uint8Array(1 << 12);
  size = 0;
  max = -1;

  /** Adds an id; false when it was there already. */
  add(id: number): boolean {
    const byte = id >>> 3;
    if (byte >= this.bits.length) {
      let length = this.bits.length;
      while (length <= byte) length *= 2;
      const grown = new Uint8Array(length);
      grown.set(this.bits);
      this.bits = grown;
    }
    const mask = 1 << (id & 7);
    if ((this.bits[byte] as number) & mask) return false;
    this.bits[byte] = (this.bits[byte] as number) | mask;
    this.size++;
    if (id > this.max) this.max = id;
    return true;
  }

  has(id: number): boolean {
    const byte = id >>> 3;
    return byte < this.bits.length && ((this.bits[byte] as number) & (1 << (id & 7))) !== 0;
  }

  *values(): Generator<number> {
    for (let byte = 0; byte < this.bits.length; byte++) {
      const b = this.bits[byte] as number;
      if (b === 0) continue;
      for (let bit = 0; bit < 8; bit++) if (b & (1 << bit)) yield byte * 8 + bit;
    }
  }
}

/** Integers by id, in a growing typed array (0 means unset, so values are stored plus one). */
class IntById {
  private values = new Int32Array(1 << 12);

  set(id: number, value: number): void {
    if (id >= this.values.length) {
      let length = this.values.length;
      while (length <= id) length *= 2;
      const grown = new Int32Array(length);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[id] = value + 1;
  }

  get(id: number): number | undefined {
    const v = id < this.values.length ? (this.values[id] as number) : 0;
    return v === 0 ? undefined : v - 1;
  }
}

interface Row {
  name: string;
  attrs: Record<string, string>;
  children: Record<string, string>;
  /** CDATA sections per child, to count split sections. */
  sections: number;
  childCount: number;
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** Everything the entities pass keeps for the checks after it. */
class EntitiesState {
  readonly counts: Record<string, number> = {};
  readonly ids = new Map<string, IdSet>();
  readonly refs = new Map<string, IdSet>();
  readonly userRefs = new Map<string, number>();
  readonly groupRefs = new Set<string>();
  readonly userKeys = new Map<string, string>();
  readonly userNames = new Set<string>();
  readonly appUserNames = new Set<string>();
  readonly groupNames = new Set<string>();
  readonly projects = new Map<number, { key: string; originalkey: string; counter: number }>();
  readonly issueProject = new IntById();
  readonly issueNumber = new IntById();
  readonly issueTypeUse = new Map<number, number>();
  readonly typeStyles = new Map<number, string>();
  readonly linkTypeUse = new Map<number, number>();
  readonly linkTypeStyles = new Map<number, string>();
  readonly attachments: { id: number; issue: number; size: number }[] = [];
  /** Each issue's vote and watch counts, and the rows that name its voters and watchers. */
  readonly issueVotes = new IntById();
  readonly issueWatches = new IntById();
  readonly votesSeen = new IntById();
  readonly watchesSeen = new IntById();
  /** Earlier keys of moved issues (M1-091). */
  readonly moved: { issue: number; key: string }[] = [];
  readonly sequences: { name: string; next: number }[] = [];
  /** Scheme rows a project names through `NodeAssociation`, by element (M1-089). */
  readonly associations: { entity: string; id: number; project: number }[] = [];
  /** Workflows, their schemes and events, and each issue's status in its workflow (M1-090). */
  readonly workflows = new WorkflowChecks();
  /** Boards, sprints, rank, versions and components (M1-093). */
  readonly agile = new AgileChecks();
  readonly cases: Record<string, number> = {};
  rootSeen = false;

  note(name: string, by = 1): void {
    this.cases[name] = (this.cases[name] ?? 0) + by;
  }
}

export async function validateDcBackup(
  zipPath: string,
  manifest?: Manifest | null,
): Promise<ValidationReport> {
  const problems: string[] = [];
  let problemCount = 0;
  const problem = (message: string) => {
    problemCount++;
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };
  const once = new Set<string>();
  const problemOnce = (key: string, message: string) => {
    if (once.has(key)) {
      problemCount++;
      return;
    }
    once.add(key);
    problem(message);
  };

  const state = new EntitiesState();
  const ao = {
    rootSeen: false,
    tables: new Map<string, { name: string; type: string | null }[]>(),
    counts: {} as Record<string, number>,
    boards: new IdSet(),
    boardFilters: [] as number[],
    sprintBoards: [] as number[],
    agile: state.agile,
  };
  const forbidden = { nul: 0, control: 0, noncharacter: 0, charRef: 0 };
  const files: ValidationReport['files'] = { entities: null, activeObjects: null };
  const zipped = new Map<string, number>();
  const attachmentHash = createHash('sha256');
  let attachmentFiles = 0;
  let attachmentBytes = 0;

  const addForbidden = (stats: XmlCleaner['stats']) => {
    forbidden.nul += stats.nul;
    forbidden.control += stats.control;
    forbidden.noncharacter += stats.noncharacter;
    forbidden.charRef += stats.charRef;
  };

  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) =>
      error || !file ? fail(error ?? new Error('zip')) : ok(file),
    ),
  );
  const open = (entry: yauzl.Entry) =>
    new Promise<Readable>((ok, fail) =>
      zip.openReadStream(entry, (error, stream) =>
        error || !stream ? fail(error ?? new Error('zip entry')) : ok(stream),
      ),
    );
  const entries = new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      const next = async () => {
        const name = entry.fileName;
        if (name.endsWith('/')) return;
        if (name === ENTITIES_FILE) {
          const { written, cleaned } = await parseXml(
            await open(entry),
            entitiesHandlers(state, problem, problemOnce),
          );
          files.entities = written;
          addForbidden(cleaned);
        } else if (name === ACTIVE_OBJECTS_FILE) {
          const { written, cleaned } = await parseXml(
            await open(entry),
            aoHandlers(ao, problem, problemOnce),
          );
          files.activeObjects = written;
          addForbidden(cleaned);
        } else if (parseAttachmentPath(name)) {
          const stream = await open(entry);
          let size = 0;
          attachmentHash.update(`${name}\n`);
          for await (const chunk of stream) {
            attachmentHash.update(chunk as Buffer);
            size += (chunk as Buffer).length;
          }
          attachmentFiles++;
          attachmentBytes += size;
          if (zipped.has(name)) problem(`${name}: the ZIP holds it twice`);
          zipped.set(name, size);
        } else {
          problem(`unexpected entry ${name.slice(0, 200)}`);
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
  try {
    await entries;
  } catch (error) {
    problem(`could not read the backup: ${(error as Error).message}`);
  }

  if (!files.entities) problem(`no ${ENTITIES_FILE} at the root of the ZIP`);
  if (!files.activeObjects) problem(`no ${ACTIVE_OBJECTS_FILE} at the root of the ZIP`);
  if (files.entities && !state.rootSeen) problem(`${ENTITIES_FILE}: no ${ENTITIES_ROOT} root`);
  if (files.activeObjects && !ao.rootSeen) problem(`${ACTIVE_OBJECTS_FILE}: no ${AO_ROOT} root`);

  crossCheck(state, ao, zipped, problem);

  const report: ValidationReport = {
    ok: false,
    problems,
    problemCount,
    files,
    attachments: {
      files: attachmentFiles,
      bytes: attachmentBytes,
      sha256: attachmentHash.digest('hex'),
    },
    entities: sorted(state.counts),
    activeObjects: sorted(ao.counts),
    cases: sorted(state.cases),
    forbidden,
  };
  if (manifest) compareWithManifest(report, manifest, problem);
  report.problems = problems;
  report.problemCount = problemCount;
  report.ok = problemCount === 0;
  return report;
}

/** Reads and checks a manifest file. */
export async function readManifest(path: string): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

function sorted(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

type Problem = (message: string) => void;
type ProblemOnce = (key: string, message: string) => void;

function entitiesHandlers(
  state: EntitiesState,
  problem: Problem,
  problemOnce: ProblemOnce,
): XmlHandlers {
  let row: Row | null = null;
  let child: string | null = null;
  let text = '';
  return {
    open(tag, depth) {
      if (depth === 1) {
        if (tag.name !== ENTITIES_ROOT)
          problem(`${ENTITIES_FILE}: root is ${tag.name}, not ${ENTITIES_ROOT}`);
        state.rootSeen = true;
      } else if (depth === 2) {
        row = { name: tag.name, attrs: tag.attributes, children: {}, sections: 0, childCount: 0 };
      } else if (depth === 3 && row) {
        child = tag.name;
        text = '';
      } else {
        problemOnce(
          `deep:${row?.name}`,
          `${ENTITIES_FILE}: ${row?.name} has nested elements below its fields`,
        );
      }
    },
    text(t, depth, cdata) {
      if (depth === 3 && child) {
        text += t;
        if (cdata && row) row.sections++;
      }
    },
    close(_name, depth) {
      if (depth === 3 && row && child) {
        if (child in row.children) problem(`${row.name} ${row.attrs.id}: field ${child} twice`);
        row.children[child] = text;
        row.childCount++;
        child = null;
      } else if (depth === 2 && row) {
        checkRow(state, row, problem, problemOnce);
        row = null;
      }
    },
  };
}

function checkRow(
  state: EntitiesState,
  row: Row,
  problem: Problem,
  problemOnce: ProblemOnce,
): void {
  const { name } = row;
  state.counts[name] = (state.counts[name] ?? 0) + 1;
  const spec = (ENTITIES as Record<string, EntitySpec>)[name];
  if (!spec) {
    problemOnce(`entity:${name}`, `${ENTITIES_FILE}: unknown element ${name}`);
    return;
  }
  const label = `${name} ${row.attrs.id ?? row.attrs.seqName ?? '?'}`;
  if (row.childCount > 0) {
    state.note('textInChildElements', row.childCount);
    state.note('cdataSplits', Math.max(0, row.sections - row.childCount));
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.attrs)) {
    if (!(key in spec.attrs))
      problemOnce(`attr:${name}.${key}`, `${label}: unknown attribute ${key}`);
    values[key] = value;
  }
  for (const [key, value] of Object.entries(row.children)) {
    const attr = spec.attrs[key];
    if (attr?.type !== 'text' || !('long' in attr)) {
      problemOnce(`child:${name}.${key}`, `${label}: ${key} may not be a child element`);
    } else if (key in values) {
      problem(`${label}: ${key} is both an attribute and a child element`);
    }
    values[key] = value;
  }
  for (const [key, attr] of Object.entries(spec.attrs)) {
    const value = values[key];
    if (value === undefined) {
      if (!('optional' in attr) || !attr.optional) problem(`${label}: no ${key}`);
      continue;
    }
    checkValue(state, name, key, attr, value, label, problem);
  }
  record(state, name, values);
}

function checkValue(
  state: EntitiesState,
  entity: string,
  key: string,
  attr: Attr,
  value: string,
  label: string,
  problem: Problem,
): void {
  switch (attr.type) {
    case 'id': {
      if (!INTEGER.test(value) || Number(value) < 0) {
        problem(`${label}: id is not a whole number`);
        return;
      }
      const ids = state.ids.get(entity) ?? new IdSet();
      state.ids.set(entity, ids);
      if (!ids.add(Number(value))) problem(`${label}: duplicate id`);
      return;
    }
    case 'int':
      if (!INTEGER.test(value)) problem(`${label}: ${key} is not a whole number`);
      return;
    case 'number':
      if (!DECIMAL.test(value)) problem(`${label}: ${key} is not a number`);
      return;
    case 'bool':
      if (value !== '0' && value !== '1') problem(`${label}: ${key} is not 1 or 0`);
      return;
    case 'time':
      if (!TIMESTAMP.test(value) || Number.isNaN(Date.parse(`${value.replace(' ', 'T')}Z`))) {
        problem(`${label}: ${key} is not a timestamp`);
      }
      return;
    case 'text':
      return;
    case 'enum':
      if (!attr.values.includes(value))
        problem(`${label}: ${key} "${value.slice(0, 40)}" is not allowed`);
      return;
    case 'user':
      state.userRefs.set(value, (state.userRefs.get(value) ?? 0) + 1);
      return;
    case 'group':
      state.groupRefs.add(value);
      return;
    case 'ref': {
      if (!INTEGER.test(value) || Number(value) < 0) {
        problem(`${label}: ${key} is not an id`);
        return;
      }
      const refs = state.refs.get(attr.to) ?? new IdSet();
      state.refs.set(attr.to, refs);
      refs.add(Number(value));
      return;
    }
  }
}

/** Keeps what the checks after the pass need, and counts the cases. */
function record(state: EntitiesState, name: string, v: Record<string, string>): void {
  const id = Number(v.id);
  state.workflows.row(name, v, (key, by) => state.note(key, by));
  state.agile.row(name, v, (key, by) => state.note(key, by));
  switch (name) {
    case 'User':
      state.userNames.add(v.lowerUserName ?? '');
      if (v.active === '0') state.note('usersInactive');
      state.note('usersPresent');
      return;
    case 'ApplicationUser': {
      const lower = (v.userKey ?? '').toLowerCase();
      if (state.userKeys.has(lower)) state.note('duplicateUserKeys');
      state.userKeys.set(lower, v.userKey ?? '');
      state.appUserNames.add(v.lowerUserName ?? '');
      state.note(v.userKey === v.lowerUserName ? 'userKeysFromNames' : 'userKeysGenerated');
      return;
    }
    case 'Group':
      state.groupNames.add(v.groupName ?? '');
      return;
    case 'Project':
      state.projects.set(id, {
        key: v.key ?? '',
        originalkey: v.originalkey ?? v.key ?? '',
        counter: Number(v.counter),
      });
      return;
    case 'Issue': {
      state.issueProject.set(id, Number(v.project));
      state.issueNumber.set(id, Number(v.number));
      const type = Number(v.type);
      state.issueTypeUse.set(type, (state.issueTypeUse.get(type) ?? 0) + 1);
      if (v.resolution !== undefined) state.note('resolvedIssues');
      if (v.assignee === undefined) state.note('unassignedIssues');
      if (v.security !== undefined) state.note('issuesWithSecurity');
      state.issueVotes.set(id, Number(v.votes ?? 0));
      state.issueWatches.set(id, Number(v.watches ?? 0));
      return;
    }
    case 'UserAssociation': {
      const issue = Number(v.sinkNodeId);
      const seen = v.associationType === 'VoteIssue' ? state.votesSeen : state.watchesSeen;
      seen.set(issue, (seen.get(issue) ?? 0) + 1);
      state.note(v.associationType === 'VoteIssue' ? 'votes' : 'watches');
      return;
    }
    case 'RemoteIssueLink':
      state.note('remoteLinks');
      return;
    case 'MovedIssueKey':
      state.note('movedIssues');
      state.moved.push({ issue: Number(v.issueId), key: v.oldIssueKey ?? '' });
      return;
    case 'Worklog':
      if (v.grouplevel !== undefined) state.note('worklogsForGroup');
      if (v.rolelevel !== undefined) state.note('worklogsForRole');
      return;
    case 'IssueType':
      if (v.style) state.typeStyles.set(id, v.style);
      return;
    case 'IssueLink': {
      const type = Number(v.linktype);
      state.linkTypeUse.set(type, (state.linkTypeUse.get(type) ?? 0) + 1);
      return;
    }
    case 'IssueLinkType':
      if (v.style) state.linkTypeStyles.set(id, v.style);
      return;
    case 'Action':
      if (v.level !== undefined) state.note('commentsForGroup');
      if (v.rolelevel !== undefined) state.note('commentsForRole');
      if (v.updated !== v.created) state.note('commentsEdited');
      return;
    case 'ChangeGroup':
      if (v.author === undefined) state.note('anonymousChanges');
      return;
    case 'ChangeItem':
      if (v.fieldtype === 'custom') state.note('customFieldChanges');
      return;
    case 'FileAttachment':
      state.attachments.push({ id, issue: Number(v.issue), size: Number(v.filesize) });
      return;
    case 'SequenceValueItem':
      state.sequences.push({ name: v.seqName ?? '', next: Number(v.seqId) });
      return;
    case 'NodeAssociation':
      if (v.sourceNodeEntity === 'Project') {
        state.associations.push({
          entity: v.sinkNodeEntity ?? '',
          id: Number(v.sinkNodeId),
          project: Number(v.sourceNodeId),
        });
      }
      return;
    case 'CustomFieldValue':
      state.note('customFieldValues');
      if (v.parentkey !== undefined) state.note('cascadeChildValues');
      return;
    case 'Label':
      if (v.fieldid !== undefined) state.note('customLabels');
      return;
    case 'CustomFieldOption':
      if (v.disabled === 'Y') state.note('optionsDisabled');
      if (v.parentoptionid !== undefined) state.note('optionsCascadeChildren');
      return;
    case 'FieldLayoutItem':
      if (v.isrequired === 'true') state.note('fieldRulesRequired');
      if (v.ishidden === 'true') state.note('fieldRulesHidden');
      return;
  }
}

interface AoState {
  rootSeen: boolean;
  tables: Map<string, { name: string; type: string | null }[]>;
  counts: Record<string, number>;
  boards: IdSet;
  boardFilters: number[];
  sprintBoards: number[];
  agile: AgileChecks;
}

function aoHandlers(ao: AoState, problem: Problem, problemOnce: ProblemOnce): XmlHandlers {
  const where = ACTIVE_OBJECTS_FILE;
  let section: 'table' | 'data' | null = null;
  let table = '';
  let columns: { name: string; type: string | null }[] = [];
  let dataColumns: string[] = [];
  let values: ({ type: string; value: string | null } | null)[] = [];
  let value: { type: string; value: string | null } | null = null;
  let inRow = false;
  return {
    open(tag, depth) {
      const a = tag.attributes;
      if (depth === 1) {
        ao.rootSeen = true;
        if (tag.name !== AO_ROOT) problem(`${where}: root is ${tag.name}, not ${AO_ROOT}`);
        if (a.xmlns !== AO_NAMESPACE) problem(`${where}: root namespace is not ${AO_NAMESPACE}`);
      } else if (depth === 2) {
        if (tag.name === 'table') {
          section = 'table';
          table = a.name ?? '';
          columns = [];
          if (!/^AO_[0-9A-F]{6}_[A-Z0-9_]+$/.test(table) || table.length > 30) {
            problem(
              `${where}: table name ${table.slice(0, 60)} is not AO_<6 hex>_<NAME> within 30 characters`,
            );
          }
          if (ao.tables.has(table)) problem(`${where}: table ${table} defined twice`);
        } else if (tag.name === 'data') {
          section = 'data';
          table = a.tableName ?? '';
          dataColumns = [];
          if (!ao.tables.has(table))
            problem(`${where}: data for ${table}, which has no definition before it`);
          ao.counts[table] ??= 0;
        } else {
          section = null;
          problemOnce(`ao:${tag.name}`, `${where}: unknown element ${tag.name}`);
        }
      } else if (depth === 3 && section === 'table') {
        if (tag.name === 'column') {
          for (const k of ['name', 'primaryKey', 'autoIncrement', 'sqlType']) {
            if (a[k] === undefined) problem(`${where}: ${table} column without ${k}`);
          }
          if (a.sqlType !== undefined && !INTEGER.test(a.sqlType))
            problem(`${where}: ${table}.${a.name} sqlType is not a number`);
          const known = AO_TABLES[table]?.find((c) => c.name === a.name);
          columns.push({ name: a.name ?? '', type: known?.type ?? null });
        } else if (tag.name === 'foreignKey') {
          for (const k of ['fromTable', 'fromColumn', 'toTable', 'toColumn']) {
            if (a[k] === undefined) problem(`${where}: ${table} foreign key without ${k}`);
          }
        } else {
          problemOnce(`ao-table:${tag.name}`, `${where}: unknown element ${tag.name} in a table`);
        }
      } else if (depth === 3 && section === 'data') {
        if (tag.name === 'column') dataColumns.push(a.name ?? '');
        else if (tag.name === 'row') {
          inRow = true;
          values = [];
        } else problemOnce(`ao-data:${tag.name}`, `${where}: unknown element ${tag.name} in data`);
      } else if (depth === 4 && inRow) {
        if (!AO_VALUE_TYPES.includes(tag.name as never)) {
          problemOnce(`ao-value:${tag.name}`, `${where}: unknown value element ${tag.name}`);
        }
        const nil = a['xsi:nil'] === 'true';
        value = { type: tag.name, value: nil ? null : '' };
      }
    },
    text(t, depth) {
      if (depth === 4 && value && value.value !== null) value.value += t;
    },
    close(name, depth) {
      if (depth === 2 && name === 'table') {
        ao.tables.set(table, columns);
        const expected = AO_TABLES[table];
        if (expected && expected.map((c) => c.name).join() !== columns.map((c) => c.name).join()) {
          problem(`${where}: ${table} does not define the columns the format lists`);
        }
      } else if (depth === 2 && name === 'data') {
        section = null;
      } else if (depth === 3 && name === 'column' && section === 'data') {
        // A data section lists its columns before its rows; check once all are read.
        const defined = ao.tables.get(table)?.map((c) => c.name) ?? [];
        if (dataColumns.length === defined.length && dataColumns.join() !== defined.join()) {
          problem(`${where}: data of ${table} names other columns than its definition`);
        }
      } else if (depth === 4 && inRow) {
        values.push(value);
        value = null;
      } else if (depth === 3 && name === 'row') {
        inRow = false;
        checkAoRow(ao, table, dataColumns, values, problem);
      }
    },
  };
}

function checkAoRow(
  ao: AoState,
  table: string,
  columns: string[],
  values: ({ type: string; value: string | null } | null)[],
  problem: Problem,
): void {
  const where = `${ACTIVE_OBJECTS_FILE} ${table} row ${(ao.counts[table] ?? 0) + 1}`;
  ao.counts[table] = (ao.counts[table] ?? 0) + 1;
  const defined = ao.tables.get(table) ?? [];
  if (defined.length !== columns.length)
    problem(`${where}: data lists ${columns.length} columns, the table ${defined.length}`);
  if (values.length !== columns.length) {
    problem(`${where}: ${values.length} values for ${columns.length} columns`);
    return;
  }
  const byName: Record<string, string | null> = {};
  for (const [k, v] of values.entries()) {
    const column = defined[k];
    if (!v) continue;
    if (column?.type && column.type !== v.type)
      problem(`${where}: ${column.name} is a ${v.type}, not a ${column.type}`);
    if (v.value !== null) {
      if (v.type === 'integer' && !INTEGER.test(v.value))
        problem(`${where}: ${columns[k]} is not a whole number`);
      if (v.type === 'boolean' && v.value !== 'true' && v.value !== 'false')
        problem(`${where}: ${columns[k]} is not true or false`);
    }
    byName[columns[k] as string] = v.value;
  }
  ao.agile.aoRow(table, byName, problem);
  const pk = defined.find((c) => c.name === 'ID') ? Number(byName.ID) : null;
  if (table === 'AO_60DB71_RAPIDVIEW' && pk !== null) {
    if (!ao.boards.add(pk)) problem(`${where}: duplicate ID`);
    if (byName.SAVED_FILTER_ID != null) ao.boardFilters.push(Number(byName.SAVED_FILTER_ID));
  }
  if (table === 'AO_60DB71_SPRINT') {
    if (byName.RAPID_VIEW_ID != null) ao.sprintBoards.push(Number(byName.RAPID_VIEW_ID));
    const started = byName.STARTED === 'true';
    const closed = byName.CLOSED === 'true';
    const state = ao as AoState & { sprints?: Record<string, number> };
    state.sprints ??= {};
    const key = closed ? 'sprintsClosed' : started ? 'sprintsActive' : 'sprintsFuture';
    state.sprints[key] = (state.sprints[key] ?? 0) + 1;
  }
}

/** The checks that need the whole file: references, issue numbers, attachments, sequences. */
function crossCheck(
  state: EntitiesState,
  ao: AoState,
  zipped: Map<string, number>,
  problem: Problem,
): void {
  for (const [entity, refs] of state.refs) {
    const ids = state.ids.get(entity);
    let missing = 0;
    let example = -1;
    for (const id of refs.values()) {
      if (!ids?.has(id)) {
        missing++;
        example = id;
      }
    }
    if (missing > 0)
      problem(`${missing} references to missing ${entity} rows (for example ${example})`);
  }

  // People: every user key names a user row or a deleted person; user rows and keys pair up.
  let deleted = 0;
  let deletedRefs = 0;
  for (const [key, count] of state.userRefs) {
    if (!state.userKeys.has(key.toLowerCase())) {
      deleted++;
      deletedRefs += count;
    }
  }
  state.cases.usersDeletedReferenced = deleted;
  state.cases.deletedUserReferences = deletedRefs;
  for (const name of state.appUserNames) {
    if (!state.userNames.has(name)) problem(`ApplicationUser for ${name} has no User row`);
  }
  for (const name of state.userNames) {
    if (!state.appUserNames.has(name)) problem(`User ${name} has no ApplicationUser row`);
  }
  for (const name of state.groupRefs) {
    if (!state.groupNames.has(name)) problem(`group ${name.slice(0, 60)} is named but has no row`);
  }

  // Issues: numbers unique per project and within its counter; skipped numbers counted.
  const issues = state.ids.get('Issue');
  const perProject = new Map<number, number[]>();
  for (const id of issues?.values() ?? []) {
    const project = state.issueProject.get(id) as number;
    const number = state.issueNumber.get(id) as number;
    const list = perProject.get(project) ?? [];
    perProject.set(project, list);
    list.push(number);
  }
  let skipped = 0;
  for (const [project, numbers] of perProject) {
    const p = state.projects.get(project);
    if (!p) continue;
    const sortedNumbers = Float64Array.from(numbers).sort();
    for (let k = 1; k < sortedNumbers.length; k++) {
      if (sortedNumbers[k] === sortedNumbers[k - 1])
        problem(`${p.key}-${sortedNumbers[k]} is used twice`);
    }
    const highest = sortedNumbers[sortedNumbers.length - 1] ?? 0;
    if (highest > p.counter)
      problem(`project ${p.key}: issue number ${highest} is above its counter ${p.counter}`);
    skipped += p.counter - numbers.length;
    perProject.set(project, Array.from(sortedNumbers));
  }
  // Votes and watches: each issue's counts equal the rows that name its voters and watchers.
  let countsOff = 0;
  for (const id of issues?.values() ?? []) {
    if (
      (state.issueVotes.get(id) ?? 0) !== (state.votesSeen.get(id) ?? 0) ||
      (state.issueWatches.get(id) ?? 0) !== (state.watchesSeen.get(id) ?? 0)
    ) {
      if (countsOff++ === 0) problem(`issue ${id}: votes or watches differ from its rows`);
    }
  }
  if (countsOff > 1) problem(`${countsOff} issues' votes or watches differ from their rows`);
  // Moved issues: an earlier key names a project and a number below its counter that no issue
  // of that project holds now (M1-091).
  const byKey = new Map([...state.projects].map(([id, p]) => [p.key, { id, ...p }]));
  for (const m of state.moved) {
    const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(m.key);
    const p = match ? byKey.get(match[1] as string) : undefined;
    if (!match || !p) {
      problem(`MovedIssueKey of issue ${m.issue}: ${m.key.slice(0, 40)} names no project`);
      continue;
    }
    const n = Number(match[2]);
    const numbers = perProject.get(p.id) ?? [];
    let lo = 0;
    let hi = numbers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((numbers[mid] as number) < n) lo = mid + 1;
      else hi = mid;
    }
    if (n > p.counter) problem(`MovedIssueKey ${m.key}: above the project's counter ${p.counter}`);
    if (numbers[lo] === n) problem(`MovedIssueKey ${m.key}: an issue holds that key now`);
  }
  state.cases.issueNumbersSkipped = skipped;
  let subtasks = 0;
  for (const [type, count] of state.issueTypeUse)
    if (state.typeStyles.get(type) === 'jira_subtask') subtasks += count;
  state.cases.subtasks = subtasks;
  let subtaskLinks = 0;
  for (const [type, count] of state.linkTypeUse) {
    if (state.linkTypeStyles.get(type) === 'jira_subtask') subtaskLinks += count;
  }
  if (subtaskLinks !== subtasks)
    problem(`${subtasks} sub-tasks but ${subtaskLinks} sub-task links`);

  // Attachments: each row has its file at the documented path with its size, and no file is
  // without a row.
  const claimed = new Set<string>();
  for (const a of state.attachments) {
    const project = state.issueProject.get(a.issue);
    const number = state.issueNumber.get(a.issue);
    const p = project === undefined ? undefined : state.projects.get(project);
    if (!p || number === undefined) continue;
    const path = attachmentPath(p.originalkey, number, `${p.key}-${number}`, a.id);
    const size = zipped.get(path);
    if (size === undefined) problem(`FileAttachment ${a.id}: no file at ${path}`);
    else if (size !== a.size)
      problem(`FileAttachment ${a.id}: file has ${size} bytes, the row says ${a.size}`);
    claimed.add(path);
  }
  for (const path of zipped.keys())
    if (!claimed.has(path)) problem(`${path} belongs to no FileAttachment row`);

  // Schemes: each association names a project and a row of the element it says (M1-089).
  const projectIds = state.ids.get('Project');
  for (const a of state.associations) {
    if (!projectIds?.has(a.project))
      problem(`NodeAssociation names project ${a.project}, which has no row`);
    const sinks = state.ids.get(a.entity);
    if (!sinks?.has(a.id)) problem(`NodeAssociation names ${a.entity} ${a.id}, which has no row`);
  }

  // Workflows (M1-090).
  state.workflows.check(
    {
      ids: (entity) => state.ids.get(entity),
      groupNames: state.groupNames,
      associations: state.associations,
    },
    problem,
  );

  // Boards, sprints, rank, versions and components (M1-093).
  state.agile.check(
    { ids: (entity) => state.ids.get(entity), issueProject: (id) => state.issueProject.get(id) },
    (key, by) => state.note(key, by),
    problem,
  );

  // Id sequences: each names an element and is above its highest id.
  for (const s of state.sequences) {
    const ids = state.ids.get(s.name);
    if (!ids) continue;
    if (s.next <= ids.max)
      problem(`SequenceValueItem ${s.name}: ${s.next} is not above the highest id ${ids.max}`);
  }

  // Boards and sprints.
  const filters = state.ids.get('SearchRequest');
  for (const f of ao.boardFilters)
    if (!filters?.has(f)) problem(`board filter ${f} has no SearchRequest row`);
  for (const b of ao.sprintBoards)
    if (!ao.boards.has(b)) problem(`sprint of board ${b}, which has no row`);
  const sprints = (ao as AoState & { sprints?: Record<string, number> }).sprints ?? {};
  for (const key of ['sprintsClosed', 'sprintsActive', 'sprintsFuture'])
    state.cases[key] = sprints[key] ?? 0;
}

function compareWithManifest(report: ValidationReport, manifest: Manifest, problem: Problem): void {
  const same = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problem(
        `${what}: ${JSON.stringify(actual)} in the ZIP, ${JSON.stringify(expected)} in the manifest`,
      );
    }
  };
  same(ENTITIES_FILE, report.files.entities, manifest.files.entities);
  same(ACTIVE_OBJECTS_FILE, report.files.activeObjects, manifest.files.activeObjects);
  same('attachments', report.attachments, manifest.attachments);
  same('rows per element', report.entities, manifest.entities);
  same('rows per table', report.activeObjects, manifest.activeObjects);
  same('characters XML forbids', report.forbidden, manifest.forbidden);
  for (const [key, value] of Object.entries(manifest.cases)) {
    if (key === 'usersDeleted') {
      if ((report.cases.usersDeletedReferenced ?? 0) > value)
        problem('more deleted people are named than the manifest has');
      continue;
    }
    same(`case ${key}`, report.cases[key] ?? 0, value);
  }
}
