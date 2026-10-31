import type { GeneratorOptions } from './manifest';
import { Random, Skewed } from './random';

/**
 * The synthetic instance a backup is written from (M1-087). Everything small (people, groups,
 * roles, projects, issue types, statuses, priorities, resolutions, link types, boards) is built
 * once; everything per issue is recomputed from the seed whenever a pass needs it
 * (`walkIssues`, then `comments`, `history`, ... for one issue), so a backup of a million
 * issues is written with memory for the small things only. This file is the backup format's
 * own vocabulary (issue, project, resolution), as the format layer may use (ADR-003, file 00).
 *
 * Names and text are invented here; nothing comes from a real instance.
 */

export const FIRST_ID = 10_000;
const DAY = 86_400_000;

export interface Person {
  /** Position in `World.people`: present users first, then the deleted ones. */
  index: number;
  /** The key other rows use to name the person. */
  key: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  active: boolean;
  /** Only present people have rows; deleted ones are only named by other rows. */
  deleted: boolean;
  /** Row id in the user and user-key tables (present people only). */
  id: number;
  created: number;
}

export interface Group {
  id: number;
  name: string;
  /** Indexes of present people. */
  members: number[];
}

export interface Named {
  id: number;
  name: string;
  description: string;
}

export interface Status {
  id: number;
  name: string;
  category: 'new' | 'indeterminate' | 'done';
  /** Status ids an issue passes through from the initial status to this one, this one last. */
  path: number[];
}

export interface IssueType extends Named {
  subtask: boolean;
}

export interface LinkType {
  id: number;
  name: string;
  outward: string;
  inward: string;
  /** Set on the type that ties sub-tasks to their parents. */
  subtask: boolean;
}

export interface Project {
  index: number;
  id: number;
  key: string;
  name: string;
  description: string;
  lead: Person;
  type: 'software' | 'business';
  /** The key it had before a rename (M1-128); its issues' attachment folders keep it. */
  originalKey?: string;
  /** The highest issue number used, numbers skipped included. */
  counter: number;
  /** Issues in the project. */
  issues: number;
}

export interface Board {
  id: number;
  name: string;
  project: Project;
  /** Row id of the saved filter the board shows. */
  filterId: number;
  owner: Person;
}

export interface Sprint {
  id: number;
  board: Board;
  name: string;
  goal: string | null;
  started: boolean;
  closed: boolean;
  start: number | null;
  end: number | null;
  complete: number | null;
  sequence: number;
}

export interface World {
  options: GeneratorOptions;
  /** The first and last moments of activity. */
  start: number;
  end: number;
  people: Person[];
  /** The present people (rows written). */
  users: Person[];
  groups: Group[];
  roles: Named[];
  projects: Project[];
  issueTypes: IssueType[];
  statuses: Status[];
  priorities: Named[];
  resolutions: Named[];
  linkTypes: LinkType[];
  boards: Board[];
  sprints: Sprint[];
  pickPerson: (random: Random) => Person;
  pickProject: (random: Random) => number;
}

// --- Invented vocabulary ---------------------------------------------------------------------

// biome-ignore format: a word list
const SYLLABLES = [
  'ka', 'lo', 'mi', 'ra', 'sen', 'tor', 'vel', 'an', 'is', 'or', 'bel', 'dar', 'fen', 'gal',
  'hal', 'jun', 'kel', 'lin', 'mor', 'nal', 'pir', 'quo', 'ris', 'sol', 'tam', 'ul', 'vin',
  'wen', 'xan', 'yor', 'zel', 'bri', 'cor', 'dei', 'eth', 'fia', 'gor', 'hin', 'ivo',
];
// biome-ignore format: a word list
export const WORDS = [
  'harbour', 'lantern', 'meadow', 'copper', 'ledger', 'orchard', 'quarry', 'signal', 'timber',
  'violet', 'willow', 'beacon', 'export', 'invoice', 'search', 'billing', 'sync', 'payment',
  'profile', 'widget', 'cache', 'session', 'upload', 'planner', 'archive', 'token', 'report',
  'queue', 'retry', 'layout', 'banner', 'filter', 'café', 'ñandú', 'größe', 'データ', '日本',
];
// biome-ignore format: a word list
const VERBS = [
  'Fix', 'Add', 'Update', 'Remove', 'Improve', 'Investigate', 'Document', 'Migrate', 'Split',
  'Merge', 'Audit', 'Review', 'Rename', 'Support',
];
const SENTENCES = [
  'Steps to reproduce are below.',
  'This blocks the next release.',
  'Customers reported it twice this week.',
  'Logs show a timeout after thirty seconds.',
  'Expected: the list refreshes without a reload.',
  'Needs a decision from the owner.',
  'Compare <old> & <new> values, "quoted" and \'single\'.',
  'Performance regressed after the last deploy.',
  'The parser stopped at "]]>" in the log.',
];
// biome-ignore format: a word list
export const LABELS = [
  'backend', 'frontend', 'ux', 'security', 'performance', 'tech-debt', 'customer', 'regression',
  'docs', 'infra', 'mobile', 'q3-goal',
];
export const FILE_KINDS = [
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'csv', mime: 'text/csv' },
  { ext: 'json', mime: 'application/json' },
  { ext: 'log', mime: 'text/plain' },
  { ext: 'bin', mime: 'application/octet-stream' },
] as const;

function name(random: Random, syllables: number): string {
  let out = '';
  for (let i = 0; i < syllables; i++) out += random.pick(SYLLABLES);
  return out;
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function words(random: Random, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(random.pick(WORDS));
  return out.join(' ');
}

export function summaryOf(random: Random): string {
  return `${random.pick(VERBS)} ${words(random, random.int(2, 7))}`;
}

/** A paragraph or a few, with line breaks, markup-like characters and non-Latin words. */
export function paragraphs(random: Random, max: number): string {
  const out: string[] = [];
  for (let p = random.int(1, max); p > 0; p--) {
    const line: string[] = [];
    for (let s = random.int(1, 4); s > 0; s--) {
      line.push(random.chance(0.5) ? random.pick(SENTENCES) : `${capital(words(random, 6))}.`);
    }
    out.push(line.join(' '));
  }
  return out.join('\n\n');
}

/** Project keys: two to four capitals, unique by construction from the index. */
export function projectKey(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = index;
  let key = '';
  do {
    key = letters[n % 26] + key;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return key.length === 1 ? `${key}X` : key;
}

// --- The instance ----------------------------------------------------------------------------

export function buildWorld(options: GeneratorOptions): World {
  const random = Random.derive(options.seed, 'world');
  const end = Date.parse(options.exportedAt) - DAY;
  const start = end - 3 * 365 * DAY;

  const people: Person[] = [];
  const deletedCount = Math.max(2, Math.round(options.users / 40));
  for (let i = 0; i < options.users + deletedCount; i++) {
    const deleted = i >= options.users;
    const first = capital(name(random, 2));
    const last = capital(name(random, random.int(2, 3)));
    const username = `${first}.${last}${i}`;
    // Older people are keyed by their lower-case user name, later ones by a generated key (as
    // after renaming became possible); the importer must accept both.
    const key = i % 3 === 0 ? username.toLowerCase() : `JIRAUSER${FIRST_ID + i}`;
    people.push({
      index: i,
      key,
      username,
      firstName: first,
      lastName: last,
      displayName: `${first} ${last}`,
      email: `${username}@example.test`,
      active: !deleted && i % 17 !== 5,
      deleted,
      id: FIRST_ID + i,
      created: start - random.int(1, 400) * DAY,
    });
  }
  const users = people.slice(0, options.users);
  // A few people do most of the work; deleted people sit at the end, so they are rarer.
  const skewedPeople = new Skewed(people.length, 0.9);
  const pickPerson = (r: Random) => people[skewedPeople.sample(r)] as Person;

  const groups: Group[] = [];
  const everyone: Group = { id: FIRST_ID, name: 'everyone', members: [] };
  groups.push(everyone);
  for (let g = 1; g < options.groups; g++) {
    groups.push({ id: FIRST_ID + g, name: `team-${name(random, 2)}-${g}`, members: [] });
  }
  for (const user of users) {
    everyone.members.push(user.index);
    if (groups.length > 1) {
      const own = new Set<number>();
      for (let k = random.int(1, 3); k > 0; k--) own.add(random.int(1, groups.length - 1));
      for (const g of [...own].sort((a, b) => a - b)) groups[g]?.members.push(user.index);
    }
  }

  const roles: Named[] = [
    { id: FIRST_ID, name: 'Managers', description: 'People who configure the project' },
    { id: FIRST_ID + 1, name: 'Contributors', description: 'People who work on issues' },
    { id: FIRST_ID + 2, name: 'Observers', description: 'People who follow along' },
  ];

  const issueTypes: IssueType[] = [
    { id: FIRST_ID, name: 'Feature request', description: 'Something new', subtask: false },
    { id: FIRST_ID + 1, name: 'Defect', description: 'Something broken', subtask: false },
    { id: FIRST_ID + 2, name: 'Chore', description: 'Upkeep work', subtask: false },
    { id: FIRST_ID + 3, name: 'Milestone', description: 'A large piece of work', subtask: false },
    { id: FIRST_ID + 4, name: 'Step', description: 'Part of another issue', subtask: true },
  ];

  const backlog = FIRST_ID;
  const statuses: Status[] = [
    { id: backlog, name: 'Backlog', category: 'new', path: [backlog] },
    { id: FIRST_ID + 1, name: 'Selected', category: 'new', path: [backlog, FIRST_ID + 1] },
    {
      id: FIRST_ID + 2,
      name: 'Working',
      category: 'indeterminate',
      path: [backlog, FIRST_ID + 1, FIRST_ID + 2],
    },
    {
      id: FIRST_ID + 3,
      name: 'In Review',
      category: 'indeterminate',
      path: [backlog, FIRST_ID + 1, FIRST_ID + 2, FIRST_ID + 3],
    },
    {
      id: FIRST_ID + 4,
      name: 'Finished',
      category: 'done',
      path: [backlog, FIRST_ID + 1, FIRST_ID + 2, FIRST_ID + 3, FIRST_ID + 4],
    },
    { id: FIRST_ID + 5, name: 'Declined', category: 'done', path: [backlog, FIRST_ID + 5] },
  ];

  const priorities: Named[] = ['Critical', 'High', 'Normal', 'Low', 'Trivial'].map((n, i) => ({
    id: FIRST_ID + i,
    name: n,
    description: `${n} urgency`,
  }));
  const resolutions: Named[] = ['Fixed', "Won't fix", 'Duplicate', 'Cannot reproduce'].map(
    (n, i) => ({ id: FIRST_ID + i, name: n, description: `Closed as ${n.toLowerCase()}` }),
  );

  const linkTypes: LinkType[] = [
    { id: FIRST_ID, name: 'Blocking', outward: 'blocks', inward: 'is blocked by', subtask: false },
    {
      id: FIRST_ID + 1,
      name: 'Related',
      outward: 'relates to',
      inward: 'relates to',
      subtask: false,
    },
    { id: FIRST_ID + 2, name: 'Copy', outward: 'copies', inward: 'is copied by', subtask: false },
    {
      id: FIRST_ID + 3,
      name: 'Repeat',
      outward: 'repeats',
      inward: 'is repeated by',
      subtask: false,
    },
    {
      id: FIRST_ID + 4,
      name: 'jira_subtask_link',
      outward: 'jira_subtask_outward',
      inward: 'jira_subtask_inward',
      subtask: true,
    },
  ];

  const projects: Project[] = [];
  for (let p = 0; p < options.projects; p++) {
    projects.push({
      index: p,
      id: FIRST_ID + p,
      key: projectKey(p),
      name: `${capital(name(random, 2))} ${capital(random.pick(WORDS))}`,
      description: paragraphs(random, 1),
      lead: users[random.int(0, users.length - 1)] as Person,
      type: p % 5 === 4 ? 'business' : 'software',
      ...(p < (options.renamedProjects ?? 0) ? { originalKey: `${projectKey(p)}OLD` } : {}),
      counter: 0,
      issues: 0,
    });
  }
  const skewedProjects = new Skewed(projects.length, 0.8);
  const pickProject = (r: Random) => skewedProjects.sample(r);

  // One board per software project (at most 200), each over a saved filter of its project.
  const boards: Board[] = [];
  const sprints: Sprint[] = [];
  for (const project of projects) {
    if (project.type !== 'software' || boards.length >= 200) continue;
    const board: Board = {
      id: boards.length + 1,
      name: `${project.key} board`,
      project,
      filterId: FIRST_ID + boards.length,
      owner: project.lead,
    };
    boards.push(board);
    const count = random.int(0, 6);
    for (let s = 0; s < count; s++) {
      // Closed sprints first, then at most one active, then future ones.
      const state = s < count - 2 ? 'closed' : s === count - 2 ? 'active' : 'future';
      const begin = end - (count - s) * 14 * DAY;
      sprints.push({
        id: sprints.length + 1,
        board,
        name: `${project.key} sprint ${s + 1}`,
        goal: random.chance(0.5) ? summaryOf(random) : null,
        started: state !== 'future',
        closed: state === 'closed',
        start: state === 'future' ? null : begin,
        end: state === 'future' ? null : begin + 14 * DAY,
        complete: state === 'closed' ? begin + 14 * DAY : null,
        sequence: sprints.length + 1,
      });
    }
  }

  const world: World = {
    options,
    start,
    end,
    people,
    users,
    groups,
    roles,
    projects,
    issueTypes,
    statuses,
    priorities,
    resolutions,
    linkTypes,
    boards,
    sprints,
    pickPerson,
    pickProject,
  };
  // Project counters and sizes come from a walk over the issues (core facts only).
  for (const issue of walkIssues(world)) {
    issue.project.counter = issue.number;
    issue.project.issues++;
  }
  return world;
}

// --- Issues ----------------------------------------------------------------------------------

export interface IssueFacts {
  index: number;
  id: number;
  project: Project;
  number: number;
  key: string;
  type: IssueType;
  /** The parent of a sub-task and this sub-task's position among its siblings (1, 2, ...). */
  parent: { id: number; sequence: number } | null;
  status: Status;
  resolution: Named | null;
  priority: Named;
  reporter: Person;
  creator: Person;
  assignee: Person | null;
  created: number;
  updated: number;
  resolved: number | null;
  due: number | null;
  votes: number;
  watches: number;
  estimate: number | null;
  /** Numbers skipped just before this issue's number (deleted issues in the source). */
  skipped: number;
  /**
   * Where the issue was before it was moved into its project (M1-091): the earlier project, the
   * number it had there (one that project skipped, so no other issue holds it) and when.
   */
  moved: { project: Project; number: number; at: number } | null;
}

const RECENT = 16;
/** Numbers a project skipped that a moved issue may have held there, kept per project. */
const FREE_NUMBERS = 32;

/**
 * The issues in id order with their core facts. The walk keeps a counter and a few recent
 * parents per project, nothing else, and gives the same facts on every walk.
 */
export function* walkIssues(world: World): Generator<IssueFacts> {
  const { options } = world;
  const counters = new Int32Array(world.projects.length);
  const recent: { id: number; children: number }[][] = world.projects.map(() => []);
  const free: number[][] = world.projects.map(() => []);
  const withFree = new Set<number>();
  const standard = world.issueTypes.filter((t) => !t.subtask);
  const subtaskType = world.issueTypes.find((t) => t.subtask) as IssueType;
  // Leave two days at the end, so every issue has room for later activity.
  const span = world.end - world.start - 2 * DAY;
  for (let i = 0; i < options.issues; i++) {
    const r = Random.derive(options.seed, 'issue', i);
    const p = world.pickProject(r);
    const project = world.projects[p] as Project;
    const skipped = r.chance(0.01) ? r.int(1, 3) : 0;
    const number = (counters[p] ?? 0) + skipped + 1;
    counters[p] = number;
    const id = FIRST_ID + i;
    const ring = recent[p] as { id: number; children: number }[];
    let parent: IssueFacts['parent'] = null;
    let type: IssueType;
    if (ring.length > 0 && r.chance(0.12)) {
      const chosen = r.pick(ring);
      chosen.children++;
      parent = { id: chosen.id, sequence: chosen.children };
      type = subtaskType;
    } else {
      type = r.weighted(standard.map((t, k) => [t, k === 3 ? 1 : 6] as const));
      ring.push({ id, children: 0 });
      if (ring.length > RECENT) ring.shift();
    }
    const status = r.weighted(
      world.statuses.map((s, k) => [s, [5, 3, 4, 2, 9, 1][k] ?? 1] as const),
    );
    const done = status.category === 'done';
    const resolution = done
      ? status.name === 'Declined'
        ? (world.resolutions[r.int(1, world.resolutions.length - 1)] as Named)
        : (world.resolutions[0] as Named)
      : null;
    const priority = r.weighted(
      world.priorities.map((x, k) => [x, [1, 3, 8, 3, 1][k] ?? 1] as const),
    );
    const reporter = world.pickPerson(r);
    const creator = r.chance(0.9) ? reporter : world.pickPerson(r);
    const assignee = r.chance(0.8) ? world.pickPerson(r) : null;
    const created = world.start + Math.floor((i / options.issues) * span) + r.int(0, 3_600_000);
    const room = world.end - created;
    const resolved = done ? created + Math.floor(r.next() * room * 0.6) + 60_000 : null;
    const updated = Math.min(
      world.end,
      Math.max(resolved ?? created, created + Math.floor(r.next() * room * 0.8)) + 60_000,
    );
    const due = r.chance(0.2) ? created + r.int(3, 90) * DAY : null;
    const estimate = r.chance(0.4) ? r.int(1, 40) * 3600 : null;
    // Moves come from a stream of their own, so the facts above stay as they were (M1-091): an
    // issue that is not a sub-task sometimes came from another project, where it held a number
    // that project skipped.
    let moved: IssueFacts['moved'] = null;
    const m = Random.derive(options.seed, 'moved', i);
    if (parent === null && withFree.size > 0 && m.chance(0.004)) {
      const candidates = [...withFree].filter((q) => q !== p).sort((a, b) => a - b);
      if (candidates.length > 0) {
        const q = m.pick(candidates);
        const numbers = free[q] as number[];
        const old = numbers.shift() as number;
        if (numbers.length === 0) withFree.delete(q);
        moved = {
          project: world.projects[q] as Project,
          number: old,
          at: between(m, created + 60_000, Math.max(created + 60_000, updated - 60_000)),
        };
      }
    }
    if (skipped > 0) {
      const numbers = free[p] as number[];
      for (let n = number - skipped; n < number; n++) {
        if (numbers.length < FREE_NUMBERS) numbers.push(n);
      }
      withFree.add(p);
    }
    yield {
      index: i,
      id,
      project,
      number,
      key: `${project.key}-${number}`,
      type,
      parent,
      status,
      resolution,
      priority,
      reporter,
      creator,
      assignee,
      created,
      updated,
      resolved,
      due,
      votes: r.geometric(0.3, 50),
      watches: 1 + r.geometric(0.6, 50),
      estimate,
      skipped,
      moved,
    };
  }
}

/** A time between `from` and `to`, at whole milliseconds. */
export function between(random: Random, from: number, to: number): number {
  return from + Math.floor(random.next() * Math.max(0, to - from));
}
