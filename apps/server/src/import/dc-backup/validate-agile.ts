import {
  ISSUE_ASSOCIATIONS,
  projectsNamed,
  RANK_FIELD_TYPE,
  RANK_ROW_ISSUE,
  SPRINT_FIELD_TYPE,
} from './agile-format';

/**
 * The validator's checks of boards, sprints, rank, versions and components (M1-093): columns,
 * column statuses, quick filters and sub-queries name boards, columns and statuses that have
 * rows; an issue's versions and components have rows in the issue's own project; sprint values
 * name sprints, and an issue is in at most one sprint that is not closed; rank rows name issues
 * and a rank field, one row per issue and field. It counts the manifest's cases of this part
 * from what it reads, so the writer and the reader must agree. Memory: a few numbers per issue
 * association and per sprint value.
 */
interface Ids {
  has(id: number): boolean;
}

export interface AgileCheckContext {
  ids: (entity: string) => Ids | undefined;
  /** Issues' projects by id. */
  issueProject: (issue: number) => number | undefined;
}

type Problem = (message: string) => void;
type Note = (key: string, by?: number) => void;

const ASSOCIATION_CASES: Record<string, string> = {
  [ISSUE_ASSOCIATIONS.fixVersion]: 'issueFixVersions',
  [ISSUE_ASSOCIATIONS.affectsVersion]: 'issueAffectedVersions',
  [ISSUE_ASSOCIATIONS.component]: 'issueComponents',
};

export class AgileChecks {
  private readonly owner = new Map<string, Map<number, number>>([
    ['Version', new Map()],
    ['Component', new Map()],
  ]);
  private readonly associations: { issue: number; entity: string; id: number }[] = [];
  private readonly sprintFields = new Set<number>();
  private readonly rankFields = new Set<number>();
  /** Custom values as issue and field, until the fields are known. */
  private readonly values: { issue: number; field: number; sprint: number }[] = [];
  private readonly boards = new Map<number, { filter: number | null; scrum: boolean }>();
  private readonly columns = new Map<number, number>();
  private readonly columnStatuses: { column: number; status: string }[] = [];
  private readonly boardRefs: { table: string; board: number }[] = [];
  private readonly sprints = new Map<number, { closed: boolean }>();
  /** Saved filters' query text by id. */
  private readonly filters = new Map<number, string>();
  /** Cases counted from the active-objects rows, added to the others by `check`. */
  private readonly aoCases: Record<string, number> = {};
  /** Issues with a rank row, per rank field: a bitmap each. */
  private readonly ranks = new Map<number, Uint8Array>();

  /** Called for every entities row; reads the ones of this part. */
  row(name: string, v: Record<string, string>, note: Note): void {
    switch (name) {
      case 'Version':
        if (v.released === 'true') note('versionsReleased');
        if (v.archived === 'true') note('versionsArchived');
        this.owner.get(name)?.set(Number(v.id), Number(v.project));
        return;
      case 'Component':
        this.owner.get(name)?.set(Number(v.id), Number(v.project));
        return;
      case 'SearchRequest':
        this.filters.set(Number(v.id), v.request ?? '');
        return;
      case 'CustomField':
        if (v.customfieldtypekey === SPRINT_FIELD_TYPE) this.sprintFields.add(Number(v.id));
        if (v.customfieldtypekey === RANK_FIELD_TYPE) this.rankFields.add(Number(v.id));
        return;
      case 'CustomFieldValue': {
        const sprint = Number(v.numbervalue ?? v.stringvalue);
        if (Number.isInteger(sprint)) {
          this.values.push({ issue: Number(v.issue), field: Number(v.customfield), sprint });
        }
        return;
      }
      case 'NodeAssociation': {
        if (v.sourceNodeEntity !== 'Issue') return;
        const key = ASSOCIATION_CASES[v.associationType ?? ''];
        if (key) note(key);
        this.associations.push({
          issue: Number(v.sourceNodeId),
          entity: v.sinkNodeEntity ?? '',
          id: Number(v.sinkNodeId),
        });
        return;
      }
    }
  }

  /** Called for every active-objects row, values by column name. */
  aoRow(table: string, v: Record<string, string | null>, problem: Problem): void {
    const note = (key: string) => {
      this.aoCases[key] = (this.aoCases[key] ?? 0) + 1;
    };
    const n = (key: string) => (v[key] == null ? null : Number(v[key]));
    switch (table) {
      case 'AO_60DB71_RAPIDVIEW':
        this.boards.set(n('ID') ?? 0, {
          filter: n('SAVED_FILTER_ID'),
          scrum: v.SPRINTS_ENABLED === 'true',
        });
        note(v.SPRINTS_ENABLED === 'true' ? 'boardsScrum' : 'boardsKanban');
        return;
      case 'AO_60DB71_SPRINT':
        this.sprints.set(n('ID') ?? 0, { closed: v.CLOSED === 'true' });
        return;
      case 'AO_60DB71_COLUMN':
        this.columns.set(n('ID') ?? 0, n('RAPID_VIEW_ID') ?? 0);
        this.boardRefs.push({ table, board: n('RAPID_VIEW_ID') ?? 0 });
        note('boardColumns');
        if (v.MINIM != null || v.MAXIM != null) note('boardColumnLimits');
        return;
      case 'AO_60DB71_COLUMNSTATUS':
        this.columnStatuses.push({ column: n('COLUMN_ID') ?? 0, status: v.STATUS_ID ?? '' });
        return;
      case 'AO_60DB71_QUICKFILTER':
        this.boardRefs.push({ table, board: n('RAPID_VIEW_ID') ?? 0 });
        note('quickFilters');
        if (!v.QUERY) problem(`${table} ${v.ID}: no query`);
        return;
      case 'AO_60DB71_SUBQUERY':
        this.boardRefs.push({ table, board: n('RAPID_VIEW_ID') ?? 0 });
        note('subQueries');
        return;
      case 'AO_60DB71_LEXORANK':
        if (n('TYPE') === RANK_ROW_ISSUE) {
          const issue = n('ISSUE_ID') ?? 0;
          const field = n('FIELD_ID') ?? 0;
          let bits = this.ranks.get(field) ?? new Uint8Array(1 << 12);
          if (issue >>> 3 >= bits.length) {
            let length = bits.length;
            while (length <= issue >>> 3) length *= 2;
            const grown = new Uint8Array(length);
            grown.set(bits);
            bits = grown;
          }
          this.ranks.set(field, bits);
          const mask = 1 << (issue & 7);
          if ((bits[issue >>> 3] as number) & mask) {
            problem(`issue ${issue} has two rank rows for field ${field}`);
          }
          bits[issue >>> 3] = (bits[issue >>> 3] as number) | mask;
          note('issuesRanked');
          if (!v.RANK) problem(`${table} ${v.ID}: no rank`);
        }
        return;
    }
  }

  /** The checks that need both files. */
  check(ctx: AgileCheckContext, note: Note, problem: Problem): void {
    for (const [key, count] of Object.entries(this.aoCases)) note(key, count);
    const issues = ctx.ids('Issue');
    // Versions and components: rows of the issue's own project.
    let wrongProject = 0;
    for (const a of this.associations) {
      if (!issues?.has(a.issue)) {
        problem(`NodeAssociation names issue ${a.issue}, which has no row`);
        continue;
      }
      const owner = this.owner.get(a.entity);
      if (!owner) {
        problem(`NodeAssociation of issue ${a.issue} names ${a.entity.slice(0, 40)}`);
        continue;
      }
      const project = owner.get(a.id);
      if (project === undefined) problem(`NodeAssociation names ${a.entity} ${a.id}, no row`);
      else if (project !== ctx.issueProject(a.issue) && wrongProject++ === 0) {
        problem(`issue ${a.issue} names ${a.entity} ${a.id} of another project`);
      }
    }
    // Boards: their filters span projects; columns, statuses, filters and sub-queries name rows.
    for (const b of this.boards.values()) {
      const text = b.filter === null ? undefined : this.filters.get(b.filter);
      const projects = text === undefined ? null : projectsNamed(text);
      if (projects !== null && projects.length > 1) note('boardsAcrossProjects');
    }
    for (const r of this.boardRefs) {
      if (!this.boards.has(r.board)) problem(`${r.table} names board ${r.board}, which has no row`);
    }
    const statuses = ctx.ids('Status');
    for (const c of this.columnStatuses) {
      if (!this.columns.has(c.column)) problem(`column status of column ${c.column}, no row`);
      if (!/^\d+$/.test(c.status) || !statuses?.has(Number(c.status))) {
        problem(`column ${c.column} holds status ${c.status.slice(0, 20)}, which has no row`);
      }
    }
    // Sprints: values name sprints; one open sprint at most per issue.
    const open = new Map<number, number>();
    const perIssue = new Map<number, number>();
    for (const v of this.values) {
      if (!this.sprintFields.has(v.field)) continue;
      const sprint = this.sprints.get(v.sprint);
      if (!sprint) {
        problem(`issue ${v.issue}: sprint value ${v.sprint} names no sprint`);
        continue;
      }
      note(sprint.closed ? 'sprintIssuesClosed' : 'sprintIssuesOpen');
      perIssue.set(v.issue, (perIssue.get(v.issue) ?? 0) + 1);
      if (!sprint.closed) open.set(v.issue, (open.get(v.issue) ?? 0) + 1);
    }
    for (const count of perIssue.values()) if (count > 1) note('issuesInSeveralSprints');
    for (const [issue, count] of open) {
      if (count > 1) problem(`issue ${issue} is in ${count} sprints that are not closed`);
    }
    // Rank: rows of a rank field, for issues that have rows.
    for (const [field, bits] of this.ranks) {
      if (!this.rankFields.has(field)) problem(`rank rows of field ${field}, not a rank field`);
      let missing = 0;
      for (let byte = 0; byte < bits.length; byte++) {
        const b = bits[byte] as number;
        if (b === 0) continue;
        for (let bit = 0; bit < 8; bit++) {
          if (b & (1 << bit) && !issues?.has(byte * 8 + bit) && missing++ === 0) {
            problem(`rank row of issue ${byte * 8 + bit}, which has no row`);
          }
        }
      }
    }
  }
}
