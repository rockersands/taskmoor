import type { Database, JsonValue } from '@taskmoor/db';
import {
  compileFormula,
  dayOfDate,
  dayOfIso,
  type EvalInput,
  evaluate,
  type FieldValueType,
  FormulaError,
  fieldToken,
  type OutputType,
  outputValueType,
  type Program,
  type Resolution,
  rewriteRefs,
  type Scalar,
  storedValue,
  workingWeek,
} from '@taskmoor/formula';
import { type Kysely, sql, type Transaction } from 'kysely';
import { enqueue } from '../events/queue';
import { type FieldChange, recordChanges } from '../tickets/history';
import { DEFAULT_TIME_SETTINGS, timeSettings } from '../tickets/time';
import type { Catalog, FieldDef } from './catalog';
import { syncFieldValues } from './storage';
import { type FieldConfig, type Stored, serialise } from './types';

/**
 * Formula fields on the server (M1-013; CORE-011; ADR-009 "Implementation (M1-013)"). The
 * language and its sandboxed evaluator are `@taskmoor/formula`; this module names the fields a
 * formula reads, compiles the workspace's formulas once per catalogue, and keeps computed values
 * in `ticket.fields` and the side tables:
 *
 * - **Own values** are recomputed in the transaction of every ticket write (create, edit,
 *   transition, move, restore, time entries, and the bulk edit of M1-021 through
 *   `refreshFormulas`), so the answer to the write already shows them (CORE-011 (1)).
 * - **Roll-ups**: the parent of a written ticket is recomputed in the same transaction when no
 *   one else holds it (`FOR NO KEY UPDATE SKIP LOCKED`, so a write never waits for a parent and
 *   cannot deadlock on one), and its parent in turn when its values changed. A parent someone
 *   holds is queued (`formula.recompute`) and recomputed by the worker once they are done.
 * - **Everything** is recomputed by a background walk (`formula.refresh`) when a formula, its
 *   contexts or a field it reads change, when the working week changes, and once a day for
 *   formulas that read today's date.
 * - History records computed changes like any other (`cf[<id>]`), except for formulas that read
 *   today's date: their values move with the clock, not with a change.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const FORMULA_RECOMPUTE_TASK = 'formula.recompute';
export const FORMULA_REFRESH_TASK = 'formula.refresh';
/** Levels a roll-up change climbs in one transaction; the hierarchy is far shallower. */
const CASCADE_LEVELS = 32;

/** A ticket as formulas read it. */
export interface FormulaRow {
  id: number;
  track_id: number;
  ticket_type_id: number;
  parent_id: number | null;
  summary: string;
  due_date: string | null;
  start_date: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  original_estimate: number | null;
  remaining_estimate: number | null;
  time_spent: number;
  fields: Record<string, JsonValue>;
}

/** System fields formulas read, by id, with their names (spec 01a section 1.3). */
interface SystemRef {
  id: string;
  name: string;
  aliases: readonly string[];
  type: FieldValueType;
  read: (row: FormulaRow) => Scalar;
}
const day = (text: string | null) => (text === null ? null : dayOfIso(text));
export const SYSTEM_REFS: readonly SystemRef[] = [
  { id: 'summary', name: 'Summary', aliases: [], type: 'text', read: (r) => r.summary },
  {
    id: 'due',
    name: 'Due date',
    aliases: ['dueDate'],
    type: 'date',
    read: (r) => day(r.due_date),
  },
  {
    id: 'start',
    name: 'Start date',
    aliases: ['startDate'],
    type: 'date',
    read: (r) => day(r.start_date),
  },
  {
    id: 'created',
    name: 'Created',
    aliases: ['createdDate'],
    type: 'date',
    read: (r) => dayOfDate(r.created_at),
  },
  {
    id: 'updated',
    name: 'Updated',
    aliases: ['updatedDate'],
    type: 'date',
    read: (r) => dayOfDate(r.updated_at),
  },
  {
    id: 'closed',
    name: 'Closed',
    aliases: ['resolved', 'resolutionDate'],
    type: 'date',
    read: (r) => (r.closed_at === null ? null : dayOfDate(r.closed_at)),
  },
  {
    id: 'originalEstimate',
    name: 'Original estimate',
    aliases: [],
    type: 'duration',
    read: (r) => r.original_estimate,
  },
  {
    id: 'remainingEstimate',
    name: 'Remaining estimate',
    aliases: [],
    type: 'duration',
    read: (r) => r.remaining_estimate,
  },
  {
    id: 'timeSpent',
    name: 'Time spent',
    aliases: [],
    type: 'duration',
    read: (r) => r.time_spent,
  },
];
const SYSTEM_BY_ID = new Map(SYSTEM_REFS.map((s) => [s.id, s]));
const SYSTEM_BY_NAME = new Map(
  SYSTEM_REFS.flatMap((s) => [s.id, s.name, ...s.aliases].map((n) => [n.toLowerCase(), s])),
);

const CUSTOM_REF = /^cf\[\s*([1-9][0-9]{0,9})\s*\]$/i;
export const formulaRef = (fieldId: number) => `cf[${fieldId}]`;
const customIdOf = (ref: string): number | null => {
  const m = CUSTOM_REF.exec(ref);
  return m ? Number(m[1]) : null;
};

/** The value type a custom field reads as in a formula, or null for types it cannot read yet. */
export function readableType(field: FieldDef): FieldValueType | null {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'text':
    case 'read-only-text':
    case 'url':
      return 'text';
    case 'formula':
      return field.config.output ? outputValueType(field.config.output) : null;
    default:
      return null;
  }
}

/**
 * Who may be read: a shared formula reads shared fields; a local track's formula reads shared
 * fields and its track's own (CORE-003: nothing local leaks to other tracks).
 */
const visible = (field: FieldDef, ownerTrackId: number | null) =>
  field.trackId === null || field.trackId === ownerTrackId;

/**
 * Finds the fields a formula of a track (null: shared) names: `{cf[12]}` by id, system fields
 * by id or name, custom fields by name, ignoring case. System names win over custom ones, as in
 * the query language; a shadowed or shared name is written by id.
 */
const resolvers = new WeakMap<Catalog, Map<number, (name: string) => Resolution>>();

export function formulaResolver(
  catalog: Catalog,
  ownerTrackId: number | null,
): (name: string) => Resolution {
  // One per catalogue and track: listing many formula fields resolves names many times.
  const cached = resolvers.get(catalog)?.get(ownerTrackId ?? 0);
  if (cached) return cached;
  const resolver = buildResolver(catalog, ownerTrackId);
  const byTrack = resolvers.get(catalog) ?? new Map<number, (name: string) => Resolution>();
  byTrack.set(ownerTrackId ?? 0, resolver);
  resolvers.set(catalog, byTrack);
  return resolver;
}

function buildResolver(
  catalog: Catalog,
  ownerTrackId: number | null,
): (name: string) => Resolution {
  const byName = new Map<string, FieldDef[]>();
  for (const f of catalog.fields.values()) {
    if (!visible(f, ownerTrackId)) continue;
    const key = f.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), f]);
  }
  const resolved = (f: FieldDef): Resolution => {
    const type = readableType(f);
    if (type === null) {
      return {
        problem: 'unsupported_field',
        message: `Formulas cannot read ${f.name} (a ${f.type} field) yet`,
      };
    }
    return { id: formulaRef(f.id), type };
  };
  return (name) => {
    const id = customIdOf(name);
    if (id !== null) {
      const f = catalog.fields.get(id);
      return f && visible(f, ownerTrackId)
        ? resolved(f)
        : { problem: 'unknown_field', message: `No field is cf[${id}]` };
    }
    const system = SYSTEM_BY_NAME.get(name.toLowerCase());
    if (system) return { id: system.id, type: system.type };
    const found = byName.get(name.toLowerCase()) ?? [];
    if (found.length === 0)
      return { problem: 'unknown_field', message: `No field is called ${name}` };
    if (found.length > 1) {
      return {
        problem: 'ambiguous_field',
        message: `Several fields are called ${name}: write one as ${found
          .map((f) => `{${formulaRef(f.id)}}`)
          .join(' or ')}`,
      };
    }
    return resolved(found[0] as FieldDef);
  };
}

/** How a reference reads with names: the field's name when it finds the field back, else its id. */
function displayRef(catalog: Catalog, ownerTrackId: number | null, ref: string): string {
  const system = SYSTEM_BY_ID.get(ref);
  if (system) return fieldToken(system.name);
  const id = customIdOf(ref);
  const f = id === null ? undefined : catalog.fields.get(id);
  if (!f) return fieldToken(ref);
  const back = formulaResolver(catalog, ownerTrackId)(f.name);
  return 'id' in back && back.id === ref ? fieldToken(f.name) : fieldToken(ref);
}

/** A stored expression as people read it, with field names. */
export function displayExpression(catalog: Catalog, field: FieldDef): string {
  const stored = field.config.expression ?? '';
  const compiled = compileFormula(stored, { resolve: formulaResolver(catalog, field.trackId) });
  if (!compiled.ok) return stored;
  const p = compiled.program;
  return rewriteRefs(stored, [...p.refs, ...p.childRefs], (r) =>
    displayRef(catalog, field.trackId, r.id),
  );
}

/** A field's settings as the API shows them: a formula with field names. */
export function publicConfig(catalog: Catalog, field: FieldDef): FieldConfig {
  return field.type === 'formula'
    ? { ...field.config, expression: displayExpression(catalog, field) }
    : field.config;
}

export type SaveCheck =
  | {
      ok: true;
      /** The expression to store, with fields by id. */
      expression: string;
      program: Program;
      /** The same for a new field once it has its id (it may roll up its own values). */
      expressionFor: (fieldId: number) => string;
    }
  | { ok: false; error: FormulaError };

/** How a new formula field names itself before it has an id (`children.{Total}` in Total). */
const NEW_FIELD = 'cf[new]';

/**
 * Checks a formula as an administrator saves it (CORE-011 (3)): parsed, every field found,
 * types checked against the output, and no cycle through formula fields of the same ticket
 * (itself included). A new field may name itself in a roll-up over its children.
 */
export function checkFormula(
  catalog: Catalog,
  field: { id: number | null; trackId: number | null; name?: string },
  source: string,
  output: OutputType,
): SaveCheck {
  const base = formulaResolver(catalog, field.trackId);
  const fresh = field.id === null && field.name !== undefined ? field.name.toLowerCase() : null;
  const compiled = compileFormula(source, {
    resolve: (name) => {
      const found = base(name);
      if (fresh !== null && 'problem' in found && found.problem === 'unknown_field') {
        if (name.toLowerCase() === fresh) return { id: NEW_FIELD, type: outputValueType(output) };
      }
      return found;
    },
    output,
  });
  if (!compiled.ok) return compiled;
  const program = compiled.program;
  const own = program.refs.find((r) => r.id === NEW_FIELD);
  if (own) {
    return {
      ok: false,
      error: new FormulaError(
        'cycle',
        `The formula needs its own value: {${field.name}} → {${field.name}}`,
        own.start,
        own.end,
        source,
      ),
    };
  }
  if (field.id !== null) {
    const cycle = cycleThrough(catalog, field.id, program);
    if (cycle) {
      const at = program.refs.find((r) => r.id === formulaRef(cycle[1] as number));
      const names = cycle.map((id) => `{${catalog.fields.get(id)?.name ?? `cf[${id}]`}}`);
      return {
        ok: false,
        error: new FormulaError(
          'cycle',
          `The formula needs its own value: ${names.join(' → ')}`,
          at?.start ?? 0,
          at?.end ?? source.length,
          source,
        ),
      };
    }
  }
  const expressionFor = (fieldId: number) =>
    rewriteRefs(source, [...program.refs, ...program.childRefs], (r) =>
      fieldToken(r.id === NEW_FIELD ? formulaRef(fieldId) : r.id),
    );
  return {
    ok: true,
    expression: expressionFor(field.id ?? 0),
    program,
    expressionFor,
  };
}

/** Formula fields a formula reads on the same ticket. */
const ownFormulaRefs = (catalog: Catalog, program: Program) =>
  program.refs
    .map((r) => customIdOf(r.id))
    .filter((id): id is number => id !== null && catalog.fields.get(id)?.type === 'formula');

/**
 * A path from `fieldId` back to itself through same-ticket formula references, with the new
 * program for `fieldId`; null when there is none. Roll-ups read other tickets and the hierarchy
 * has no loops, so `children.{Total}` inside Total is fine.
 */
function cycleThrough(catalog: Catalog, fieldId: number, program: Program): number[] | null {
  const plan = formulaPlan(catalog);
  const next = (id: number): number[] =>
    id === fieldId ? ownFormulaRefs(catalog, program) : (plan.byId.get(id)?.reads ?? []);
  const path: number[] = [fieldId];
  const seen = new Set<number>();
  const walk = (id: number): boolean => {
    for (const n of next(id)) {
      if (n === fieldId) {
        path.push(n);
        return true;
      }
      if (seen.has(n)) continue;
      seen.add(n);
      path.push(n);
      if (walk(n)) return true;
      path.pop();
    }
    return false;
  };
  return walk(fieldId) ? path : null;
}

export interface FormulaDef {
  field: FieldDef;
  output: OutputType;
  /** Null when the stored formula no longer checks (it then gives empty). */
  program: Program | null;
  /** Formula fields it reads on the same ticket. */
  reads: number[];
}

export interface FormulaPlan {
  /** In dependency order: a formula after those it reads. */
  order: FormulaDef[];
  byId: Map<number, FormulaDef>;
  readsChildren: boolean;
  workingWeek: boolean;
  /** Ids of formulas that read today's date; their changes have no history. */
  volatile: Set<number>;
}

const plans = new WeakMap<Catalog, FormulaPlan>();

/** The workspace's formulas, compiled once per catalogue (the catalogue reloads on change). */
export function formulaPlan(catalog: Catalog): FormulaPlan {
  const hit = plans.get(catalog);
  if (hit) return hit;
  const defs: FormulaDef[] = [];
  for (const field of catalog.fields.values()) {
    if (field.type !== 'formula') continue;
    const output = field.config.output ?? 'number';
    const compiled = compileFormula(field.config.expression ?? '', {
      resolve: formulaResolver(catalog, field.trackId),
      output,
    });
    const program = compiled.ok ? compiled.program : null;
    defs.push({
      field,
      output,
      program,
      reads: program ? ownFormulaRefs(catalog, program) : [],
    });
  }
  // Dependency order; formulas in a cycle (refused on save, so only a hand-made change) are left
  // without a program and give empty.
  const byId = new Map(defs.map((d) => [d.field.id, d]));
  const order: FormulaDef[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (d: FormulaDef): boolean => {
    const s = state.get(d.field.id);
    if (s === 'done') return true;
    if (s === 'visiting') return false;
    state.set(d.field.id, 'visiting');
    let fine = true;
    for (const id of d.reads) {
      const dep = byId.get(id);
      if (dep && !visit(dep)) fine = false;
    }
    if (!fine) d.program = null;
    state.set(d.field.id, 'done');
    order.push(d);
    return fine;
  };
  for (const d of [...defs].sort((a, b) => a.field.id - b.field.id)) visit(d);
  const plan: FormulaPlan = {
    order,
    byId,
    readsChildren: defs.some((d) => d.program?.readsChildren),
    workingWeek: defs.some((d) => d.program?.workingWeek),
    volatile: new Set(defs.filter((d) => d.program?.volatile).map((d) => d.field.id)),
  };
  plans.set(catalog, plan);
  return plan;
}

/** Formula fields that read any of `fieldIds`, directly or through other formulas. */
export function formulasReading(catalog: Catalog, fieldIds: readonly number[]): number[] {
  const plan = formulaPlan(catalog);
  const wanted = new Set(fieldIds.map(formulaRef));
  const out = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of plan.order) {
      if (out.has(d.field.id) || !d.program) continue;
      if ([...d.program.refs, ...d.program.childRefs].some((r) => wanted.has(r.id))) {
        out.add(d.field.id);
        wanted.add(formulaRef(d.field.id));
        grew = true;
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Today and the working week, as formulas read them. */
export interface FormulaEnv {
  today: number;
  workingWeek: readonly boolean[];
}

export async function formulaEnv(
  db: Db,
  plan: FormulaPlan,
  workspaceId: number,
  now = new Date(),
): Promise<FormulaEnv> {
  const settings = plan.workingWeek ? await timeSettings(db, workspaceId) : DEFAULT_TIME_SETTINGS;
  return { today: dayOfDate(now), workingWeek: workingWeek(settings.daysPerWeek) };
}

/** A custom value as a formula reads it; empty where the field does not apply to the ticket. */
function customValue(catalog: Catalog, row: FormulaRow, fieldId: number): Scalar {
  const field = catalog.fields.get(fieldId);
  const stored = row.fields[String(fieldId)];
  if (!field || stored === undefined || stored === null) return null;
  if (!catalog.contextOf(fieldId, row.track_id, row.ticket_type_id)) return null;
  const type = readableType(field);
  if (type === 'date') return typeof stored === 'string' ? dayOfIso(stored) : null;
  if (type === 'text') return typeof stored === 'string' ? stored : null;
  return typeof stored === 'number' ? stored : null;
}

function read(catalog: Catalog, row: FormulaRow, ref: string): Scalar {
  const system = SYSTEM_BY_ID.get(ref);
  if (system) return system.read(row);
  const id = customIdOf(ref);
  return id === null ? null : customValue(catalog, row, id);
}

/**
 * A ticket's values with every formula computed (in dependency order, so a formula reading
 * another sees its new value). Formulas that do not apply to the ticket have no value.
 */
export function computeValues(
  catalog: Catalog,
  plan: FormulaPlan,
  row: FormulaRow,
  children: readonly FormulaRow[],
  env: FormulaEnv,
): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...row.fields };
  const self: FormulaRow = { ...row, fields: next };
  const input: EvalInput = {
    field: (id) => read(catalog, self, id),
    children: (id) => children.map((c) => read(catalog, c, id)),
    childCount: () => children.length,
    today: env.today,
    workingWeek: env.workingWeek,
  };
  for (const d of plan.order) {
    const key = String(d.field.id);
    if (!d.program || !catalog.contextOf(d.field.id, row.track_id, row.ticket_type_id)) {
      delete next[key];
      continue;
    }
    const result = evaluate(d.program, input);
    const value = result.ok ? storedValue(d.output, result.value) : undefined;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

const ROW_COLUMNS = [
  'id',
  'track_id',
  'ticket_type_id',
  'parent_id',
  'summary',
  'due_date',
  'start_date',
  'created_at',
  'updated_at',
  'closed_at',
  'original_estimate',
  'remaining_estimate',
  'time_spent',
  'fields',
] as const;

async function loadRows(db: Db, workspaceId: number, ids: readonly number[]) {
  if (ids.length === 0) return [];
  return (await db
    .selectFrom('ticket')
    .select([...ROW_COLUMNS])
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...ids])
    .where('deleted_at', 'is', null)
    .execute()) as FormulaRow[];
}

async function loadChildren(db: Db, workspaceId: number, parentIds: readonly number[]) {
  if (parentIds.length === 0) return [];
  return (await db
    .selectFrom('ticket')
    .select([...ROW_COLUMNS])
    .where('workspace_id', '=', workspaceId)
    .where('parent_id', 'in', [...parentIds])
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .execute()) as FormulaRow[];
}

export interface Recomputed {
  /** Tickets whose formula values changed, with the values before and after. */
  changed: {
    id: number;
    parentId: number | null;
    before: Record<string, JsonValue>;
    after: Record<string, JsonValue>;
  }[];
  /** Live tickets read, with their parents. */
  rows: FormulaRow[];
  /** Tickets someone else holds (with `lock: 'skip'`); queue them. */
  skipped: number[];
}

/**
 * Recomputes the formula values of tickets and writes the ones that changed, with their side
 * rows. `lock`: 'held' when the caller holds the tickets' rows, 'wait' to lock them (a job
 * holding nothing else), 'skip' to take only those no one holds. Children in the set are
 * computed before their parents, so a parent's roll-up sees them. Computed values change
 * neither the version nor the update time: no one wrote them.
 */
export async function recomputeTickets(
  trx: Transaction<Database>,
  catalog: Catalog,
  workspaceId: number,
  ticketIds: readonly number[],
  options: { lock: 'held' | 'wait' | 'skip'; env?: FormulaEnv },
): Promise<Recomputed> {
  const plan = formulaPlan(catalog);
  const ids = [...new Set(ticketIds)].sort((a, b) => a - b);
  if (plan.order.length === 0 || ids.length === 0) return { changed: [], rows: [], skipped: [] };
  let ready = ids;
  let skipped: number[] = [];
  if (options.lock !== 'held') {
    const lock = trx
      .selectFrom('ticket')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .forNoKeyUpdate();
    const got = await (options.lock === 'skip' ? lock.skipLocked() : lock).execute();
    ready = got.map((r) => r.id);
    if (options.lock === 'skip' && ready.length < ids.length) {
      const taken = new Set(ready);
      const rest = ids.filter((id) => !taken.has(id));
      // Those still live are held by someone; trashed ones need nothing.
      skipped = (
        await trx
          .selectFrom('ticket')
          .select('id')
          .where('id', 'in', rest)
          .where('deleted_at', 'is', null)
          .execute()
      ).map((r) => r.id);
    }
  }
  const rows = await loadRows(trx, workspaceId, ready);
  if (rows.length === 0) return { changed: [], rows, skipped };
  const env = options.env ?? (await formulaEnv(trx, plan, workspaceId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<number, FormulaRow[]>();
  if (plan.readsChildren) {
    for (const child of await loadChildren(trx, workspaceId, ready)) {
      const row = byId.get(child.id) ?? child;
      const list = kids.get(child.parent_id as number) ?? [];
      list.push(row);
      kids.set(child.parent_id as number, list);
    }
  }
  // Deepest first: a ticket's depth is the number of its ancestors in the set.
  const depth = (row: FormulaRow) => {
    let n = 0;
    let at = row.parent_id === null ? undefined : byId.get(row.parent_id);
    while (at && n <= rows.length) {
      n++;
      at = at.parent_id === null ? undefined : byId.get(at.parent_id);
    }
    return n;
  };
  const ordered = [...rows].sort((a, b) => depth(b) - depth(a) || a.id - b.id);
  const changed: Recomputed['changed'] = [];
  const fieldIds = new Set<number>();
  for (const row of ordered) {
    const before = row.fields;
    const after = computeValues(catalog, plan, row, kids.get(row.id) ?? [], env);
    let differs = false;
    for (const d of plan.order) {
      const key = String(d.field.id);
      if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
        fieldIds.add(d.field.id);
        differs = true;
      }
    }
    if (!differs) continue;
    // In memory too, so a parent later in the order reads the new values.
    row.fields = after;
    changed.push({ id: row.id, parentId: row.parent_id, before, after });
  }
  for (const c of changed) {
    await trx
      .updateTable('ticket')
      .set({ fields: JSON.stringify(c.after) })
      .where('id', '=', c.id)
      .execute();
  }
  if (changed.length > 0) {
    await syncFieldValues(
      trx,
      catalog,
      changed.map((c) => c.id),
      [...fieldIds],
    );
  }
  return { changed, rows, skipped };
}

/** History rows of computed changes; formulas that read today's date have none. */
export function formulaHistory(catalog: Catalog, changed: Recomputed['changed']): FieldChange[] {
  const plan = formulaPlan(catalog);
  const out: FieldChange[] = [];
  for (const c of changed) {
    for (const d of plan.order) {
      if (plan.volatile.has(d.field.id)) continue;
      const key = String(d.field.id);
      const text = (v: JsonValue | undefined) =>
        v === undefined || v === null ? null : serialise(d.field, v as Stored);
      const from = text(c.before[key]);
      const to = text(c.after[key]);
      if (from === to) continue;
      out.push({
        ticketId: c.id,
        field: `cf[${d.field.id}]`,
        from,
        to,
        fromDisplay: null,
        toDisplay: null,
      });
    }
  }
  return out;
}

/**
 * Queues tickets for the worker to recompute. The job waits for their rows, so it can run at
 * once: it goes on as soon as the transaction that holds them ends.
 */
export async function queueRecompute(
  db: Db,
  workspaceId: number,
  ticketIds: readonly number[],
  delayMs = 0,
): Promise<void> {
  if (ticketIds.length === 0) return;
  await enqueue(db, [
    {
      workspaceId,
      task: FORMULA_RECOMPUTE_TASK,
      payload: { ticketIds: [...new Set(ticketIds)].sort((a, b) => a - b) },
      runAt: new Date(Date.now() + delayMs),
    },
  ]);
}

/**
 * Recomputes parents whose roll-ups may have moved, climbing while values change: in this
 * transaction for those no one holds, queued for the others. Returns their history rows.
 */
export async function cascadeToParents(
  trx: Transaction<Database>,
  catalog: Catalog,
  workspaceId: number,
  parentIds: readonly (number | null | undefined)[],
  env: FormulaEnv,
): Promise<FieldChange[]> {
  const plan = formulaPlan(catalog);
  if (!plan.readsChildren) return [];
  const history: FieldChange[] = [];
  let level = [...new Set(parentIds.filter((id): id is number => typeof id === 'number'))];
  const done = new Set<number>();
  for (let i = 0; i < CASCADE_LEVELS && level.length > 0; i++) {
    level = level.filter((id) => !done.has(id));
    for (const id of level) done.add(id);
    const result = await recomputeTickets(trx, catalog, workspaceId, level, { lock: 'skip', env });
    await queueRecompute(trx, workspaceId, result.skipped);
    history.push(...formulaHistory(catalog, result.changed));
    level = result.changed.map((c) => c.parentId).filter((id): id is number => id !== null);
  }
  if (level.length > 0) await queueRecompute(trx, workspaceId, level);
  return history;
}

/**
 * The hook every ticket write calls in its transaction, after writing and before recording its
 * history (and the one M1-021's bulk edit calls for each batch): recomputes the written
 * tickets' formulas (the caller holds their rows), then their parents' roll-ups and the parents
 * named in `parents` (a parent a ticket just left). Returns the history rows of every computed
 * change, to record with the write's own. Nothing happens, and nothing is read, in a workspace
 * without formula fields.
 */
export async function refreshFormulas(
  trx: Transaction<Database>,
  catalog: Catalog,
  workspaceId: number,
  written: readonly number[],
  options: { parents?: readonly (number | null | undefined)[]; now?: Date } = {},
): Promise<FieldChange[]> {
  const plan = formulaPlan(catalog);
  if (plan.order.length === 0) return [];
  const env = await formulaEnv(trx, plan, workspaceId, options.now);
  const own = await recomputeTickets(trx, catalog, workspaceId, written, { lock: 'held', env });
  const history = formulaHistory(catalog, own.changed);
  if (plan.readsChildren) {
    const inSet = new Set(written);
    const parents = [...own.rows.map((r) => r.parent_id), ...(options.parents ?? [])].filter(
      (id): id is number => typeof id === 'number' && !inSet.has(id),
    );
    history.push(...(await cascadeToParents(trx, catalog, workspaceId, parents, env)));
  }
  return history;
}

/**
 * Queues a walk over the workspace's tickets (or some tracks') that recomputes every formula:
 * after a formula, its contexts, a field it reads or the working week changed.
 */
export async function queueFormulaRefresh(
  db: Db,
  workspaceId: number,
  options: { reason: string; trackIds?: readonly number[]; key?: string } = { reason: 'change' },
): Promise<void> {
  await enqueue(db, [
    {
      workspaceId,
      task: FORMULA_REFRESH_TASK,
      payload: {
        after: 0,
        reason: options.reason,
        ...(options.trackIds ? { trackIds: [...options.trackIds] } : {}),
      },
      ...(options.key ? { key: options.key } : {}),
      maxAttempts: 5,
    },
  ]);
}

/** The same, only in a workspace that has formula fields (for writers that hold no catalogue). */
export async function queueRefreshIfFormulas(
  db: Db,
  workspaceId: number,
  options: { reason: string; trackIds?: readonly number[] },
): Promise<void> {
  const any = await db
    .selectFrom('field')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('type', '=', 'formula')
    .limit(1)
    .executeTakeFirst();
  if (any) await queueFormulaRefresh(db, workspaceId, options);
}

/** Tickets a refresh walk reads per transaction. */
export const REFRESH_BATCH = 200;

/**
 * One step of a refresh walk: the next batch of live tickets after `after` (in `trackIds` when
 * given), recomputed with their parents. Returns where to go on from, or null at the end.
 */
export async function refreshBatch(
  db: Kysely<Database>,
  catalog: Catalog,
  workspaceId: number,
  options: { after: number; trackIds?: readonly number[]; now?: Date },
): Promise<{ next: number | null; changed: number; history: number }> {
  const plan = formulaPlan(catalog);
  if (plan.order.length === 0) return { next: null, changed: 0, history: 0 };
  let query = db
    .selectFrom('ticket')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .where('id', '>', options.after)
    .orderBy('id')
    .limit(REFRESH_BATCH);
  if (options.trackIds) query = query.where('track_id', 'in', [...options.trackIds]);
  const ids = (await query.execute()).map((r) => r.id);
  if (ids.length === 0) return { next: null, changed: 0, history: 0 };
  const result = await db.transaction().execute(async (trx) => {
    const env = await formulaEnv(trx, plan, workspaceId, options.now);
    const own = await recomputeTickets(trx, catalog, workspaceId, ids, { lock: 'skip', env });
    await queueRecompute(trx, workspaceId, own.skipped);
    const history = formulaHistory(catalog, own.changed);
    const parents = own.changed.map((c) => c.parentId);
    history.push(...(await cascadeToParents(trx, catalog, workspaceId, parents, env)));
    await recordComputed(trx, workspaceId, history);
    return { changed: own.changed.length, history: history.length };
  });
  return { next: ids.length === REFRESH_BATCH ? (ids[ids.length - 1] as number) : null, ...result };
}

/** Records computed changes no person made (jobs): one change set, no actor. */
async function recordComputed(
  trx: Transaction<Database>,
  workspaceId: number,
  changes: readonly FieldChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await recordChanges(trx, workspaceId, null, changes);
}

/**
 * Recomputes queued tickets one transaction each (a job holds one ticket at a time, waiting for
 * it, so it can never deadlock with a write), then their parents.
 */
export async function recomputeQueued(
  db: Kysely<Database>,
  catalog: Catalog,
  workspaceId: number,
  ticketIds: readonly number[],
  now?: Date,
): Promise<number> {
  const plan = formulaPlan(catalog);
  if (plan.order.length === 0) return 0;
  let changed = 0;
  for (const id of [...new Set(ticketIds)].sort((a, b) => a - b)) {
    changed += await db.transaction().execute(async (trx) => {
      const env = await formulaEnv(trx, plan, workspaceId, now);
      const own = await recomputeTickets(trx, catalog, workspaceId, [id], { lock: 'wait', env });
      const history = formulaHistory(catalog, own.changed);
      if (plan.readsChildren) {
        // A queued ticket is a parent whose children changed: its own parent follows when its
        // values moved.
        history.push(
          ...(await cascadeToParents(
            trx,
            catalog,
            workspaceId,
            own.changed.map((c) => c.parentId),
            env,
          )),
        );
      }
      await recordComputed(trx, workspaceId, history);
      return own.changed.length;
    });
  }
  return changed;
}

/** Workspaces that have formula fields. */
export async function workspacesWithFormulas(db: Db): Promise<number[]> {
  const { rows } = await sql<{ workspace_id: number }>`
    SELECT DISTINCT workspace_id FROM field WHERE type = 'formula'`.execute(db);
  return rows.map((r) => r.workspace_id);
}
