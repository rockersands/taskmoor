import { clauses, parseQuery } from '@taskmoor/query';

/**
 * Boards, sprints, rank, versions and components as a Data Center backup holds them (M1-093;
 * IMP-004; ADR-095), from general knowledge of the format, every rule marked **Verify** in the
 * format notes (02d) until a design partner's backup confirms it.
 *
 * - Versions and components are rows of the entities file (`Version`, `Component`) under their
 *   project. An issue names its fix versions, affected versions and components through
 *   `NodeAssociation` rows from the issue to the version or component.
 * - Boards and sprints are tables of the agile plugin in the active-objects file: a board
 *   (`AO_60DB71_RAPIDVIEW`) shows the issues of a saved filter (`SearchRequest`), its columns
 *   (`AO_60DB71_COLUMN`) each hold statuses (`AO_60DB71_COLUMNSTATUS`), its quick filters
 *   (`AO_60DB71_QUICKFILTER`) are named queries, and a Kanban board may narrow its filter with a
 *   sub-query (`AO_60DB71_SUBQUERY`).
 * - An issue's sprints are the values of the plugin's sprint custom field (one value per sprint,
 *   the sprint's id as a number); its rank is a row of `AO_60DB71_LEXORANK` for the plugin's
 *   rank custom field, a string that orders issues when compared as plain text.
 *
 * This is the format layer, in the backup's own vocabulary (version, component, rapid view).
 * It imports nothing from `format.ts` but types, so the two files stay acyclic.
 */

// --- Elements ---------------------------------------------------------------------------------

const id = { type: 'id' } as const;
const text = { type: 'text' } as const;
const optText = { type: 'text', optional: true } as const;
const longText = { type: 'text', optional: true, long: true } as const;
const optInt = { type: 'int', optional: true } as const;
const optTime = { type: 'time', optional: true } as const;
const project = { type: 'ref', to: 'Project' } as const;
/** `true` when set; left out otherwise (Verify). */
const optFlag = { type: 'enum', values: ['true', 'false'], optional: true } as const;

/** The elements of this part, merged into `format.ts`'s `ENTITIES`. */
export const AGILE_ENTITIES = {
  Version: {
    attrs: {
      id,
      project,
      name: text,
      description: optText,
      sequence: optInt,
      released: optFlag,
      archived: optFlag,
      startdate: optTime,
      releasedate: optTime,
    },
  },
  Component: {
    attrs: {
      id,
      project,
      name: text,
      description: longText,
      lead: { type: 'user', optional: true },
      assigneetype: optInt,
    },
  },
} as const;

export const AGILE_ELEMENTS = Object.keys(AGILE_ENTITIES) as (keyof typeof AGILE_ENTITIES)[];

/** `NodeAssociation.associationType` of an issue's versions and components (Verify). */
export const ISSUE_ASSOCIATIONS = {
  fixVersion: 'IssueFixVersion',
  affectsVersion: 'IssueVersion',
  component: 'IssueComponent',
} as const;

/** `Component.assigneetype`: who a new issue in the component goes to (Verify). */
export const COMPONENT_ASSIGNEE_TYPES = {
  projectDefault: 0,
  componentLead: 1,
  projectLead: 2,
  unassigned: 3,
} as const;

/** The plugin's custom field types for an issue's sprints and its rank (Verify). */
export const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';
export const RANK_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-lexo-rank';

/** `AO_60DB71_LEXORANK.TYPE` of an issue's own rank row; other types are markers (Verify). */
export const RANK_ROW_ISSUE = 0;

// --- Active objects -----------------------------------------------------------------------

/** A column as `format.ts`'s `AoColumn` has it, repeated so the two files stay acyclic. */
interface AoColumn {
  name: string;
  type: 'integer' | 'string' | 'boolean' | 'timestamp' | 'double';
  sqlType: number;
  precision?: number;
  primaryKey?: true;
  autoIncrement?: true;
}

const BIGINT = -5;
const INTEGER = 4;
const VARCHAR = 12;
const CLOB = 2005;

const pk = {
  name: 'ID',
  type: 'integer',
  sqlType: BIGINT,
  precision: 19,
  primaryKey: true,
  autoIncrement: true,
} as const satisfies AoColumn;
const bigint = (name: string): AoColumn => ({
  name,
  type: 'integer',
  sqlType: BIGINT,
  precision: 19,
});
const integer = (name: string): AoColumn => ({
  name,
  type: 'integer',
  sqlType: INTEGER,
  precision: 10,
});
const string = (name: string, precision = 255): AoColumn => ({
  name,
  type: 'string',
  sqlType: VARCHAR,
  precision,
});
const clob = (name: string): AoColumn => ({
  name,
  type: 'string',
  sqlType: CLOB,
  precision: 2_147_483_647,
});

/**
 * The agile plugin's tables besides boards and sprints (`format.ts` keeps those two), with
 * their columns in the order the generator writes them (Verify, every one).
 */
export const AGILE_AO_TABLES: Readonly<Record<string, readonly AoColumn[]>> = {
  AO_60DB71_COLUMN: [
    pk,
    string('NAME'),
    integer('POS'),
    bigint('RAPID_VIEW_ID'),
    { name: 'MINIM', type: 'double', sqlType: 8, precision: 17 },
    { name: 'MAXIM', type: 'double', sqlType: 8, precision: 17 },
  ],
  AO_60DB71_COLUMNSTATUS: [pk, bigint('COLUMN_ID'), integer('POS'), string('STATUS_ID')],
  AO_60DB71_QUICKFILTER: [
    pk,
    string('NAME'),
    clob('QUERY'),
    string('DESCRIPTION'),
    integer('POS'),
    bigint('RAPID_VIEW_ID'),
  ],
  AO_60DB71_SUBQUERY: [pk, clob('QUERY'), bigint('RAPID_VIEW_ID')],
  AO_60DB71_LEXORANK: [
    pk,
    integer('BUCKET'),
    bigint('FIELD_ID'),
    bigint('ISSUE_ID'),
    string('LOCK_HASH'),
    bigint('LOCK_TIME'),
    string('RANK'),
    integer('TYPE'),
  ],
};

/** Every table of the agile plugin the importer reads (M1-093). */
export const AGILE_TABLES: ReadonlySet<string> = new Set([
  'AO_60DB71_RAPIDVIEW',
  'AO_60DB71_SPRINT',
  ...Object.keys(AGILE_AO_TABLES),
]);

/** The tables a configuration-only import still reads: boards without their sprints. */
export const AGILE_CONFIGURATION_TABLES: ReadonlySet<string> = new Set([
  'AO_60DB71_RAPIDVIEW',
  'AO_60DB71_COLUMN',
  'AO_60DB71_COLUMNSTATUS',
  'AO_60DB71_QUICKFILTER',
  'AO_60DB71_SUBQUERY',
]);

// --- Reading filters -------------------------------------------------------------------------

/**
 * The projects a board's filter names in `project = X` or `project in (X, Y)` clauses that are
 * not negated, as written (keys, names or ids), in order; null when the query does not parse.
 * A board shows the issues its filter finds, so these say which projects a board spans (Our
 * choice: the first one is where the board lives).
 */
export function projectsNamed(query: string): string[] | null {
  let parsed: ReturnType<typeof parseQuery>;
  try {
    parsed = parseQuery(query);
  } catch {
    return null;
  }
  const out: string[] = [];
  const add = (v: { kind: string; value?: unknown }) => {
    if (
      (v.kind === 'word' || v.kind === 'string' || v.kind === 'number') &&
      v.value !== undefined
    ) {
      const s = String(v.value);
      if (!out.includes(s)) out.push(s);
    }
  };
  for (const c of clauses(parsed.where)) {
    if (c.field.custom !== undefined || c.field.name.toLowerCase() !== 'project') continue;
    if (c.kind === 'compare' && c.op === '=') add(c.value);
    else if (c.kind === 'in' && !c.negated) for (const v of c.values) add(v);
  }
  return out;
}
