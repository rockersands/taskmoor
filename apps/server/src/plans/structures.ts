import {
  compileFormula,
  type FieldValueType,
  type FormulaError,
  fieldToken,
  OUTPUT_TYPES,
  type OutputType,
  rewriteRefs,
} from '@taskmoor/formula';
import { z } from 'zod';
import type { Catalog, FieldDef } from '../fields/catalog';
import { formulaResolver, readableType, SYSTEM_REFS } from '../fields/formulas';

/**
 * Structures of a plan's Grid (T-089a; PLN-010; ADR-122 stage 10): what a structure is and the
 * checks on it.
 *
 * A structure is a saved, named recipe for a plan's tree: its steps and its columns. It holds no
 * tickets; the rows are built for each viewer when read (`structureTree.ts`). The steps apply in a
 * fixed order whatever order they are stored in: one Add tickets (`insert`, maybe narrowed by a
 * query), up to two Group by (`group`, single-valued fields only), up to one Add children
 * (`children`) and up to two Add linked tickets (`links`, depth 1 to 3). Columns are ticket
 * columns, totals over the rows below and formulas in the formula field language, at most 30, of
 * which 10 totals and 5 formulas.
 *
 * On save every reference is checked against the workspace (`checkStructure`): a formula through
 * `compileFormula` with `formulaResolver(catalog, null)`, shared fields only, then stored with its
 * fields by id. When read, a field or link type deleted since makes that column or step broken
 * (`structureProblems`), while the rest of the structure works.
 */
const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);

/** Rows a Grid gives at most (`LISTED`, 10,000, stays for the other views). */
export const GRID_ROWS = 100_000;
/** Structures a plan holds. */
export const MAX_STRUCTURES = 20;
export const MAX_COLUMNS = 30;
export const MAX_TOTALS = 10;
export const MAX_FORMULAS = 5;
/** Characters of an Add tickets step's query. */
export const MAX_STEP_QUERY = 2000;
/** Levels an Add linked tickets step goes down. */
export const MAX_LINK_DEPTH = 3;
/** Tickets one rows-in-view read answers. */
export const MAX_GRID_IDS = 500;
/** Levels an Add children step goes down at most: a guard, the hierarchy is far shallower. */
export const CHILD_LEVELS = 32;

export const STEP_LIMITS = { insert: 1, group: 2, children: 1, links: 2 } as const;

export const STRUCTURE_LIMITS = {
  structures: MAX_STRUCTURES,
  rows: GRID_ROWS,
  steps: STEP_LIMITS,
  linkDepth: MAX_LINK_DEPTH,
  columns: MAX_COLUMNS,
  totals: MAX_TOTALS,
  formulas: MAX_FORMULAS,
  query: MAX_STEP_QUERY,
  ids: MAX_GRID_IDS,
  name: 100,
} as const;

/** The plan's own groupings; custom single-valued fields join them by `cf[<id>]`. */
export const GROUP_SYSTEM_FIELDS = ['track', 'assignee', 'status', 'type', 'priority'] as const;
/** Custom field types a Group by step takes, when they hold one value. */
const GROUP_CUSTOM_TYPES: ReadonlySet<string> = new Set(['select', 'user', 'team', 'release']);

/** Ticket columns besides `cf[<id>]`: the key and the search results' system columns. */
export const TICKET_COLUMNS = [
  'key',
  'summary',
  'ticketType',
  'status',
  'assignee',
  'priority',
  'labels',
  'track',
  'requester',
  'creator',
  'parent',
  'startDate',
  'dueDate',
  'createdAt',
  'updatedAt',
  'closedAt',
  'targetReleases',
  'areas',
  'voteCount',
] as const;
const TICKET_COLUMN_SET: ReadonlySet<string> = new Set(TICKET_COLUMNS);

export const TOTAL_FNS = ['sum', 'min', 'max', 'count', 'progress'] as const;
export type TotalFn = (typeof TOTAL_FNS)[number];

const insertStep = z
  .object({ kind: z.literal('insert'), query: z.string().max(MAX_STEP_QUERY).optional() })
  .strict();
const groupStep = z.object({ kind: z.literal('group'), field: z.string().min(1).max(40) }).strict();
const childrenStep = z.object({ kind: z.literal('children') }).strict();
const linksStep = z
  .object({
    kind: z.literal('links'),
    linkTypeId: idNum,
    direction: z.enum(['outward', 'inward']),
    depth: z.number().int().min(1).max(MAX_LINK_DEPTH),
  })
  .strict();
export const stepSpec = z.discriminatedUnion('kind', [
  insertStep,
  groupStep,
  childrenStep,
  linksStep,
]);
export type StepSpec = z.infer<typeof stepSpec>;
export type LinksStep = z.infer<typeof linksStep>;

const ticketColumn = z
  .object({ kind: z.literal('ticket'), field: z.string().min(1).max(40) })
  .strict();
const totalColumn = z
  .object({
    kind: z.literal('total'),
    fn: z.enum(TOTAL_FNS),
    of: z.string().min(1).max(40).optional(),
  })
  .strict();
const formulaColumn = z
  .object({
    kind: z.literal('formula'),
    name: z.string().trim().min(1).max(100),
    expression: z.string().min(1).max(4000),
    output: z.enum(OUTPUT_TYPES),
    decimals: z.number().int().min(0).max(3).default(0),
  })
  .strict();
export const columnSpec = z.discriminatedUnion('kind', [ticketColumn, totalColumn, formulaColumn]);
export type ColumnSpec = z.infer<typeof columnSpec>;
export type FormulaColumn = z.infer<typeof formulaColumn>;

const KIND_ORDER: Record<StepSpec['kind'], number> = { insert: 0, group: 1, children: 2, links: 3 };

/** The steps in the order they apply: insert, groupings, children, links, each kind as stored. */
export function orderedSteps(steps: readonly StepSpec[]): StepSpec[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => KIND_ORDER[a.s.kind] - KIND_ORDER[b.s.kind] || a.i - b.i)
    .map((x) => x.s);
}

/** A structure's shape: the counts of each step kind and of each column kind are its limits. */
export const structureSpec = z
  .object({
    steps: z.array(stepSpec).min(1).max(6),
    columns: z.array(columnSpec).max(MAX_COLUMNS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const kind of Object.keys(STEP_LIMITS) as StepSpec['kind'][]) {
      const n = spec.steps.filter((s) => s.kind === kind).length;
      const max = STEP_LIMITS[kind];
      if (n > max || (kind === 'insert' && n < 1)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps'],
          message: kind === 'insert' && n < 1 ? 'one_insert' : `too_many_${kind}`,
        });
      }
    }
    const totals = spec.columns.filter((c) => c.kind === 'total').length;
    const formulas = spec.columns.filter((c) => c.kind === 'formula').length;
    if (totals > MAX_TOTALS) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'too_many_totals' });
    }
    if (formulas > MAX_FORMULAS) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'too_many_formulas' });
    }
  });
export type StructureSpec = z.infer<typeof structureSpec>;

/** A plan with no saved structure shows this one, unsaved (question 21). */
export const DEFAULT_STRUCTURE: StructureSpec = {
  steps: [{ kind: 'insert' }, { kind: 'children' }],
  columns: [
    { kind: 'ticket', field: 'key' },
    { kind: 'ticket', field: 'summary' },
    { kind: 'ticket', field: 'status' },
    { kind: 'ticket', field: 'assignee' },
    { kind: 'total', fn: 'count' },
    { kind: 'total', fn: 'progress' },
  ],
};

const SYSTEM_TYPES = new Map(SYSTEM_REFS.map((s) => [s.id, s.type]));
/** System fields a sum takes; min and max also take the two days. */
const SUM_SYSTEM: ReadonlySet<string> = new Set([
  'originalEstimate',
  'remainingEstimate',
  'timeSpent',
]);
const DAY_SYSTEM: ReadonlySet<string> = new Set(['start', 'due']);

const customId = (ref: string): number | null => {
  const m = /^cf\[([1-9]\d{0,9})\]$/.exec(ref);
  return m && Number(m[1]) <= MAX_INT ? Number(m[1]) : null;
};

/** Whether a custom field groups one value per ticket. */
function groupable(field: FieldDef | undefined): boolean {
  return field !== undefined && GROUP_CUSTOM_TYPES.has(field.type) && !field.multiple;
}

/** The value type a total reads `of`, or why it cannot. */
function totalType(
  catalog: Catalog,
  fn: TotalFn,
  of: string | undefined,
): { type: FieldValueType } | { problem: string } | null {
  if (fn === 'count' || fn === 'progress')
    return of === undefined ? null : { problem: 'not_allowed' };
  if (of === undefined) return { problem: 'required' };
  const id = customId(of);
  let type: FieldValueType | null;
  if (id === null) {
    if (SUM_SYSTEM.has(of)) type = SYSTEM_TYPES.get(of) ?? null;
    else if (DAY_SYSTEM.has(of)) type = 'date';
    else return { problem: 'unknown_field' };
  } else {
    const field = catalog.fields.get(id);
    if (!field) return { problem: 'unknown_field' };
    if (field.type === 'number') type = 'number';
    else if (field.type === 'date' || field.type === 'datetime') type = 'date';
    else if (field.type === 'formula') type = readableType(field);
    else type = null;
  }
  if (type === 'number' || type === 'duration') return { type };
  if (type === 'date' && fn !== 'sum') return { type };
  return { problem: 'not_summable' };
}

/** A formula column compiled against the workspace's shared fields. */
function compileColumn(catalog: Catalog, column: FormulaColumn) {
  return compileFormula(column.expression, {
    resolve: formulaResolver(catalog, null),
    output: column.output as OutputType,
  });
}

export interface CheckContext {
  catalog: Catalog;
  /** The workspace's link types. */
  linkTypeIds: ReadonlySet<number>;
}

export type Checked =
  | { ok: true; spec: StructureSpec }
  | {
      ok: false;
      fields: Record<string, string>;
      /** For a formula that does not check: the body of `GET /formulas/check`. */
      check?: { ok: false; error: ReturnType<FormulaError['toJSON']> };
    };

/**
 * Checks a structure as an editor saves it: every field, link type and formula as the workspace
 * has them now. The answer stores the steps in the order they apply and every formula with its
 * fields by id, so renaming a field never breaks it.
 */
export function checkStructure(spec: StructureSpec, ctx: CheckContext): Checked {
  const fields: Record<string, string> = {};
  const { catalog } = ctx;
  const groupFields = new Set<string>();
  spec.steps.forEach((step, i) => {
    const at = `steps.${i}`;
    if (step.kind === 'group') {
      const ok =
        (GROUP_SYSTEM_FIELDS as readonly string[]).includes(step.field) ||
        groupable(customIdField(catalog, step.field));
      if (!ok) fields[`${at}.field`] = 'not_groupable';
      else if (groupFields.has(step.field)) fields[`${at}.field`] = 'duplicate';
      groupFields.add(step.field);
    } else if (step.kind === 'links' && !ctx.linkTypeIds.has(step.linkTypeId)) {
      fields[`${at}.linkTypeId`] = 'not_found';
    }
  });
  const ticketColumns = new Set<string>();
  let check: { ok: false; error: ReturnType<FormulaError['toJSON']> } | undefined;
  const columns = spec.columns.map((column, i): ColumnSpec => {
    const at = `columns.${i}`;
    if (column.kind === 'ticket') {
      const id = customId(column.field);
      const known = id === null ? TICKET_COLUMN_SET.has(column.field) : catalog.fields.has(id);
      if (!known) fields[`${at}.field`] = 'unknown_field';
      else if (ticketColumns.has(column.field)) fields[`${at}.field`] = 'duplicate';
      ticketColumns.add(column.field);
      return column;
    }
    if (column.kind === 'total') {
      const t = totalType(catalog, column.fn, column.of);
      if (t && 'problem' in t) fields[`${at}.of`] = t.problem;
      return column;
    }
    const compiled = compileColumn(catalog, column);
    if (!compiled.ok) {
      fields[`${at}.expression`] = compiled.error.code;
      check ??= { ok: false, error: compiled.error.toJSON() };
      return column;
    }
    const p = compiled.program;
    return {
      ...column,
      expression: rewriteRefs(column.expression, [...p.refs, ...p.childRefs], (r) =>
        fieldToken(r.id),
      ),
    };
  });
  if (Object.keys(fields).length > 0) return { ok: false, fields, ...(check ? { check } : {}) };
  return { ok: true, spec: { steps: orderedSteps(spec.steps), columns } };
}

function customIdField(catalog: Catalog, ref: string): FieldDef | undefined {
  const id = customId(ref);
  return id === null ? undefined : catalog.fields.get(id);
}

/** Something of a saved structure that no longer works for a reader. */
export interface StructureProblem {
  /** `steps.<i>` or `columns.<i>` of the structure as stored. */
  path: string;
  reason: string;
  /** A formula's error, as `GET /formulas/check` gives it. */
  error?: ReturnType<FormulaError['toJSON']>;
  /** A query's error in words. */
  message?: string;
}

/** A field a total or a formula column reads, with its value type. */
export interface ReadField {
  ref: string;
  type: FieldValueType;
}

export interface Resolved {
  problems: StructureProblem[];
  /** The steps that work, in the order they apply, with their stored index. */
  steps: { step: StepSpec; index: number }[];
  /** Every field the working totals and formulas read. */
  reads: ReadField[];
}

/**
 * A stored structure against the workspace as it is now: steps and columns whose field or link
 * type is gone are broken, and the rest works. The query of the Add tickets step is checked by the
 * reader's own compile, as it depends on what they may see.
 */
export function resolveStructure(spec: StructureSpec, ctx: CheckContext): Resolved {
  const { catalog } = ctx;
  const problems: StructureProblem[] = [];
  const steps: { step: StepSpec; index: number }[] = [];
  spec.steps.forEach((step, index) => {
    const path = `steps.${index}`;
    if (step.kind === 'group') {
      const system = (GROUP_SYSTEM_FIELDS as readonly string[]).includes(step.field);
      if (!system && !groupable(customIdField(catalog, step.field))) {
        problems.push({ path, reason: 'field_deleted' });
        return;
      }
    } else if (step.kind === 'links' && !ctx.linkTypeIds.has(step.linkTypeId)) {
      problems.push({ path, reason: 'link_type_deleted' });
      return;
    }
    steps.push({ step, index });
  });
  steps.sort((a, b) => KIND_ORDER[a.step.kind] - KIND_ORDER[b.step.kind] || a.index - b.index);
  const reads = new Map<string, FieldValueType>();
  spec.columns.forEach((column, index) => {
    const path = `columns.${index}`;
    if (column.kind === 'ticket') {
      const id = customId(column.field);
      if (id !== null && !catalog.fields.has(id)) problems.push({ path, reason: 'field_deleted' });
      return;
    }
    if (column.kind === 'total') {
      const t = totalType(catalog, column.fn, column.of);
      if (t && 'problem' in t) problems.push({ path, reason: 'field_deleted' });
      else if (t && column.of !== undefined) reads.set(column.of, t.type);
      return;
    }
    const compiled = compileColumn(catalog, column);
    if (!compiled.ok) {
      problems.push({ path, reason: 'formula', error: compiled.error.toJSON() });
      return;
    }
    const resolve = formulaResolver(catalog, null);
    const p = compiled.program;
    for (const r of [...p.refs, ...p.childRefs]) {
      const found = resolve(r.id);
      if (!('problem' in found)) reads.set(found.id, found.type);
    }
  });
  return {
    problems,
    steps,
    reads: [...reads].map(([ref, type]) => ({ ref, type })),
  };
}
