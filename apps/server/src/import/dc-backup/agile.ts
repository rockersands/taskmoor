import {
  COMPONENT_ASSIGNEE_TYPES,
  ISSUE_ASSOCIATIONS,
  RANK_FIELD_TYPE,
  RANK_ROW_ISSUE,
  SPRINT_FIELD_TYPE,
} from './agile-format';
import { fieldWorldOf } from './fields';
import { timestamp } from './format';
import { Random } from './random';
import type { RowWriter } from './workflows';
import {
  FIRST_ID,
  type IssueFacts,
  type Person,
  type Project,
  type Sprint,
  WORDS,
  type World,
  walkIssues,
  words,
} from './world';

/**
 * The synthetic boards, sprints, rank, versions and components of a backup (M1-093; ADR-095),
 * in the backup's own vocabulary. Everything here draws from streams of its own, so the facts
 * the earlier parts wrote stay as they were: the world's boards (one per software project, with
 * its sprints) keep their ids, names and sprints, and gain columns and quick filters. Added
 * boards:
 *
 * - a Scrum board across the first two projects, through a filter naming both, with sprints of
 *   its own;
 * - a Kanban board of the first project narrowed to one component, with a sub-query;
 * - a Kanban board for each business project, with the same sub-query.
 *
 * Each project has versions (released, archived, upcoming) and components; issues name fix and
 * affected versions and components. Issues that are not sub-tasks sit in closed sprints (some
 * carried over into the next one) and in at most one open sprint of a board that shows them.
 * Every issue has a rank, unique and in an order other than the issues' ids.
 *
 * Names and text are invented here; nothing comes from a real instance.
 */

const DAY = 86_400_000;

export interface VersionDef {
  id: number;
  project: Project;
  name: string;
  description: string | null;
  sequence: number;
  released: boolean;
  archived: boolean;
  start: number | null;
  release: number | null;
}

export interface ComponentDef {
  id: number;
  project: Project;
  name: string;
  description: string | null;
  lead: Person | null;
  assigneeType: number;
}

export type QuickFilterKind =
  | 'mine'
  | 'recent'
  | 'defects'
  | 'urgent'
  | 'component'
  | 'release'
  | 'unestimated'
  | 'reviewer'
  | 'openSprints'
  | 'app';

export interface QuickFilterDef {
  id: number;
  name: string;
  query: string;
  description: string;
  kind: QuickFilterKind;
  /** The component or version a `component` or `release` filter names. */
  component?: ComponentDef;
  version?: VersionDef;
}

export interface ColumnDef {
  id: number;
  name: string;
  min: number | null;
  max: number | null;
  /** Status ids, in their order in the column. */
  statuses: number[];
}

export interface AgileBoard {
  id: number;
  name: string;
  owner: Person;
  /** The `SearchRequest` row of the board's filter. */
  filterId: number;
  filterName: string;
  kind: 'scrum' | 'kanban';
  /** The projects the filter names, the board's own first. */
  projects: Project[];
  /** The component a filter narrows to, if any. */
  component: ComponentDef | null;
  query: string;
  /** A Kanban board's sub-query: issues of upcoming versions or none. */
  subQuery: string | null;
  subQueryId: number | null;
  columns: ColumnDef[];
  quickFilters: QuickFilterDef[];
}

export interface AgileSprint extends Omit<Sprint, 'board'> {
  board: AgileBoard;
}

export interface AgileWorld {
  boards: AgileBoard[];
  sprints: AgileSprint[];
  versions: VersionDef[];
  components: ComponentDef[];
  versionsOf: ReadonlyMap<number, VersionDef[]>;
  componentsOf: ReadonlyMap<number, ComponentDef[]>;
  /** The plugin's custom fields: an issue's sprints and its rank. */
  sprintField: { id: number; name: string; typeKey: string };
  rankField: { id: number; name: string; typeKey: string };
  /** Per project, the Scrum boards that show its issues and have sprints. */
  scrumBoardsOf: ReadonlyMap<number, AgileBoard[]>;
  /** Per board, its sprints in order. */
  sprintsOf: ReadonlyMap<number, AgileSprint[]>;
}

/** What an issue holds of this part. */
export interface IssueAgile {
  fixVersions: VersionDef[];
  affectsVersions: VersionDef[];
  components: ComponentDef[];
  /** Closed sprints first, in their order, then the open one. */
  sprints: AgileSprint[];
  /** The rank row's value. */
  rank: string;
}

/** Custom field ids of the plugin's fields: clear of M1-089's (from 10000). */
const SPRINT_FIELD_ID = 10_100;
const RANK_FIELD_ID = 10_101;
/** Filter ids of the added boards: clear of the world's (10000 + board). */
const FIRST_FILTER_ID = 12_000;

/** A Kanban board's sub-query (Our choice). */
export const KANBAN_SUB_QUERY = 'fixVersion in unreleasedVersions() OR fixVersion is EMPTY';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const built = new WeakMap<World, AgileWorld>();

export function agileWorldOf(world: World): AgileWorld {
  let out = built.get(world);
  if (!out) {
    out = buildAgileWorld(world);
    built.set(world, out);
  }
  return out;
}

function buildAgileWorld(world: World): AgileWorld {
  const seed = world.options.seed;
  const status = (name: string) =>
    (world.statuses.find((s) => s.name === name) as { id: number }).id;

  // Versions and components, per project.
  const versions: VersionDef[] = [];
  const components: ComponentDef[] = [];
  const versionsOf = new Map<number, VersionDef[]>();
  const componentsOf = new Map<number, ComponentDef[]>();
  for (const project of world.projects) {
    const r = Random.derive(seed, 'versions', project.index);
    const count = r.int(2, 5);
    const own: VersionDef[] = [];
    for (let k = 0; k < count; k++) {
      // The last two are upcoming; older ones shipped, the oldest of many archived.
      const released = k < count - 2;
      const release = released
        ? world.end - (count - 2 - k) * 60 * DAY - r.int(1, 20) * DAY
        : k === count - 1 && r.chance(0.5)
          ? null
          : world.end + (k - count + 3) * 30 * DAY;
      const v: VersionDef = {
        id: FIRST_ID + versions.length,
        project,
        name: `${1 + Math.floor(k / 3)}.${k % 3}`,
        description: r.chance(0.6) ? capital(words(r, r.int(2, 5))) : null,
        sequence: k + 1,
        released,
        archived: released && k === 0 && count >= 4,
        start: release !== null && r.chance(0.6) ? release - 45 * DAY : null,
        release: release === null ? null : release - (release % DAY),
      };
      versions.push(v);
      own.push(v);
    }
    versionsOf.set(project.id, own);

    const c = Random.derive(seed, 'components', project.index);
    const names = new Set<string>();
    const ownComponents: ComponentDef[] = [];
    for (let k = c.int(1, 4); k > 0; k--) {
      const name = capital(c.pick(WORDS));
      if (names.has(name)) continue;
      names.add(name);
      const lead = c.chance(0.7) ? (world.users[c.int(0, world.users.length - 1)] as Person) : null;
      const types = Object.values(COMPONENT_ASSIGNEE_TYPES).filter(
        (t) => lead !== null || t !== COMPONENT_ASSIGNEE_TYPES.componentLead,
      );
      const x: ComponentDef = {
        id: FIRST_ID + components.length,
        project,
        name,
        description: c.chance(0.5) ? capital(words(c, c.int(2, 6))) : null,
        lead,
        assigneeType: c.pick(types),
      };
      components.push(x);
      ownComponents.push(x);
    }
    componentsOf.set(project.id, ownComponents);
  }

  // Boards: the world's (Scrum), then the added ones.
  const boards: AgileBoard[] = world.boards.map((b) => ({
    id: b.id,
    name: b.name,
    owner: b.owner,
    filterId: b.filterId,
    filterName: `Filter for ${b.name}`,
    kind: 'scrum',
    projects: [b.project],
    component: null,
    query: `project = ${b.project.key} ORDER BY Rank ASC`,
    subQuery: null,
    subQueryId: null,
    columns: [],
    quickFilters: [],
  }));
  const added = (fields: Omit<AgileBoard, 'id' | 'filterId' | 'filterName' | 'columns'>) => {
    const n = boards.length - world.boards.length;
    const board: AgileBoard = {
      ...fields,
      id: boards.length + 1,
      filterId: FIRST_FILTER_ID + n,
      filterName: `Filter for ${fields.name}`,
      columns: [],
    };
    boards.push(board);
    return board;
  };
  const [first, second] = world.projects as [Project, Project];
  const cross = added({
    name: `${first.key} and ${second.key} delivery`,
    owner: first.lead,
    kind: 'scrum',
    projects: [first, second],
    component: null,
    query: `project in (${first.key}, ${second.key}) ORDER BY Rank ASC`,
    subQuery: null,
    subQueryId: null,
    quickFilters: [],
  });
  const component = (componentsOf.get(first.id) as ComponentDef[])[0] as ComponentDef;
  added({
    name: `${first.key} ${component.name} flow`,
    owner: first.lead,
    kind: 'kanban',
    projects: [first],
    component,
    query: `project = ${first.key} AND component = ${quote(component.name)} ORDER BY Rank ASC`,
    subQuery: KANBAN_SUB_QUERY,
    subQueryId: null,
    quickFilters: [],
  });
  for (const project of world.projects) {
    if (project.type !== 'business' || boards.length >= 260) continue;
    added({
      name: `${project.key} kanban`,
      owner: project.lead,
      kind: 'kanban',
      projects: [project],
      component: null,
      query: `project = ${project.key} ORDER BY Rank ASC`,
      subQuery: KANBAN_SUB_QUERY,
      subQueryId: null,
      quickFilters: [],
    });
  }

  // Columns, quick filters and sub-queries, ids in board order.
  const reviewer = fieldWorldOf(world).fields.find((f) => f.name === 'Reviewer');
  const kinds: QuickFilterKind[] = [
    'mine',
    'recent',
    'defects',
    'urgent',
    'component',
    'release',
    'unestimated',
    'reviewer',
    'openSprints',
    'app',
  ];
  let columnId = FIRST_ID;
  let filterId = FIRST_ID;
  let subQueryId = FIRST_ID;
  for (const [k, board] of boards.entries()) {
    const r = Random.derive(seed, 'board', board.id);
    const done = [status('Finished'), ...(r.chance(0.2) ? [] : [status('Declined')])];
    const specs: Omit<ColumnDef, 'id'>[] =
      board.kind === 'scrum'
        ? r.chance(0.3)
          ? [
              { name: 'To do', min: null, max: null, statuses: [status('Backlog')] },
              {
                name: 'In progress',
                min: null,
                max: r.chance(0.5) ? r.int(3, 8) : null,
                statuses: [status('Selected'), status('Working'), status('In Review')],
              },
              { name: 'Done', min: null, max: null, statuses: done },
            ]
          : [
              {
                name: 'To do',
                min: null,
                max: null,
                statuses: [status('Backlog'), status('Selected')],
              },
              {
                name: 'In progress',
                min: null,
                max: r.chance(0.5) ? r.int(3, 8) : null,
                statuses: [status('Working')],
              },
              { name: 'In review', min: null, max: null, statuses: [status('In Review')] },
              { name: 'Done', min: null, max: null, statuses: done },
            ]
        : [
            { name: 'Backlog', min: null, max: null, statuses: [status('Backlog')] },
            {
              name: 'Selected',
              min: r.int(0, 2) || null,
              max: null,
              statuses: [status('Selected')],
            },
            { name: 'Working', min: null, max: r.int(2, 6), statuses: [status('Working')] },
            { name: 'Review', min: null, max: r.int(1, 4), statuses: [status('In Review')] },
            { name: 'Done', min: null, max: null, statuses: done },
          ];
    board.columns = specs.map((c) => ({ ...c, id: columnId++ }));
    if (board.subQuery !== null) board.subQueryId = subQueryId++;
    // Each board takes the next kinds in turn, so a handful of boards covers every kind.
    const own = board.projects[0] as Project;
    const ownComponent = (componentsOf.get(own.id) as ComponentDef[])[0] as ComponentDef;
    const upcoming = (versionsOf.get(own.id) as VersionDef[]).find((v) => !v.released);
    for (let j = 0; j < 3 + (k % 3); j++) {
      let kind = kinds[(k * 3 + j) % kinds.length] as QuickFilterKind;
      if (kind === 'openSprints' && board.kind === 'kanban') kind = 'unestimated';
      if (kind === 'reviewer' && !reviewer) continue;
      if (board.quickFilters.some((f) => f.kind === kind)) continue;
      const base = { id: filterId++, description: '', kind };
      switch (kind) {
        case 'mine':
          board.quickFilters.push({
            ...base,
            name: 'Only my issues',
            query: 'assignee = currentUser()',
          });
          break;
        case 'recent':
          board.quickFilters.push({
            ...base,
            name: 'Recently updated',
            query: 'updated >= -1d',
            description: 'Changed in the last day',
          });
          break;
        case 'defects':
          board.quickFilters.push({ ...base, name: 'Defects', query: 'issuetype = Defect' });
          break;
        case 'urgent':
          board.quickFilters.push({
            ...base,
            name: 'Urgent',
            query: 'priority in (Critical, High)',
          });
          break;
        case 'component':
          board.quickFilters.push({
            ...base,
            name: `Area: ${ownComponent.name}`,
            query: `component = ${quote(ownComponent.name)}`,
            component: ownComponent,
          });
          break;
        case 'release':
          if (!upcoming) continue;
          board.quickFilters.push({
            ...base,
            name: 'Next release',
            query: `fixVersion = ${quote(upcoming.name)}`,
            version: upcoming,
          });
          break;
        case 'unestimated':
          board.quickFilters.push({
            ...base,
            name: 'No estimate',
            query: 'originalEstimate is EMPTY',
          });
          break;
        case 'reviewer':
          board.quickFilters.push({
            ...base,
            name: 'Has a reviewer',
            query: `cf[${reviewer?.id}] is not EMPTY`,
            description: 'Someone is named to review it',
          });
          break;
        case 'openSprints':
          board.quickFilters.push({
            ...base,
            name: 'Current sprints',
            query: 'sprint in openSprints()',
          });
          break;
        case 'app':
          // An app's query function: Taskmoor has no such thing, so it is reported.
          board.quickFilters.push({
            ...base,
            name: 'Commented (app)',
            query: 'issueFunction in hasComments()',
          });
          break;
      }
    }
  }

  // Sprints: the world's, then the cross board's own.
  const byId = new Map(boards.map((b) => [b.id, b]));
  const sprints: AgileSprint[] = world.sprints.map((s) => ({
    ...s,
    board: byId.get(s.board.id) as AgileBoard,
  }));
  const r = Random.derive(seed, 'cross-sprints');
  const count = 4;
  for (let s = 0; s < count; s++) {
    const state = s < count - 2 ? 'closed' : s === count - 2 ? 'active' : 'future';
    const begin = world.end - (count - s) * 14 * DAY;
    sprints.push({
      id: sprints.length + 1,
      board: cross,
      name: `Delivery ${s + 1}`,
      goal: r.chance(0.7) ? capital(words(r, r.int(3, 6))) : null,
      started: state !== 'future',
      closed: state === 'closed',
      start: state === 'future' ? (r.chance(0.5) ? begin : null) : begin,
      end: state === 'future' ? (r.chance(0.5) ? begin + 14 * DAY : null) : begin + 14 * DAY,
      complete: state === 'closed' ? begin + 14 * DAY + r.int(0, 3_600_000) : null,
      sequence: sprints.length + 1,
    });
  }
  // A future sprint planned ahead keeps its planned dates only when both are there.
  for (const s of sprints) {
    if (!s.started && (s.start === null) !== (s.end === null)) {
      s.start = null;
      s.end = null;
    }
  }

  const sprintsOf = new Map<number, AgileSprint[]>();
  for (const s of sprints) {
    const list = sprintsOf.get(s.board.id) ?? [];
    sprintsOf.set(s.board.id, list);
    list.push(s);
  }
  const scrumBoardsOf = new Map<number, AgileBoard[]>();
  for (const b of boards) {
    if (b.kind !== 'scrum' || !sprintsOf.has(b.id)) continue;
    for (const p of b.projects) {
      const list = scrumBoardsOf.get(p.id) ?? [];
      scrumBoardsOf.set(p.id, list);
      list.push(b);
    }
  }
  return {
    boards,
    sprints,
    versions,
    components,
    versionsOf,
    componentsOf,
    scrumBoardsOf,
    sprintsOf,
    sprintField: { id: SPRINT_FIELD_ID, name: 'Sprint', typeKey: SPRINT_FIELD_TYPE },
    rankField: { id: RANK_FIELD_ID, name: 'Rank', typeKey: RANK_FIELD_TYPE },
  };
}

// --- Per issue -------------------------------------------------------------------------------

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANK_SPACE = 36 ** 6;
/**
 * A step coprime to 36 near the space times the golden ratio: index times it, modulo the space,
 * visits each value once and scatters neighbouring issues across the order.
 */
const RANK_STEP = 1_346_269_813n;

function base36(n: number, width: number): string {
  let out = '';
  let v = n;
  for (let i = 0; i < width; i++) {
    out = (BASE36[v % 36] as string) + out;
    v = Math.floor(v / 36);
  }
  return out;
}

/**
 * An issue's rank: the bucket, six characters unique to the issue, a colon, and for some
 * issues a few more characters (an issue moved between two others). Compared as plain text,
 * ranks give the board order, which is not the order of issue ids.
 */
export function rankOf(world: World, issue: IssueFacts): string {
  const r = Random.derive(world.options.seed, 'rank', issue.index);
  const value = Number((BigInt(issue.index) * RANK_STEP + 7_777_777n) % BigInt(RANK_SPACE));
  const tail = r.chance(0.2) ? base36(r.int(1, 36 ** 2 - 1), 2).replace(/0+$/, '') : '';
  return `0|${base36(value, 6)}:${tail}`;
}

export function issueAgile(world: World, issue: IssueFacts): IssueAgile {
  const aw = agileWorldOf(world);
  const r = Random.derive(world.options.seed, 'agile-issue', issue.index);
  const versions = aw.versionsOf.get(issue.project.id) ?? [];
  const fixVersions: VersionDef[] = [];
  if (versions.length > 0 && r.chance(0.35)) {
    fixVersions.push(r.pick(versions));
    if (r.chance(0.15)) {
      const other = r.pick(versions);
      if (!fixVersions.includes(other)) fixVersions.push(other);
    }
  }
  const affectsVersions: VersionDef[] = [];
  const shipped = versions.filter((v) => v.released);
  if (shipped.length > 0 && r.chance(issue.type.name === 'Defect' ? 0.4 : 0.05)) {
    affectsVersions.push(r.pick(shipped));
  }
  const own = aw.componentsOf.get(issue.project.id) ?? [];
  const components: ComponentDef[] = [];
  if (own.length > 0 && r.chance(0.4)) {
    components.push(r.pick(own));
    if (r.chance(0.25)) {
      const other = r.pick(own);
      if (!components.includes(other)) components.push(other);
    }
  }

  // Sprints: sub-tasks are not generated in sprints (Our choice).
  const sprints: AgileSprint[] = [];
  if (issue.parent === null) {
    const scrum = aw.scrumBoardsOf.get(issue.project.id) ?? [];
    if (scrum.length > 0 && r.chance(0.35)) {
      const board = r.pick(scrum);
      const closed = (aw.sprintsOf.get(board.id) ?? []).filter(
        (s) => s.closed && (s.end ?? 0) > issue.created,
      );
      if (closed.length > 0) {
        const k = r.int(0, closed.length - 1);
        sprints.push(closed[k] as AgileSprint);
        // Not finished in time: carried over into the next sprint.
        const next = closed[k + 1];
        if (next && r.chance(0.3)) sprints.push(next);
      }
    }
    if (issue.status.category !== 'done' && r.chance(0.45)) {
      const open = scrum.flatMap((b) => (aw.sprintsOf.get(b.id) ?? []).filter((s) => !s.closed));
      if (open.length > 0) sprints.push(r.pick(open));
    }
  }
  return { fixVersions, affectsVersions, components, sprints, rank: rankOf(world, issue) };
}

// --- Writing ---------------------------------------------------------------------------------

/** What this part needs of the generator's row writer. */
export interface AgileRowWriter extends RowWriter {
  readonly maxIds: Record<string, number>;
  user(person: Person | null): string | null;
}

const flag = (b: boolean) => (b ? 'true' : null);
/** A double as the entities file writes it (Verify). */
const double = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

/** The elements of this part, and its rows of the shared elements. */
export async function writeAgileEntity(
  world: World,
  w: AgileRowWriter,
  name: string,
): Promise<void> {
  const aw = agileWorldOf(world);
  switch (name) {
    case 'Version':
      for (const v of aw.versions) {
        if (v.released) w.note('versionsReleased');
        if (v.archived) w.note('versionsArchived');
        await w.row(name, {
          id: v.id,
          project: v.project.id,
          name: v.name,
          description: v.description,
          sequence: v.sequence,
          released: flag(v.released),
          archived: flag(v.archived),
          startdate: v.start === null ? null : timestamp(v.start),
          releasedate: v.release === null ? null : timestamp(v.release),
        });
      }
      return;
    case 'Component':
      for (const c of aw.components) {
        await w.row(name, {
          id: c.id,
          project: c.project.id,
          name: c.name,
          description: c.description === null ? null : { text: c.description },
          lead: w.user(c.lead),
          assigneetype: c.assigneeType,
        });
      }
      return;
    case 'CustomField':
      for (const f of [aw.sprintField, aw.rankField]) {
        await w.row(name, {
          id: f.id,
          customfieldtypekey: f.typeKey,
          customfieldsearcherkey: null,
          cfname: f.name,
          description: { text: `The agile plugin's ${f.name.toLowerCase()} field` },
        });
      }
      return;
    case 'CustomFieldValue': {
      // An issue's sprints: one value per sprint, after M1-089's values.
      let id = (w.maxIds.CustomFieldValue ?? FIRST_ID - 1) + 1;
      for (const issue of walkIssues(world)) {
        const a = issueAgile(world, issue);
        if (a.sprints.length > 1) w.note('issuesInSeveralSprints');
        for (const s of a.sprints) {
          w.note(s.closed ? 'sprintIssuesClosed' : 'sprintIssuesOpen');
          w.note('customFieldValues');
          await w.row(name, {
            id: id++,
            issue: issue.id,
            customfield: aw.sprintField.id,
            numbervalue: double(s.id),
          });
        }
      }
      return;
    }
    case 'NodeAssociation':
      for (const issue of walkIssues(world)) {
        const a = issueAgile(world, issue);
        const rows: (readonly [string, string, number])[] = [
          ...a.fixVersions.map((v) => [ISSUE_ASSOCIATIONS.fixVersion, 'Version', v.id] as const),
          ...a.affectsVersions.map(
            (v) => [ISSUE_ASSOCIATIONS.affectsVersion, 'Version', v.id] as const,
          ),
          ...a.components.map((c) => [ISSUE_ASSOCIATIONS.component, 'Component', c.id] as const),
        ];
        for (const [type, entity, sink] of rows) {
          w.note(
            type === ISSUE_ASSOCIATIONS.fixVersion
              ? 'issueFixVersions'
              : type === ISSUE_ASSOCIATIONS.affectsVersion
                ? 'issueAffectedVersions'
                : 'issueComponents',
          );
          await w.row(name, {
            sourceNodeId: issue.id,
            sourceNodeEntity: 'Issue',
            sinkNodeId: sink,
            sinkNodeEntity: entity,
            associationType: type,
          });
        }
      }
      return;
  }
}

/** The text of the added boards' saved filters (`SearchRequest`), after the world's. */
export function* addedFilters(
  world: World,
): Generator<{ id: number; name: string; author: Person; request: string }> {
  for (const b of agileWorldOf(world).boards) {
    if (b.id <= world.boards.length) continue;
    yield { id: b.filterId, name: b.filterName, author: b.owner, request: b.query };
  }
}

type AoRow = (string | number | boolean | null)[];

/** The rows of the agile plugin's tables, boards and sprints included. */
export function agileRows(world: World): Record<string, Iterable<AoRow>> {
  const aw = agileWorldOf(world);
  return {
    AO_60DB71_RAPIDVIEW: aw.boards.map((b) => [
      b.id,
      b.name,
      b.owner.key,
      b.filterId,
      b.kind === 'scrum',
    ]),
    AO_60DB71_SPRINT: aw.sprints.map((s) => [
      s.id,
      s.name,
      s.board.id,
      s.started,
      s.closed,
      s.start,
      s.end,
      s.complete,
      s.goal,
      s.sequence,
    ]),
    AO_60DB71_COLUMN: aw.boards.flatMap((b) =>
      b.columns.map((c, k) => [c.id, c.name, k, b.id, c.min, c.max]),
    ),
    AO_60DB71_COLUMNSTATUS: (function* () {
      let id = FIRST_ID;
      for (const b of aw.boards) {
        for (const c of b.columns) {
          for (const [k, s] of c.statuses.entries()) yield [id++, c.id, k, String(s)];
        }
      }
    })(),
    AO_60DB71_QUICKFILTER: aw.boards.flatMap((b) =>
      b.quickFilters.map((f, k) => [f.id, f.name, f.query, f.description || null, k, b.id]),
    ),
    AO_60DB71_SUBQUERY: aw.boards.flatMap((b) =>
      b.subQuery === null ? [] : [[b.subQueryId, b.subQuery, b.id]],
    ),
    AO_60DB71_LEXORANK: (function* () {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        yield [
          id++,
          0,
          aw.rankField.id,
          issue.id,
          null,
          null,
          rankOf(world, issue),
          RANK_ROW_ISSUE,
        ];
      }
    })(),
  };
}

/** The manifest's cases of this part that are not counted while rows are written. */
export function agileCases(world: World): Record<string, number> {
  const aw = agileWorldOf(world);
  const cases: Record<string, number> = {
    boardsScrum: aw.boards.filter((b) => b.kind === 'scrum').length,
    boardsKanban: aw.boards.filter((b) => b.kind === 'kanban').length,
    boardsAcrossProjects: aw.boards.filter((b) => b.projects.length > 1).length,
    boardColumns: aw.boards.reduce((n, b) => n + b.columns.length, 0),
    boardColumnLimits: aw.boards.reduce(
      (n, b) => n + b.columns.filter((c) => c.min !== null || c.max !== null).length,
      0,
    ),
    quickFilters: aw.boards.reduce((n, b) => n + b.quickFilters.length, 0),
    subQueries: aw.boards.filter((b) => b.subQuery !== null).length,
    issuesRanked: world.options.issues,
  };
  return cases;
}
