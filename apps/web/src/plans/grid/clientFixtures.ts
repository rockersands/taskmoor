import type { OutputType } from '@taskmoor/formula';
import { ApiError } from '../../api/client';
import type { SearchClient, SearchTicket } from '../../search/client';
import { fakeSearchClient } from '../../search/fixtures';
import type { LinkTypeOption } from '../client';
import type { FormulaCheck, GridAt, GridClient, LevelName, StructureOutcome } from './client';
import { bigSkeleton, type FixtureRow, skeletonOf } from './fixtures';
import {
  DEFAULT_STRUCTURE,
  GRID_LIMITS,
  type GridAnswer,
  type GridField,
  type GridSkeleton,
  type StructureProblem,
  type StructureSpec,
  type StructureSummary,
} from './types';

/**
 * A plan's Grid in memory, for the page's tests and stories: plan 12, "Spring launch". Its tickets
 * are a small tree of two Outcomes and a ticket of their own; one row is outside the plan ("Not in
 * this plan"), one was placed by a link, one hides a child from the viewer (+1 not shown) and one
 * is reached twice (shown elsewhere).
 */

export const GRID_LEVELS: LevelName[] = [
  { rank: 2, name: 'Objective' },
  { rank: 1, name: 'Outcome' },
  { rank: 0, name: 'Standard' },
  { rank: -1, name: 'Subticket' },
];

export const GRID_LINK_TYPES: LinkTypeOption[] = [
  { id: 1, name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  { id: 2, name: 'Relates', outward: 'relates to', inward: 'relates to' },
];

/** The fields the sample's totals and formulas read: estimates in seconds and Points. */
export const GRID_FIELDS: GridField[] = [
  { ref: 'originalEstimate', type: 'duration' },
  { ref: 'cf[41]', type: 'number' },
];

interface SampleRow extends FixtureRow {
  summary?: string;
  stage?: 'new' | 'active' | 'closed';
  assignee?: string | null;
}

const HOUR = 3600;

/** The sample tree, in preorder. */
export const SAMPLE_ROWS: SampleRow[] = [
  {
    ticket: 1,
    parent: -1,
    key: 'SHOP-1',
    summary: 'Checkout that never loses a cart',
    level: 1,
    stage: 'active',
    assignee: 'Ana Ruiz',
    values: { originalEstimate: null, 'cf[41]': null },
  },
  {
    ticket: 41,
    parent: 0,
    key: 'SHOP-41',
    summary: 'Refunds fail for expired cards',
    level: 0,
    stage: 'active',
    assignee: 'Kalo Moana',
    values: { originalEstimate: 5 * HOUR, 'cf[41]': 3 },
  },
  {
    ticket: 60,
    parent: 1,
    key: 'SHOP-60',
    summary: 'Retry the refund job',
    level: -1,
    stage: 'closed',
    closed: true,
    assignee: 'Kalo Moana',
    values: { originalEstimate: 2 * HOUR, 'cf[41]': 1 },
  },
  {
    ticket: 44,
    parent: 0,
    key: 'SHOP-44',
    summary: 'Receipts show the wrong currency',
    level: 0,
    stage: 'new',
    assignee: null,
    notShown: 1,
    values: { originalEstimate: 3 * HOUR, 'cf[41]': 5 },
  },
  {
    ticket: 12,
    parent: 0,
    key: 'OPS-12',
    summary: 'Rotate the payment keys',
    level: 0,
    track: 2,
    inPlan: false,
    stage: 'closed',
    closed: true,
    assignee: 'Rin Okafor',
    values: { originalEstimate: HOUR, 'cf[41]': 2 },
  },
  {
    ticket: 2,
    parent: -1,
    key: 'SHOP-2',
    summary: 'Faster search',
    level: 1,
    stage: 'new',
    assignee: 'Ana Ruiz',
    values: { originalEstimate: null, 'cf[41]': null },
  },
  {
    ticket: 50,
    parent: 5,
    key: 'SHOP-50',
    summary: 'Index product names',
    level: 0,
    stage: 'active',
    assignee: 'Rin Okafor',
    values: { originalEstimate: 8 * HOUR, 'cf[41]': null },
  },
  {
    ticket: 7,
    parent: 6,
    key: 'DATA-7',
    summary: 'Rebuild the search index',
    level: 0,
    track: 3,
    via: 2,
    stage: 'new',
    assignee: null,
    values: { originalEstimate: 4 * HOUR, 'cf[41]': 2 },
  },
  {
    ticket: 70,
    parent: -1,
    key: 'SHOP-70',
    summary: 'Dark mode for receipts',
    level: 0,
    stage: 'new',
    assignee: 'Ana Ruiz',
    elsewhere: 1,
    values: { originalEstimate: 2 * HOUR, 'cf[41]': 1 },
  },
];

/** The sample grouped by status: Active, New, and the group of no value (none here empty). */
const GROUPED_ROWS: SampleRow[] = [
  { ticket: 0, parent: -1, label: 'Active', value: '2' },
  { ...(SAMPLE_ROWS[0] as SampleRow), parent: 0 },
  { ...(SAMPLE_ROWS[1] as SampleRow), parent: 1 },
  { ...(SAMPLE_ROWS[2] as SampleRow), parent: 2 },
  { ...(SAMPLE_ROWS[3] as SampleRow), parent: 1 },
  { ...(SAMPLE_ROWS[4] as SampleRow), parent: 1 },
  { ticket: 0, parent: -1, label: 'New', value: '1' },
  { ...(SAMPLE_ROWS[5] as SampleRow), parent: 6 },
  { ...(SAMPLE_ROWS[6] as SampleRow), parent: 7 },
  { ...(SAMPLE_ROWS[7] as SampleRow), parent: 8 },
  { ticket: 0, parent: -1, label: null, value: null },
  { ...(SAMPLE_ROWS[8] as SampleRow), parent: 10 },
];

/** A saved structure of the sample: estimates and points over the rows below, and a formula. */
export const ESTIMATES: StructureSpec = {
  steps: [
    { kind: 'insert' },
    { kind: 'children' },
    { kind: 'links', linkTypeId: 1, direction: 'outward', depth: 1 },
  ],
  columns: [
    { kind: 'ticket', field: 'key' },
    { kind: 'ticket', field: 'summary' },
    { kind: 'ticket', field: 'status' },
    { kind: 'ticket', field: 'assignee' },
    { kind: 'ticket', field: 'cf[41]' },
    { kind: 'total', fn: 'sum', of: 'originalEstimate' },
    { kind: 'total', fn: 'sum', of: 'cf[41]' },
    { kind: 'total', fn: 'progress' },
    {
      kind: 'formula',
      name: 'Points below',
      expression: 'sum(children.{cf[41]})',
      output: 'number',
      decimals: 0,
    },
  ],
};

export const BY_STATUS: StructureSpec = {
  steps: [{ kind: 'insert' }, { kind: 'group', field: 'status' }, { kind: 'children' }],
  columns: DEFAULT_STRUCTURE.columns,
};

const sampleSkeleton = (rows: SampleRow[]): GridSkeleton => skeletonOf(rows, GRID_FIELDS);

/** The sample's tickets in the search route's shape. */
export function sampleTickets(rows: readonly SampleRow[] = SAMPLE_ROWS): SearchTicket[] {
  return rows
    .filter((r) => r.ticket > 0)
    .map((r) => {
      const stage = r.stage ?? 'new';
      const estimate = r.values?.originalEstimate;
      const points = r.values?.['cf[41]'];
      return {
        id: r.ticket,
        key: r.key ?? `T-${r.ticket}`,
        summary: r.summary ?? `Ticket ${r.ticket}`,
        status: {
          name: stage === 'new' ? 'New' : stage === 'active' ? 'Active' : 'Closed',
          stage,
        },
        ticketType: { name: r.level === 1 ? 'Outcome' : r.level === -1 ? 'Subticket' : 'Feature' },
        assignee: r.assignee ? { id: r.assignee.length, name: r.assignee } : null,
        priority: { id: 2, name: 'Medium' },
        labels: [],
        fields: points === null || points === undefined ? {} : { '41': points },
        timeTracking: {
          originalEstimate: typeof estimate === 'number' ? estimate : null,
          remainingEstimate: null,
          timeSpent: 0,
        },
        version: 1,
        updatedAt: '2026-11-10T08:00:00Z',
      } satisfies SearchTicket;
    });
}

/** A ticket made up for a row of a large skeleton. */
const madeUp = (id: number, key: string): SearchTicket => ({
  id,
  key,
  summary: `Work item ${id}`,
  status: { name: id % 3 === 0 ? 'Closed' : 'Active', stage: id % 3 === 0 ? 'closed' : 'active' },
  ticketType: { name: 'Feature' },
  assignee: null,
  priority: { id: 2, name: 'Medium' },
  labels: [],
  fields: {},
  timeTracking: { originalEstimate: null, remainingEstimate: null, timeSpent: 0 },
  version: 1,
  updatedAt: '2026-11-10T08:00:00Z',
});

export interface FakeGridOptions {
  /** Saved structures; none shows the default. */
  structures?: { id: number; name: string; spec: StructureSpec; broken?: boolean }[];
  editable?: boolean;
  /** The rows every structure reads; the sample by default, `grouped` for the status grouping. */
  skeleton?: GridSkeleton | 'grouped' | 'empty' | number;
  /** Reads of the skeleton run too long (503 `query_timeout`) until `fixed` is called. */
  timeout?: boolean;
  /** Problems of the structure for this viewer. */
  problems?: StructureProblem[];
  /** The rows are cut at the limit. */
  more?: boolean;
}

export interface FakeGridClient extends GridClient {
  calls: {
    rows: { sid: number | 'default'; at: GridAt }[];
    tickets: number[][];
    created: { name: string; spec: StructureSpec }[];
    changed: { sid: number; change: object }[];
  };
  /** Tickets as the fake backend holds them, edited by the search client's `edit`. */
  store: Map<number, SearchTicket>;
  /** The search client whose edits change the store, for the page's cells. */
  search: SearchClient;
  /** Reads stop running too long. */
  fixed: () => void;
}

/** Sorts a formula's text into a check: any expression naming `nope` fails at that word. */
function check(expression: string): FormulaCheck {
  const at = expression.indexOf('nope');
  return at < 0
    ? { ok: true, type: 'number' }
    : {
        ok: false,
        error: {
          code: 'unknown_field',
          message: 'No field is called nope',
          start: at,
          end: at + 4,
        },
      };
}

const refused = <T>(code: string, extra: object = {}): StructureOutcome<T> => ({
  ok: false,
  code,
  fields: {},
  ...extra,
});

export function fakeGridClient(options: FakeGridOptions = {}): FakeGridClient {
  const editable = options.editable ?? true;
  let structures: StructureSummary[] = (options.structures ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    spec: s.spec,
    updatedAt: '2026-11-12T10:00:00Z',
    version: 1,
    broken: s.broken ?? false,
  }));
  let nextId = Math.max(0, ...structures.map((s) => s.id)) + 1;
  let generation = 0;
  let slow = options.timeout ?? false;
  const skeleton: GridSkeleton =
    typeof options.skeleton === 'number'
      ? bigSkeleton(options.skeleton)
      : options.skeleton === 'grouped'
        ? sampleSkeleton(GROUPED_ROWS)
        : options.skeleton === 'empty'
          ? sampleSkeleton([])
          : (options.skeleton ?? sampleSkeleton(SAMPLE_ROWS));
  if (options.more) skeleton.more = true;
  const store = new Map(sampleTickets().map((t) => [t.id, t]));
  const calls: FakeGridClient['calls'] = { rows: [], tickets: [], created: [], changed: [] };
  const named = (name: string, except: number | null) =>
    structures.some((s) => s.id !== except && s.name.toLowerCase() === name.trim().toLowerCase());
  const badFormula = (spec: StructureSpec): StructureOutcome<StructureSummary> | null => {
    const at = spec.columns.findIndex((c) => c.kind === 'formula' && !check(c.expression).ok);
    if (at < 0) return null;
    const column = spec.columns[at] as { expression: string };
    return refused('invalid_fields', {
      fields: { [`spec.columns.${at}.expression`]: 'unknown_field' },
      check: check(column.expression),
    });
  };
  const inner = fakeSearchClient();
  const search: SearchClient = {
    ...inner,
    fields: async () => [
      { id: 40, name: 'Customer', type: 'text' },
      { id: 41, name: 'Points', type: 'number' },
      { id: 42, name: 'Team', type: 'select' },
    ],
    edit: async (id, change) => {
      const found = store.get(id);
      if (!found) throw new ApiError(404, { error: 'not_found' });
      const c = change as Record<string, unknown>;
      if (c.version !== undefined && c.version !== found.version) {
        throw new ApiError(409, { error: 'version_conflict' });
      }
      if (found.status.stage === 'closed') {
        throw new ApiError(403, { error: 'forbidden', permission: 'edit' });
      }
      const next: SearchTicket = { ...found, version: (found.version ?? 1) + 1 };
      if (typeof c.summary === 'string') next.summary = c.summary;
      if (c.fields && typeof c.fields === 'object') {
        next.fields = { ...found.fields, ...(c.fields as Record<string, unknown>) };
      }
      store.set(id, next);
      return { ...next };
    },
  };
  const client: FakeGridClient = {
    calls,
    store,
    search,
    fixed: () => {
      slow = false;
    },
    list: async () => ({
      plan: { id: 12, name: 'Spring launch' },
      structures: structures.map((s) => ({ ...s })),
      editable,
      default: DEFAULT_STRUCTURE,
      limits: GRID_LIMITS,
    }),
    create: async (_planId, name, spec) => {
      calls.created.push({ name, spec });
      if (!editable) return refused('forbidden', { permission: 'edit_plan' });
      if (structures.length >= GRID_LIMITS.structures) {
        return refused('too_many_structures', { limit: GRID_LIMITS.structures });
      }
      if (named(name, null)) return refused('name_taken');
      const bad = badFormula(spec);
      if (bad) return bad;
      const made: StructureSummary = {
        id: nextId++,
        name: name.trim(),
        spec,
        updatedAt: '2026-11-14T09:00:00Z',
        version: 1,
        broken: false,
      };
      structures = [...structures, made];
      return { ok: true, value: { ...made } };
    },
    change: async (_planId, sid, change) => {
      calls.changed.push({ sid, change });
      const found = structures.find((s) => s.id === sid);
      if (!found) return refused('not_found');
      if (!editable) return refused('forbidden', { permission: 'edit_plan' });
      if (found.version !== change.version) return refused('version_conflict');
      if (change.name !== undefined && named(change.name, sid)) return refused('name_taken');
      if (change.spec) {
        const bad = badFormula(change.spec);
        if (bad) return bad;
      }
      const next: StructureSummary = {
        ...found,
        name: change.name?.trim() ?? found.name,
        spec: change.spec ?? found.spec,
        version: found.version + 1,
      };
      structures = structures.map((s) => (s.id === sid ? next : s));
      return { ok: true, value: { ...next } };
    },
    remove: async (_planId, sid, version) => {
      const found = structures.find((s) => s.id === sid);
      if (!found) return refused('not_found');
      if (found.version !== version) return refused('version_conflict');
      structures = structures.filter((s) => s.id !== sid);
      return { ok: true, value: null };
    },
    rows: async (_planId, sid, at) => {
      calls.rows.push({ sid, at });
      if (slow) throw new ApiError(503, { error: 'query_timeout' });
      const saved = sid === 'default' ? null : structures.find((s) => s.id === sid);
      if (sid !== 'default' && !saved) throw new ApiError(404, { error: 'not_found' });
      const problems = options.problems ?? [];
      generation += 1;
      const copy: GridSkeleton = JSON.parse(JSON.stringify(skeleton));
      return {
        ...copy,
        generation,
        plan: { id: 12, name: 'Spring launch' },
        structure: saved
          ? { id: saved.id, name: saved.name, spec: saved.spec, version: saved.version }
          : { id: null, name: null, spec: DEFAULT_STRUCTURE, version: null },
        ...(at.scenario !== undefined
          ? { scenario: { id: at.scenario, name: 'Faster' }, live: true }
          : {}),
        editable,
        broken: problems.length > 0,
        problems,
      } satisfies GridAnswer;
    },
    tickets: async (_planId, ids) => {
      calls.tickets.push([...ids]);
      if (ids.length > GRID_LIMITS.ids) {
        throw new ApiError(400, { error: 'invalid_fields', fields: { ids: 'too_big' } });
      }
      const keys = new Map(skeleton.rows.ticket.map((t, i) => [t, skeleton.rows.key[i] ?? '']));
      return ids.flatMap((id) => {
        const held = store.get(id);
        if (held) return [{ ...held }];
        const key = keys.get(id);
        if (key === undefined) return [];
        const made = madeUp(id, key);
        store.set(id, made);
        return [{ ...made }];
      });
    },
    checkFormula: async (expression: string, _output: OutputType) => check(expression),
    linkTypes: async () => GRID_LINK_TYPES,
    levels: async () => GRID_LEVELS,
  };
  return client;
}
