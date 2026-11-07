import {
  AGILE_TABLES,
  fieldNamesIn,
  ISSUE_ASSOCIATIONS,
  projectsNamed,
  RANK_FIELD_TYPE,
  RANK_ROW_ISSUE,
  SPRINT_FIELD_TYPE,
} from './agile-format';
import { byId } from './spill';
import type { StagedField } from './stage-fields';
import type { StagedIssue, StagedIssueAgile } from './stage-issues';

/**
 * The agile part of the stage (M1-093; IMP-004; ADR-095): versions and components as records
 * of their own, boards with their filter's query, columns, quick filters and sub-query, sprints
 * with the issues in them, and on each issue its versions, components and rank.
 *
 * Versions, components, boards, columns, quick filters and sprints are small and kept in memory.
 * The rows that belong to one issue (its version and component associations and its rank row)
 * go into the issue part's ticket buckets as extras (`IssueCollector.extra`) and are folded
 * into the issue's record when its bucket is joined (`extend`); its sprint values arrive there
 * as custom values of the sprint field, which `extend` takes out of the values. Memory grows by
 * one entry per issue in a sprint (the sprints' member lists) and nothing else per issue.
 *
 * This is the format layer: records keep the backup's vocabulary; `../dc-agile.ts` maps them.
 */

/** The staged kinds of this part, with the element or table each comes from. */
export const AGILE_STAGED_KINDS = {
  release: 'Version',
  area: 'Component',
  board: 'AO_60DB71_RAPIDVIEW',
  sprint: 'AO_60DB71_SPRINT',
} as const;

export interface StagedVersion {
  id: string;
  project: string;
  name: string;
  description: string;
  sequence: number | null;
  released: boolean;
  archived: boolean;
  startDate: string | null;
  releaseDate: string | null;
}

export interface StagedComponent {
  id: string;
  project: string;
  name: string;
  description: string;
  /** Staged id of the lead (lower-case user key). */
  lead: string | null;
  assigneeType: number | null;
}

export interface StagedColumn {
  id: string;
  name: string;
  min: number | null;
  max: number | null;
  /** Status ids with a row, in their order. */
  statuses: string[];
  /** Status ids the column names that have no row. */
  unknownStatuses: string[];
}

export interface StagedQuickFilter {
  id: string;
  name: string;
  query: string;
  description: string;
}

export interface StagedBoard {
  id: string;
  name: string;
  /** Sprints enabled: a Scrum board; otherwise Kanban (Verify). */
  scrum: boolean;
  /** The saved filter the board shows; null when its row is missing. */
  filter: { id: string; name: string; query: string } | null;
  filterId: string | null;
  /** The projects the filter names, by id, the first being where the board lives. */
  projects: string[];
  /** Names in the filter's project clauses that name no project. */
  unknownProjects: string[];
  subQuery: string | null;
  columns: StagedColumn[];
  quickFilters: StagedQuickFilter[];
  /**
   * The backup's custom fields its queries name by name (filter, sub-query, quick filters):
   * each name in lower case with the ids of the custom fields that have it (T-195). Absent in
   * records staged before it was kept.
   */
  fieldsNamed?: Record<string, string[]>;
  /**
   * The type keys of the custom fields in `fieldsNamed` that share a name, by id: whether the
   * import makes them one field or several depends on them (T-195). Absent when no name is
   * shared, and in records staged before it was kept.
   */
  fieldTypes?: Record<string, string>;
}

export interface StagedSprint {
  id: string;
  board: string;
  name: string;
  goal: string;
  started: boolean;
  closed: boolean;
  start: string | null;
  end: string | null;
  complete: string | null;
  sequence: number | null;
  /** The issues whose sprint field names the sprint, by id. */
  issues: string[];
}

/** Rows of an issue this part puts in the ticket buckets. */
type Extra =
  | ['A', type: string, entity: string, sink: string]
  | ['R', field: string, rank: string, id: string];

/** What the stage resolves after the file, for this part to name things by. */
export interface AgileResolve {
  person: (raw: string) => string;
  /** Project ids by id, key (any case, earlier keys too) or name. */
  project: (named: string) => string | null;
  /** A project's key now, by id, for labels. */
  projectKey: (id: string) => string | null;
  statuses: ReadonlySet<string>;
  /** The ids of the backup's custom fields with a name, any case; empty for none. */
  fieldsNamed: (name: string) => string[];
  /** A custom field's type key, by id; null for none. */
  fieldType: (id: string) => string | null;
}

const int = (v: string | null | undefined): number | null =>
  v != null && /^-?\d+$/.test(v) ? Number(v) : null;
const num = (v: string | null | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Milliseconds since 1970, as the agile tables store moments (Verify), as an instant. */
const millis = (v: string | null | undefined): string | null => {
  const n = int(v);
  return n === null ? null : new Date(n).toISOString();
};
const truthy = (v: string | null | undefined) => v === 'true' || v === '1';

export class AgileCollector {
  private readonly versions: StagedVersion[] = [];
  private readonly components: (StagedComponent & { rawLead: string | null })[] = [];
  private readonly filters = new Map<string, { name: string; query: string }>();
  private readonly boards: Record<string, string | null>[] = [];
  private readonly columns: Record<string, string | null>[] = [];
  private readonly columnStatuses: Record<string, string | null>[] = [];
  private readonly quickFilters: Record<string, string | null>[] = [];
  private readonly subQueries: Record<string, string | null>[] = [];
  private readonly sprints: Record<string, string | null>[] = [];
  /** Issues per sprint, from the sprint field's values. */
  private readonly members = new Map<string, string[]>();
  /** Rows of consumed elements and tables left out, by name. */
  readonly partial: Record<string, number> = {};
  /** Issue rows a configuration-only import leaves out, counted for its report. */
  issueAssociations = 0;
  rankRows = 0;

  private leaveOut(name: string, by = 1): void {
    this.partial[name] = (this.partial[name] ?? 0) + by;
  }

  /** Reads an entities row; true when this part consumes it. */
  row(
    name: string,
    v: Record<string, string>,
    extra: (issue: string, row: Extra) => void,
  ): boolean {
    switch (name) {
      case 'Version':
        this.versions.push({
          id: v.id ?? '',
          project: v.project ?? '',
          name: v.name ?? '',
          description: v.description ?? '',
          sequence: int(v.sequence),
          released: truthy(v.released),
          archived: truthy(v.archived),
          startDate: v.startdate ?? null,
          releaseDate: v.releasedate ?? null,
        });
        return true;
      case 'Component':
        this.components.push({
          id: v.id ?? '',
          project: v.project ?? '',
          name: v.name ?? '',
          description: v.description ?? '',
          lead: null,
          rawLead: v.lead ?? null,
          assigneeType: int(v.assigneetype),
        });
        return true;
      case 'SearchRequest':
        // Read for the boards' filters; the element itself is saved filters' (M1-094).
        this.filters.set(v.id ?? '', { name: v.name ?? '', query: v.request ?? '' });
        return false;
      case 'NodeAssociation': {
        if (v.sourceNodeEntity !== 'Issue') return false;
        const type = v.associationType ?? '';
        const known = (Object.values(ISSUE_ASSOCIATIONS) as string[]).includes(type);
        if (!known) return false;
        this.issueAssociations++;
        extra(v.sourceNodeId ?? '', ['A', type, v.sinkNodeEntity ?? '', v.sinkNodeId ?? '']);
        return true;
      }
    }
    return false;
  }

  /** Reads an active-objects row (values by column); true when this part consumes the table. */
  aoRow(
    table: string,
    v: Record<string, string | null>,
    extra: (issue: string, row: Extra) => void,
  ): boolean {
    if (!AGILE_TABLES.has(table)) return false;
    switch (table) {
      case 'AO_60DB71_RAPIDVIEW':
        this.boards.push(v);
        break;
      case 'AO_60DB71_COLUMN':
        this.columns.push(v);
        break;
      case 'AO_60DB71_COLUMNSTATUS':
        this.columnStatuses.push(v);
        break;
      case 'AO_60DB71_QUICKFILTER':
        this.quickFilters.push(v);
        break;
      case 'AO_60DB71_SUBQUERY':
        this.subQueries.push(v);
        break;
      case 'AO_60DB71_SPRINT':
        this.sprints.push(v);
        break;
      case 'AO_60DB71_LEXORANK':
        // Marker rows of the rank's own bookkeeping carry no issue (Verify).
        if ((int(v.TYPE) ?? RANK_ROW_ISSUE) !== RANK_ROW_ISSUE || !v.ISSUE_ID || !v.RANK) {
          this.leaveOut(table);
          break;
        }
        this.rankRows++;
        extra(v.ISSUE_ID, ['R', v.FIELD_ID ?? '', v.RANK, v.ID ?? '']);
        break;
    }
    return true;
  }

  /**
   * Folds an issue's extras and sprint values into its ticket record, once the fields are known.
   * Called for every issue, in id order within a bucket.
   */
  extender(fields: ReadonlyMap<string, StagedField>) {
    const sprintFields = new Set<string>();
    const rankFields: string[] = [];
    for (const f of [...fields.values()].sort((a, b) => byId(a.id, b.id))) {
      if (f.typeKey === SPRINT_FIELD_TYPE) sprintFields.add(f.id);
      if (f.typeKey === RANK_FIELD_TYPE) rankFields.push(f.id);
    }
    const versions = new Map(this.versions.map((x) => [x.id, x.project]));
    const components = new Map(this.components.map((x) => [x.id, x.project]));
    const sprints = new Set(this.sprints.map((s) => s.ID ?? ''));
    return (issue: StagedIssue, extras: readonly unknown[]): void => {
      const agile: StagedIssueAgile = {
        fixVersions: [],
        affectsVersions: [],
        components: [],
        rank: null,
      };
      const ranks: { field: string; rank: string; id: string }[] = [];
      for (const e of extras as Extra[]) {
        if (e[0] === 'R') {
          ranks.push({ field: e[1], rank: e[2], id: e[3] });
          continue;
        }
        const [, type, entity, sink] = e;
        const owner = (entity === 'Component' ? components : versions).get(sink);
        // An issue names versions and components of its own project.
        if (owner === undefined || owner !== issue.project) {
          this.leaveOut('NodeAssociation');
          continue;
        }
        const list =
          type === ISSUE_ASSOCIATIONS.component && entity === 'Component'
            ? agile.components
            : type === ISSUE_ASSOCIATIONS.fixVersion && entity === 'Version'
              ? agile.fixVersions
              : type === ISSUE_ASSOCIATIONS.affectsVersion && entity === 'Version'
                ? agile.affectsVersions
                : null;
        if (list === null) this.leaveOut('NodeAssociation');
        else if (!list.includes(sink)) list.push(sink);
      }
      // The rank of the rank field with the lowest id; without one, of the lowest field id.
      if (ranks.length > 0) {
        ranks.sort((a, b) => byId(a.field, b.field) || byId(a.id, b.id));
        const field = rankFields.find((f) => ranks.some((r) => r.field === f)) ?? ranks[0]?.field;
        const chosen = ranks.find((r) => r.field === field);
        agile.rank = chosen?.rank ?? null;
        if (ranks.length > 1) this.leaveOut('AO_60DB71_LEXORANK', ranks.length - 1);
      }
      // Sprint values become membership of the sprints; the field itself is not a field here.
      if (issue.values.some((v) => sprintFields.has(v.field) || rankFields.includes(v.field))) {
        const kept: StagedIssue['values'] = [];
        for (const value of issue.values) {
          if (rankFields.includes(value.field)) {
            this.leaveOut('CustomFieldValue', value.rows.length);
            continue;
          }
          if (!sprintFields.has(value.field)) {
            kept.push(value);
            continue;
          }
          for (const row of value.rows) {
            const n = row.number ?? num(row.string);
            const id = n === null || !Number.isInteger(n) ? null : String(n);
            if (id === null || !sprints.has(id)) {
              this.leaveOut('CustomFieldValue');
              continue;
            }
            const list = this.members.get(id) ?? [];
            this.members.set(id, list);
            // Issues come one at a time: a repeat of the same sprint is the last entry.
            if (list[list.length - 1] !== issue.id) list.push(issue.id);
          }
        }
        issue.values = kept;
      }
      issue.agile = agile;
    };
  }

  /** Release and area records, with references resolved. */
  configuration(resolve: AgileResolve): {
    release: { id: string; label: string; data: StagedVersion }[];
    area: { id: string; label: string; data: StagedComponent }[];
  } {
    const order = <T extends { project: string; id: string }>(rows: T[], seq: (r: T) => number) =>
      [...rows].sort((a, b) => byId(a.project, b.project) || seq(a) - seq(b) || byId(a.id, b.id));
    return {
      release: order(this.versions, (v) => v.sequence ?? Number.MAX_SAFE_INTEGER).map((v) => ({
        id: v.id,
        label: `${resolve.projectKey(v.project) ?? v.project}: ${v.name}`,
        data: v,
      })),
      area: order(this.components, () => 0).map(({ rawLead, ...c }) => ({
        id: c.id,
        label: `${resolve.projectKey(c.project) ?? c.project}: ${c.name}`,
        data: { ...c, lead: rawLead ? resolve.person(rawLead) : null },
      })),
    };
  }

  /** Board records, with their filter, columns, quick filters and sub-query. */
  boardRecords(resolve: AgileResolve): { id: string; label: string; data: StagedBoard }[] {
    const boards = new Set(this.boards.map((b) => b.ID ?? ''));
    const statusesOf = new Map<string, Record<string, string | null>[]>();
    const columnIds = new Set(this.columns.map((c) => c.ID ?? ''));
    for (const s of this.columnStatuses) {
      const column = s.COLUMN_ID ?? '';
      if (!columnIds.has(column)) {
        this.leaveOut('AO_60DB71_COLUMNSTATUS');
        continue;
      }
      const list = statusesOf.get(column) ?? [];
      statusesOf.set(column, list);
      list.push(s);
    }
    const ofBoard = (rows: Record<string, string | null>[], table: string) => {
      const out = new Map<string, Record<string, string | null>[]>();
      for (const r of rows) {
        const board = r.RAPID_VIEW_ID ?? '';
        if (!boards.has(board)) {
          this.leaveOut(table);
          continue;
        }
        const list = out.get(board) ?? [];
        out.set(board, list);
        list.push(r);
      }
      const pos = (r: Record<string, string | null>) => int(r.POS) ?? Number.MAX_SAFE_INTEGER;
      for (const list of out.values()) {
        list.sort((a, b) => pos(a) - pos(b) || byId(a.ID ?? '', b.ID ?? ''));
      }
      return out;
    };
    const columns = ofBoard(this.columns, 'AO_60DB71_COLUMN');
    const quick = ofBoard(this.quickFilters, 'AO_60DB71_QUICKFILTER');
    const sub = ofBoard(this.subQueries, 'AO_60DB71_SUBQUERY');
    const out: { id: string; label: string; data: StagedBoard }[] = [];
    for (const b of [...this.boards].sort((x, y) => byId(x.ID ?? '', y.ID ?? ''))) {
      const id = b.ID ?? '';
      const filterId = b.SAVED_FILTER_ID ?? null;
      const found = filterId === null ? undefined : this.filters.get(filterId);
      const named = found ? (projectsNamed(found.query) ?? []) : [];
      const projects: string[] = [];
      const unknownProjects: string[] = [];
      for (const n of named) {
        const p = resolve.project(n);
        if (p === null) unknownProjects.push(n);
        else if (!projects.includes(p)) projects.push(p);
      }
      const subRows = sub.get(id) ?? [];
      if (subRows.length > 1) this.leaveOut('AO_60DB71_SUBQUERY', subRows.length - 1);
      const data: StagedBoard = {
        id,
        name: b.NAME ?? '',
        scrum: truthy(b.SPRINTS_ENABLED),
        filter: found && filterId !== null ? { id: filterId, ...found } : null,
        filterId,
        projects,
        unknownProjects,
        subQuery: subRows[0]?.QUERY ?? null,
        columns: (columns.get(id) ?? []).map((c) => {
          const rows = [...(statusesOf.get(c.ID ?? '') ?? [])].sort(
            (x, y) => (int(x.POS) ?? 0) - (int(y.POS) ?? 0) || byId(x.ID ?? '', y.ID ?? ''),
          );
          const statuses: string[] = [];
          const unknownStatuses: string[] = [];
          for (const r of rows) {
            const s = r.STATUS_ID ?? '';
            if (resolve.statuses.has(s)) statuses.push(s);
            else unknownStatuses.push(s);
          }
          return {
            id: c.ID ?? '',
            name: c.NAME ?? '',
            min: num(c.MINIM),
            max: num(c.MAXIM),
            statuses,
            unknownStatuses,
          };
        }),
        quickFilters: (quick.get(id) ?? []).map((q) => ({
          id: q.ID ?? '',
          name: q.NAME ?? '',
          query: q.QUERY ?? '',
          description: q.DESCRIPTION ?? '',
        })),
      };
      const fieldsNamed: Record<string, string[]> = {};
      const fieldTypes: Record<string, string> = {};
      const queries = [data.filter?.query, data.subQuery, ...data.quickFilters.map((q) => q.query)];
      for (const text of queries) {
        for (const name of (text && fieldNamesIn(text)) || []) {
          const ids = resolve.fieldsNamed(name);
          if (ids.length > 0) fieldsNamed[name.toLowerCase()] = ids;
          if (ids.length < 2) continue;
          for (const field of ids) {
            const type = resolve.fieldType(field);
            if (type !== null) fieldTypes[field] = type;
          }
        }
      }
      if (Object.keys(fieldsNamed).length > 0) data.fieldsNamed = fieldsNamed;
      if (Object.keys(fieldTypes).length > 0) data.fieldTypes = fieldTypes;
      out.push({ id, label: data.name, data });
    }
    return out;
  }

  /** Sprint records with their issues; call after every ticket bucket was joined. */
  sprintRecords(): { id: string; label: string; data: StagedSprint }[] {
    const seq = (s: Record<string, string | null>) => int(s.SEQUENCE) ?? Number.MAX_SAFE_INTEGER;
    return [...this.sprints]
      .sort(
        (a, b) =>
          byId(a.RAPID_VIEW_ID ?? '', b.RAPID_VIEW_ID ?? '') ||
          seq(a) - seq(b) ||
          byId(a.ID ?? '', b.ID ?? ''),
      )
      .map((s) => {
        const id = s.ID ?? '';
        const data: StagedSprint = {
          id,
          board: s.RAPID_VIEW_ID ?? '',
          name: s.NAME ?? '',
          goal: s.GOAL ?? '',
          started: truthy(s.STARTED),
          closed: truthy(s.CLOSED),
          start: millis(s.START_DATE),
          end: millis(s.END_DATE),
          complete: millis(s.COMPLETE_DATE),
          sequence: int(s.SEQUENCE),
          issues: [...(this.members.get(id) ?? [])].sort(byId),
        };
        return { id, label: data.name, data };
      });
  }
}
