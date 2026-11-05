import {
  type Clause,
  clauses,
  type Expr,
  type FieldRef,
  lookupField,
  makeCatalogue,
  parseQuery,
  printQuery,
  type Query,
  toNative,
  type Value,
} from '@taskmoor/query';
import { RANK_DIGITS } from '../tickets/rank';
import {
  AGILE_CONFIGURATION_TABLES,
  AGILE_TABLES,
  COMPONENT_ASSIGNEE_TYPES,
  RANK_FIELD_TYPE,
  SPRINT_FIELD_TYPE,
} from './dc-backup/agile-format';
import type {
  StagedBoard,
  StagedComponent,
  StagedSprint,
  StagedVersion,
} from './dc-backup/stage-agile';
import type { StagedField } from './dc-backup/stage-fields';
import type { StagedIssue } from './dc-backup/stage-issues';
import { instantOf, targetShape } from './dc-fields';
import type { BoardCommand, Mapped, Ref, TicketCommand, Warning } from './model';

/**
 * Mapping a Data Center backup's boards, sprints, rank, versions and components (M1-093;
 * IMP-004; AGL-001 to AGL-011; ADR-095):
 *
 * - a version becomes a release of its track, a component an area;
 * - a board becomes a board of the first track its filter names, Scrum when its sprints are on,
 *   with its filter's query, a Kanban board's sub-query as its sub-filter, its columns with
 *   their statuses and limits, and its quick filters as board filters. Queries are read in the
 *   Jira-compatible dialect and stored in Taskmoor's names (`toNative`); custom fields keep the
 *   backup's ids until the loader maps them. ORDER BY is left out: a board orders by rank.
 *   Clauses Taskmoor cannot hold for an imported board (a saved filter by id, a sprint by id)
 *   leave that query out, and the board loader checks every query against the target before
 *   keeping it, so an app's field or function is reported, not stored;
 * - a sprint keeps its state, dates, goal and order, with the issues its sprint field names;
 * - an issue's rank becomes a ticket rank in the same order (`rankKey`), and its versions and
 *   components its target and found releases and areas.
 *
 * The plugin's own sprint and rank custom fields are not fields here: they are skipped, and
 * their values arrive as sprint membership and rank.
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** The plugin's sprint and rank fields are carried by sprints and rank, not as fields. */
export function agileField(f: StagedField): Mapped | null {
  if (f.typeKey === SPRINT_FIELD_TYPE) return { skip: 'sprint_field_as_sprints' };
  if (f.typeKey === RANK_FIELD_TYPE) return { skip: 'rank_field_as_rank' };
  return null;
}

/** A moment of the entities file as a date (`YYYY-MM-DD`), read as UTC. */
const dayOf = (time: string | null) => instantOf(time)?.slice(0, 10) ?? null;
const dayStart = (time: string | null) => {
  const day = dayOf(time);
  return day === null ? null : `${day}T00:00:00.000Z`;
};

export function mapRelease(v: StagedVersion): Mapped {
  const warnings: Warning[] = [];
  // The backup keeps no moment of shipping or archiving: the release date stands in.
  const day = dayStart(v.releaseDate) ?? dayStart(v.startDate);
  if ((v.released || v.archived) && day === null) warnings.push({ code: 'release_date_unknown' });
  return {
    command: {
      kind: 'release',
      track: ref('track', v.project),
      name: v.name,
      description: v.description,
      startDate: dayOf(v.startDate),
      releaseDate: dayOf(v.releaseDate),
      shippedAt: v.released ? day : null,
      archivedAt: v.archived ? day : null,
    },
    warnings,
  };
}

const DEFAULT_ASSIGNEES: Record<number, 'area_owner' | 'track_owner' | 'unassigned'> = {
  [COMPONENT_ASSIGNEE_TYPES.projectDefault]: 'track_owner',
  [COMPONENT_ASSIGNEE_TYPES.componentLead]: 'area_owner',
  [COMPONENT_ASSIGNEE_TYPES.projectLead]: 'track_owner',
  [COMPONENT_ASSIGNEE_TYPES.unassigned]: 'unassigned',
};

export function mapArea(c: StagedComponent): Mapped {
  const warnings: Warning[] = [];
  let defaultAssignee = c.assigneeType === null ? undefined : DEFAULT_ASSIGNEES[c.assigneeType];
  if (defaultAssignee === undefined) {
    if (c.assigneeType !== null)
      warnings.push({ code: 'unknown_assignee_type', detail: String(c.assigneeType) });
    defaultAssignee = 'track_owner';
  }
  return {
    command: {
      kind: 'area',
      track: ref('track', c.project),
      name: c.name,
      description: c.description,
      owner: c.lead === null ? null : ref('user', c.lead),
      defaultAssignee,
      archivedAt: null,
    },
    warnings,
  };
}

// --- Queries ---------------------------------------------------------------------------------

/**
 * A query read in either dialect and written in Taskmoor's names, or why it cannot be. `shared`
 * holds the names it keeps that several custom fields of the backup have, in lower case, with
 * their ids; absent for none.
 */
export type Translated =
  | { query: string; fields: string[]; shared?: Record<string, string[]> }
  | { query: null; problem: string };

function walkValues(values: readonly Value[], visit: (v: Value) => void): void {
  for (const v of values) {
    visit(v);
    if (v.kind === 'function') walkValues(v.args, visit);
  }
}

function clauseValues(c: Clause): readonly Value[] {
  switch (c.kind) {
    case 'compare':
      return [c.value];
    case 'in':
    case 'was':
      return c.values;
    default:
      return [];
  }
}

const SYSTEM_ONLY = makeCatalogue();

/**
 * The query with each custom field it names by name named by the backup's id instead (T-195):
 * the loader maps ids, while a name would be read against the target's fields, where it may
 * belong to another field (the Points every workspace starts with, when the backup's field
 * arrived as "Points (imported)"). System fields win over custom fields of the same name, as
 * in the query language. A name no custom field of the backup has is left as it is, for the
 * board loader's check. A name several have stays a name too, listed in `shared` with their ids:
 * the import often makes them one field (a field joins one of its name and type), and only the
 * loader knows whether it did (`load-agile.ts`).
 */
function byFieldIds(
  expr: Expr | null,
  fieldsNamed: Readonly<Record<string, readonly string[]>>,
): { expr: Expr | null; shared: Record<string, string[]> } {
  const shared: Record<string, string[]> = {};
  const field = (f: FieldRef): FieldRef => {
    if (f.custom !== undefined || f.property || lookupField(SYSTEM_ONLY, f)) return f;
    const ids = fieldsNamed[f.name.toLowerCase()] ?? [];
    if (ids.length > 1) shared[f.name.toLowerCase()] = [...ids];
    const only = ids.length === 1 ? Number(ids[0]) : Number.NaN;
    return Number.isSafeInteger(only) ? { name: 'cf', custom: only, span: f.span } : f;
  };
  const visit = (e: Expr): Expr => {
    switch (e.kind) {
      case 'and':
      case 'or':
        return { ...e, items: e.items.map(visit) };
      case 'not':
        return { ...e, expr: visit(e.expr) };
      default:
        return { ...e, field: field(e.field) };
    }
  };
  return { expr: expr === null ? null : visit(expr), shared };
}

/**
 * A board's query in Taskmoor's names (`toNative`), ORDER BY left out (a board shows its cards
 * in rank order). Custom fields keep the backup's ids, listed in `fields` for the loader to map;
 * those named by name are named by id first (`fieldsNamed`: the backup's custom field ids by
 * lower-case name), unless several have the name (`shared`). A saved filter or a sprint named by
 * id cannot be kept: ids of the backup mean nothing here.
 */
export function translateQuery(
  text: string,
  fieldsNamed: Readonly<Record<string, readonly string[]>> = {},
): Translated {
  let parsed: Query;
  try {
    parsed = toNative(parseQuery(text));
  } catch {
    return { query: null, problem: 'query_not_parsed' };
  }
  const named = byFieldIds(parsed.where, fieldsNamed);
  parsed = { ...parsed, where: named.expr };
  const fields: string[] = [];
  const field = (f: FieldRef) => {
    if (f.custom !== undefined && !fields.includes(String(f.custom))) fields.push(String(f.custom));
  };
  for (const c of clauses(parsed.where)) {
    field(c.field);
    const name = c.field.custom === undefined ? c.field.name : '';
    const values = clauseValues(c);
    if (name === 'savedSearch') return { query: null, problem: 'query_names_saved_filter' };
    let byId = false;
    walkValues(values, (v) => {
      if (name === 'sprint' && v.kind === 'number') byId = true;
    });
    if (byId) return { query: null, problem: 'query_names_sprint_by_id' };
  }
  if (parsed.where === null) return { query: null, problem: 'query_empty' };
  const query = printQuery({ where: parsed.where, orderBy: [] });
  return Object.keys(named.shared).length === 0
    ? { query, fields }
    : { query, fields, shared: named.shared };
}

/**
 * Whether the backup's custom fields of one name become one field here: they do when they have
 * one type and multiplicity, as a field joins one of its name and shape (`load-config.ts`).
 */
function oneShape(ids: readonly string[], types: Readonly<Record<string, string>>): boolean {
  const shapes = ids.map((id) => targetShape(types[id] ?? null));
  const [first] = shapes;
  return shapes.every(
    (s) => s !== null && first != null && s.type === first.type && s.multiple === first.multiple,
  );
}

/** The custom field ids a translated query names, as references. */
const fieldRefs = (ids: readonly string[]): Ref[] => ids.map((id) => ref('field', id));

const MAX_NAME = 255;
const MAX_QUERY = 10_000;

export function mapBoard(b: StagedBoard): Mapped {
  const warnings: Warning[] = [];
  const track = b.projects[0];
  if (track === undefined) {
    // Nothing says where the board lives: its filter names no project the backup holds.
    return { fail: b.filter === null ? 'board_filter_missing' : 'board_project_unknown' };
  }
  for (const name of b.unknownProjects)
    warnings.push({ code: 'board_project_unknown', detail: name });
  const fields = new Set<string>();
  const shared = new Map<string, string[]>();
  // A query left out names its filter (if any) and why (IMP-006 (2)).
  const keep = (text: string | null, what: string, name?: string): string | null => {
    if (text === null) return null;
    const t = translateQuery(text, b.fieldsNamed);
    const problem = t.query === null ? t.problem : t.query.length > MAX_QUERY ? 'too_long' : null;
    if (t.query === null || problem !== null) {
      const detail = name === undefined ? problem : `${name}: ${problem}`;
      warnings.push({ code: `${what}_not_imported`, ...(detail ? { detail } : {}) });
      return null;
    }
    for (const f of t.fields) fields.add(f);
    for (const [n, ids] of Object.entries(t.shared ?? {})) shared.set(n, ids);
    return t.query;
  };
  if (b.filter === null) warnings.push({ code: 'board_filter_missing', detail: b.filterId ?? '' });
  const query = b.filter === null ? null : keep(b.filter.query, 'board_query');
  const subQuery = keep(b.subQuery, 'board_sub_query');
  const boardFilters: NonNullable<BoardCommand['boardFilters']> = [];
  for (const q of b.quickFilters.slice(0, 30)) {
    const name = q.name.trim().slice(0, MAX_NAME);
    const text = keep(q.query, 'board_filter', name || q.id);
    if (text === null || name === '') continue;
    boardFilters.push({ name, query: text, description: q.description.slice(0, 1000) });
  }
  if (b.quickFilters.length > 30) {
    warnings.push({ code: 'board_filters_over_limit', detail: String(b.quickFilters.length) });
  }
  const columns: BoardCommand['columns'] = [];
  for (const c of b.columns.slice(0, 30)) {
    for (const s of c.unknownStatuses) warnings.push({ code: 'column_status_unknown', detail: s });
    const whole = (n: number | null) =>
      n === null || n < 0 ? null : Math.min(1_000_000, Math.round(n));
    let min = whole(c.min);
    const max = whole(c.max);
    if (min !== null && max !== null && min > max) {
      warnings.push({ code: 'column_minimum_above_maximum', detail: c.name });
      min = null;
    }
    columns.push({
      name: c.name.trim().slice(0, MAX_NAME) || `Column ${columns.length + 1}`,
      statuses: c.statuses.map((s) => ref('status', s)),
      min,
      max,
    });
  }
  if (b.columns.length > 30) warnings.push({ code: 'columns_over_limit' });
  if (columns.length === 0) warnings.push({ code: 'board_without_columns' });
  return {
    command: {
      kind: 'board',
      name: b.name.trim().slice(0, MAX_NAME),
      description: '',
      boardKind: b.scrum ? 'scrum' : 'kanban',
      track: ref('track', track),
      query,
      columns,
      subQuery,
      boardFilters,
      fields: fieldRefs([...fields]),
      ...(shared.size === 0
        ? {}
        : {
            sharedNames: [...shared].map(([n, ids]) => ({
              name: n,
              fields: fieldRefs(ids),
              ...(b.fieldTypes === undefined ? {} : { oneShape: oneShape(ids, b.fieldTypes) }),
            })),
          }),
    },
    warnings,
  };
}

export function mapSprint(s: StagedSprint): Mapped {
  const warnings: Warning[] = [];
  // A started sprint that is not closed is active; a closed one is complete (format notes 4).
  const state = s.closed ? 'closed' : s.started ? 'active' : 'future';
  if (s.closed && !s.started) warnings.push({ code: 'closed_sprint_never_started' });
  let startAt = s.start;
  let endAt = s.end;
  if (startAt !== null && endAt !== null && endAt < startAt) {
    warnings.push({ code: 'sprint_end_before_start' });
    endAt = null;
  }
  if (state === 'future' && (startAt === null) !== (endAt === null)) {
    startAt = null;
    endAt = null;
  }
  return {
    command: {
      kind: 'sprint',
      board: ref('board', s.board),
      name: s.name.trim().slice(0, MAX_NAME) || `Sprint ${s.sequence ?? s.id}`,
      goal: s.goal,
      state,
      startAt,
      endAt,
      // The backup keeps the planned start; it stands in for when the sprint was started.
      startedAt: state === 'future' ? null : startAt,
      completedAt: state === 'closed' ? (s.complete ?? endAt) : null,
      tickets: s.issues.map((i) => ref('ticket', i)),
    },
    warnings,
  };
}

// --- Rank ------------------------------------------------------------------------------------

/** The characters a rank uses (Verify), in the order plain text compares them. */
const SOURCE_RANK = '0123456789:abcdefghijklmnopqrstuvwxyz|';

/**
 * A Taskmoor rank key that sorts among the others exactly as the backup's rank does among
 * its others: the integer part `a1`, then each character of the source rank as the next rank
 * digit in the same order (no character maps to the digit 0, so a key never ends with one).
 * Null for a rank with a character outside the alphabet.
 */
export function rankKey(source: string): string | null {
  let out = 'a1';
  for (const ch of source.toLowerCase()) {
    const k = SOURCE_RANK.indexOf(ch);
    if (k < 0) return null;
    out += RANK_DIGITS[k + 1];
  }
  return source === '' ? null : out;
}

/** The parts of a ticket command this part maps: releases, areas and rank. */
export function agileTicket(i: StagedIssue, warnings: Warning[]): Partial<TicketCommand> {
  const a = i.agile;
  if (!a) return {};
  const out: Partial<TicketCommand> = {
    releases: {
      target: a.fixVersions.map((v) => ref('release', v)),
      found: a.affectsVersions.map((v) => ref('release', v)),
    },
    areas: a.components.map((c) => ref('area', c)),
  };
  if (a.rank !== null) {
    const key = rankKey(a.rank);
    if (key === null) warnings.push({ code: 'rank_not_kept' });
    else out.rank = key;
  }
  return out;
}

// --- What is left out --------------------------------------------------------------------------

/**
 * How the report counts an agile table: null when every row was read; else its count and why.
 * A configuration-only import reads boards but not their sprints or the issues' rank.
 */
export function agileTableLeftOut(
  table: string,
  count: number,
  partial: number,
  scope: 'all' | 'tickets' | 'configuration',
): { count: number; reason: string } | null | undefined {
  if (!AGILE_TABLES.has(table)) return undefined;
  if (scope === 'configuration' && !AGILE_CONFIGURATION_TABLES.has(table)) {
    return count > 0 ? { count, reason: 'configuration_only' } : null;
  }
  return partial > 0 ? { count: partial, reason: 'not_imported_yet' } : null;
}
