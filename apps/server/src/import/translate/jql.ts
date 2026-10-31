import {
  type CustomType,
  type Expr,
  type FieldRef,
  type FieldType,
  findFunction,
  lookupField,
  makeCatalogue,
  nativeFunctionName,
  type OrderBy,
  type Predicate,
  parseQuery,
  printQuery,
  type Query,
  QueryError,
  type Span,
  type SystemField,
  toNative,
  type Value,
} from '@taskmoor/query';
import type { EntityKind, QueryNote, Ref } from '../model';

/**
 * Translating saved queries from a Jira-compatible source into Taskmoor's own (M1-094; IMP-004,
 * QRY-003; ADR-096). A query is read with the Jira-compatible dialect (the native parser reads
 * both vocabularies, `toNative` renames), then every name or id that only means something in the
 * source is tied to the imported object it became, and the result is printed as canonical native
 * text. It runs in two steps because the source's objects are known while the backup is staged,
 * and the target's only while the import loads:
 *
 * 1. `analyseQuery` (source side, pure): parses, renames, and turns custom fields (`cf[10010]` or
 *    by name), ids of statuses, priorities, close reasons, ticket types, tracks, levels, areas,
 *    releases, options, sprints, tickets and saved searches, and people named by user name or key
 *    into references (`Ref`) the importer resolves. What cannot translate is a problem with a
 *    code and a detail (the function or field name): an unknown function (an app's), an unknown
 *    field, a person nobody has, a syntax error. ORDER BY terms with no counterpart (`Rank`) are
 *    left out, which only changes the order, and noted as a change.
 * 2. `renderQuery` (target side, pure): puts the target's values in place of the references and
 *    prints the query. A reference that did not import is a problem too.
 *
 * Fields and functions of modules this version does not have (service tracks, journeys) still
 * translate, but are flagged: the query is kept and refused when it runs, until the module comes.
 */

/** How a reference prints once it resolves. */
export type SlotAs =
  /** The target object's name, as a string (statuses, priorities, ticket types ...). */
  | 'name'
  /** A track's key, as a word. */
  | 'key'
  /** The target id, as a number (tickets, sprints, saved searches). */
  | 'id'
  /** A person's address, as a string. */
  | 'email'
  /** A custom option's value, as a string. */
  | 'option';

/** A value of the source that names one of its objects: printed from the target's. */
export interface Slot {
  kind: 'slot';
  ref: Ref;
  as: SlotAs;
  /** The text the source wrote, for messages. */
  source: string;
  span: Span;
}

/** A custom field reference whose id is the source's, resolved to the target's when rendered. */
export interface CustomFieldSlot extends FieldRef {
  name: 'cf';
  custom: number;
  ref: Ref;
}

/** Why a query cannot translate (or, as a flag, cannot run yet), grouped by code and detail. */
export type Note = QueryNote;

export interface Analysis {
  /** The query in Taskmoor's names with slots for the source's ids; null when it cannot translate. */
  template: Query | null;
  /** Why it cannot translate: the template is null. */
  problems: Note[];
  /** Fields or functions of a module this version lacks: the query is kept but flagged. */
  flags: Note[];
  /** What the translation changed: ORDER BY terms left out. */
  changes: Note[];
  /** Every reference in the template, for the importer to resolve. */
  refs: Ref[];
}

/** A custom field of the source, typed as the query language will read its imported field. */
export interface SourceField {
  id: string;
  name: string;
  /** Null when the field is not imported. */
  type: CustomType | null;
}

/** What the source holds, for step 1. Ids are the source's, as text. */
export interface SourceCatalogue {
  field(id: string): SourceField | undefined;
  fieldsNamed(name: string): readonly SourceField[];
  /** A person by user name or key: their staged id, or undefined for nobody. */
  person(raw: string): string | undefined;
  /** A project by id, key or name. */
  project(raw: string): { id: string; key: string } | undefined;
  /** Saved filters by id or by name. */
  savedSearches(raw: string): readonly string[];
}

/** Codes of problems and flags, as the report groups them. */
export const NOTE = {
  syntax: 'syntax_error',
  unknownFunction: 'unknown_function',
  unknownField: 'unknown_field',
  ambiguousField: 'ambiguous_field',
  fieldNotImported: 'field_not_imported',
  unknownPerson: 'unknown_person',
  unknownProject: 'unknown_project',
  unknownSavedSearch: 'unknown_saved_search',
  ambiguousSavedSearch: 'ambiguous_saved_search',
  valueNotImported: 'value_not_imported',
  moduleNotAvailable: 'module_not_available',
  orderTermDropped: 'order_term_dropped',
  /** The target's query language refuses the translated text (an operator a field lacks). */
  refused: 'refused',
} as const;

/** A refusal of the translated text, as a problem: the message is its detail. */
export function refusal(error: Error): Note {
  const said = error instanceof QueryError ? error.detail : error.message;
  return { code: NOTE.refused, detail: said.slice(0, 200), message: error.message };
}

/** Native functions whose module this version does not have (bind.ts names it when run). */
const MODULE_FUNCTIONS: ReadonlyMap<string, string> = new Map(
  [
    'approved',
    'approver',
    'myApproval',
    'myPendingApproval',
    'myPending',
    'pending',
    'pendingApprovalBy',
    'pendingBy',
    'breached',
    'completed',
    'everBreached',
    'paused',
    'running',
    'withinCalendarHours',
    'remaining',
    'customerDetail',
    'customerGroupMembers',
    'customerGroupDetail',
    'entitlementDetail',
    'entitlementProduct',
  ].map((n) => [n.toLowerCase(), 'service tracks']),
);
const MODULE_NAMES: Record<string, string> = { service: 'service tracks', journeys: 'journeys' };

/** System fields whose numeric values are the source's ids of named objects. */
const NAMED_FIELDS: Readonly<Record<string, EntityKind>> = {
  type: 'ticket_type',
  status: 'status',
  priority: 'priority',
  closeReason: 'close_reason',
  visibilityLevel: 'visibility_level',
  area: 'area',
  targetRelease: 'release',
  foundInRelease: 'release',
};

/** Status categories by the number the source stores them under (Verify, 02d). */
const STAGE_NUMBERS: Readonly<Record<string, string>> = {
  '2': 'new',
  '4': 'active',
  '3': 'closed',
};

/** How a value is read, which decides what in it names a source object. */
type ValueKind =
  | { of: 'field'; type: FieldType; field: string; custom?: SourceField }
  | { of: 'user' }
  | { of: 'ticket' }
  | { of: 'track' }
  | { of: 'option'; custom: SourceField | undefined }
  | { of: 'plain' };

const SYSTEM_ONLY = makeCatalogue();
const isDigits = (s: string) => /^\d{1,18}$/.test(s);
const textOf = (v: Value): string | null =>
  v.kind === 'string' || v.kind === 'word' ? v.value : v.kind === 'number' ? String(v.value) : null;

class Analyser {
  readonly problems: Note[] = [];
  readonly flags: Note[] = [];
  readonly changes: Note[] = [];
  readonly refs: Ref[] = [];

  constructor(private readonly source: SourceCatalogue) {}

  private note(list: Note[], code: string, detail: string, message: string): void {
    if (!list.some((n) => n.code === code && n.detail === detail)) {
      list.push({ code, detail, message });
    }
  }

  problem(code: string, detail: string, message: string): void {
    this.note(this.problems, code, detail, message);
  }

  private slot(kind: EntityKind, id: string, as: SlotAs, v: Value): Slot {
    const ref = { kind, id };
    this.refs.push(ref);
    return { kind: 'slot', ref, as, source: textOf(v) ?? '', span: v.span };
  }

  /** The field a reference names, renamed; null (with a problem) when it cannot translate. */
  field(f: FieldRef): { ref: FieldRef; kind: ValueKind } | null {
    if (f.custom !== undefined) {
      const custom = this.source.field(String(f.custom));
      if (!custom) {
        this.problem(NOTE.unknownField, `cf[${f.custom}]`, `No custom field cf[${f.custom}]`);
        return null;
      }
      return this.custom(f, custom);
    }
    if (f.property) return { ref: f, kind: { of: 'plain' } };
    const system = lookupField(SYSTEM_ONLY, f) as SystemField | undefined;
    if (system) {
      const module = system.module ? MODULE_NAMES[system.module] : undefined;
      if (module) {
        this.note(
          this.flags,
          NOTE.moduleNotAvailable,
          system.name,
          `"${system.name}" belongs to ${module}, which this version does not have yet`,
        );
      }
      return {
        ref: { ...f, name: system.name },
        kind: { of: 'field', type: system.type, field: system.name },
      };
    }
    const named = this.source.fieldsNamed(f.name);
    if (named.length > 1) {
      this.problem(
        NOTE.ambiguousField,
        f.name,
        `Several custom fields are called "${f.name}" (${named.map((n) => `cf[${n.id}]`).join(', ')})`,
      );
      return null;
    }
    const only = named[0];
    if (!only) {
      this.problem(NOTE.unknownField, f.name, `No field "${f.name}"`);
      return null;
    }
    return this.custom(f, only);
  }

  private custom(f: FieldRef, custom: SourceField): { ref: FieldRef; kind: ValueKind } | null {
    if (custom.type === null) {
      this.problem(
        NOTE.fieldNotImported,
        custom.name,
        `The custom field "${custom.name}" (cf[${custom.id}]) was not imported`,
      );
      return null;
    }
    const ref = { kind: 'field' as const, id: custom.id };
    this.refs.push(ref);
    const slot: CustomFieldSlot = { name: 'cf', custom: Number(custom.id), ref, span: f.span };
    return {
      ref: slot,
      kind: { of: 'field', type: custom.type, field: custom.name, custom },
    };
  }

  /** A value read as `kind`: source ids become slots. */
  value(v: Value, kind: ValueKind): Value | Slot {
    if (v.kind === 'function') return this.call(v, kind);
    const text = textOf(v);
    if (text === null) return v;
    switch (kind.of) {
      case 'plain':
        return v;
      case 'user':
        return this.person(v, text);
      case 'ticket':
        return v.kind === 'number' || isDigits(text) ? this.slot('ticket', text, 'id', v) : v;
      case 'track':
        return this.track(v, text);
      case 'option':
        return v.kind === 'number' || isDigits(text)
          ? this.slot('field_option', text, 'option', v)
          : v;
      case 'field':
        return this.fieldValue(v, text, kind);
    }
  }

  private fieldValue(v: Value, text: string, kind: Extract<ValueKind, { of: 'field' }>) {
    const numeric = v.kind === 'number' || isDigits(text);
    switch (kind.type) {
      case 'user':
        return this.person(v, text);
      case 'track':
        return this.track(v, text);
      case 'key':
        return numeric ? this.slot('ticket', text, 'id', v) : v;
      case 'sprint':
        return numeric ? this.slot('sprint', text, 'id', v) : v;
      case 'savedSearch':
        return this.savedSearch(v, text);
      case 'stage': {
        const stage = STAGE_NUMBERS[text];
        return stage ? { kind: 'word' as const, value: stage, span: v.span } : v;
      }
      case 'option':
      case 'multi':
      case 'cascade':
        if (kind.custom) return numeric ? this.slot('field_option', text, 'option', v) : v;
        break;
    }
    const named = NAMED_FIELDS[kind.field];
    if (named && numeric) return this.slot(named, text, 'name', v);
    return v;
  }

  private person(v: Value, text: string): Value | Slot {
    const id = this.source.person(text);
    if (id === undefined) {
      this.problem(NOTE.unknownPerson, text, `Nobody in the source is called "${text}"`);
      return v;
    }
    return this.slot('user', id, 'email', v);
  }

  private track(v: Value, text: string): Value | Slot {
    const project = this.source.project(text);
    if (!project) {
      this.problem(NOTE.unknownProject, text, `No project "${text}" in the source`);
      return v;
    }
    // A key the source wrote stays as it is: tracks keep their keys.
    if (project.key.toUpperCase() === text.toUpperCase()) return v;
    return this.slot('track', project.id, 'key', v);
  }

  private savedSearch(v: Value, text: string): Value | Slot {
    const found = this.source.savedSearches(text);
    if (found.length > 1) {
      this.problem(
        NOTE.ambiguousSavedSearch,
        text,
        `Several saved filters are called "${text}" in the source`,
      );
      return v;
    }
    const only = found[0];
    if (only === undefined) {
      this.problem(NOTE.unknownSavedSearch, text, `No saved filter "${text}" in the source`);
      return v;
    }
    return this.slot('saved_search', only, 'id', v);
  }

  private call(v: Extract<Value, { kind: 'function' }>, kind: ValueKind): Value {
    const native = nativeFunctionName(v.name);
    const spec = native === undefined ? undefined : findFunction(native);
    if (!native || !spec) {
      this.problem(
        NOTE.unknownFunction,
        v.name,
        `${v.name}() is not a function Taskmoor has (an app's function, perhaps)`,
      );
      return v;
    }
    const module = MODULE_FUNCTIONS.get(native.toLowerCase());
    if (module) {
      this.note(
        this.flags,
        NOTE.moduleNotAvailable,
        `${native}()`,
        `${native}() belongs to ${module}, which this version does not have yet`,
      );
    }
    const field = kind.of === 'field' ? kind : undefined;
    const args = v.args.map((a, i) => {
      const arg = spec.args[i] ?? spec.args[spec.args.length - 1];
      switch (arg?.kind) {
        case 'user':
          return this.value(a, { of: 'user' });
        case 'ticket':
          return this.value(a, { of: 'ticket' });
        case 'track':
          return this.value(a, { of: 'track' });
        case 'text':
          // Options of the clause's field (cascadeOption, choiceOption) are named by id too.
          if (native === 'cascadeOption' || native === 'choiceOption') {
            return this.value(a, { of: 'option', custom: field?.custom });
          }
          return a;
        default:
          return a;
      }
    });
    return { ...v, name: native, args: args as Value[] };
  }

  predicate(p: Predicate, kind: ValueKind): Predicate {
    const as: ValueKind =
      p.kind === 'by'
        ? { of: 'user' }
        : p.kind === 'from' || p.kind === 'to'
          ? kind
          : { of: 'plain' };
    return { ...p, values: p.values.map((v) => this.value(v, as) as Value) };
  }

  expr(e: Expr): Expr {
    switch (e.kind) {
      case 'and':
      case 'or':
        return { ...e, items: e.items.map((i) => this.expr(i)) };
      case 'not':
        return { ...e, expr: this.expr(e.expr) };
      default: {
        const found = this.field(e.field);
        if (!found) return e;
        const kind = found.kind;
        switch (e.kind) {
          case 'compare': {
            // "Unresolved" is the source's word for no resolution at all (Verify).
            const word = textOf(e.value);
            if (
              kind.of === 'field' &&
              kind.field === 'closeReason' &&
              (e.op === '=' || e.op === '!=') &&
              e.value.kind !== 'string' &&
              word?.toLowerCase() === 'unresolved'
            ) {
              return { kind: 'empty', field: found.ref, negated: e.op === '!=', span: e.span };
            }
            return { ...e, field: found.ref, value: this.value(e.value, kind) as Value };
          }
          case 'in':
            return {
              ...e,
              field: found.ref,
              values: e.values.map((v) => this.value(v, kind) as Value),
            };
          case 'empty':
            return { ...e, field: found.ref };
          case 'was':
            return {
              ...e,
              field: found.ref,
              values: e.values.map((v) => this.value(v, kind) as Value),
              predicates: e.predicates.map((p) => this.predicate(p, kind)),
            };
          case 'changed':
            return {
              ...e,
              field: found.ref,
              predicates: e.predicates.map((p) => this.predicate(p, kind)),
            };
        }
      }
    }
  }

  order(o: OrderBy): OrderBy | null {
    const system =
      o.field.custom === undefined && !o.field.property
        ? (lookupField(SYSTEM_ONLY, o.field) as SystemField | undefined)
        : undefined;
    // ORDER BY a field Taskmoor does not sort by (the rank, an app's): only the order changes.
    const sortable = system ? system.sortable === true : true;
    if (system && !sortable) {
      this.note(
        this.changes,
        NOTE.orderTermDropped,
        system.name,
        `Results cannot be ordered by "${system.name}"; that term was left out`,
      );
      return null;
    }
    if (!system && o.field.custom === undefined && !o.field.property) {
      if (this.source.fieldsNamed(o.field.name).length === 0) {
        this.note(
          this.changes,
          NOTE.orderTermDropped,
          o.field.name,
          `Results cannot be ordered by "${o.field.name}"; that term was left out`,
        );
        return null;
      }
    }
    const found = this.field(o.field);
    return found ? { ...o, field: found.ref } : o;
  }
}

/** Step 1: the query with the source's ids as references, or why it cannot translate. */
export function analyseQuery(text: string, source: SourceCatalogue): Analysis {
  const a = new Analyser(source);
  let query: Query;
  try {
    query = toNative(parseQuery(text));
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    a.problem(NOTE.syntax, 'syntax', error.message);
    return { template: null, problems: a.problems, flags: [], changes: [], refs: [] };
  }
  const where = query.where ? a.expr(query.where) : null;
  const orderBy = query.orderBy.flatMap((o) => a.order(o) ?? []);
  const template = a.problems.length > 0 ? null : { where, orderBy };
  return {
    template,
    problems: a.problems,
    flags: a.flags,
    changes: a.changes,
    refs: template ? dedupe(a.refs) : [],
  };
}

function dedupe(refs: readonly Ref[]): Ref[] {
  const seen = new Map<string, Ref>();
  for (const r of refs) seen.set(`${r.kind}\u0000${r.id}`, r);
  return [...seen.values()];
}

/** What the target became of the source's objects, for step 2. */
export interface TargetLookup {
  /** The target id of an imported custom field; null when it did not import. */
  field(ref: Ref): number | null;
  /** The printed value of an imported object; null when it did not import. */
  value(ref: Ref, as: SlotAs): Value | null;
}

const isSlot = (v: unknown): v is Slot =>
  typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'slot';
const isCustomSlot = (f: FieldRef): f is CustomFieldSlot => 'ref' in f;

/** Step 2: the native text, or the references that did not import. */
export function renderQuery(
  template: Query,
  target: TargetLookup,
): { text: string } | { problems: Note[] } {
  const problems: Note[] = [];
  const missing = (ref: Ref, source: string) => {
    const detail = `${ref.kind} ${ref.id}`;
    if (!problems.some((p) => p.detail === detail)) {
      problems.push({
        code: NOTE.valueNotImported,
        detail,
        message: `"${source}" names a ${ref.kind.replace('_', ' ')} that was not imported`,
      });
    }
  };
  const field = (f: FieldRef): FieldRef => {
    if (!isCustomSlot(f)) return f;
    const id = target.field(f.ref);
    if (id === null) {
      missing(f.ref, `cf[${f.custom}]`);
      return { name: 'cf', custom: f.custom, span: f.span };
    }
    return { name: 'cf', custom: id, span: f.span };
  };
  const value = (v: Value | Slot): Value => {
    if (isSlot(v)) {
      const out = target.value(v.ref, v.as);
      if (out === null) {
        missing(v.ref, v.source);
        return { kind: 'word', value: v.source || '?', span: v.span };
      }
      return { ...out, span: v.span } as Value;
    }
    if (v.kind === 'function') return { ...v, args: v.args.map(value) };
    return v;
  };
  const predicate = (p: Predicate): Predicate => ({ ...p, values: p.values.map(value) });
  const expr = (e: Expr): Expr => {
    switch (e.kind) {
      case 'and':
      case 'or':
        return { ...e, items: e.items.map(expr) };
      case 'not':
        return { ...e, expr: expr(e.expr) };
      case 'compare':
        return { ...e, field: field(e.field), value: value(e.value) };
      case 'in':
        return { ...e, field: field(e.field), values: e.values.map(value) };
      case 'empty':
        return { ...e, field: field(e.field) };
      case 'was':
        return {
          ...e,
          field: field(e.field),
          values: e.values.map(value),
          predicates: e.predicates.map(predicate),
        };
      case 'changed':
        return { ...e, field: field(e.field), predicates: e.predicates.map(predicate) };
    }
  };
  const out: Query = {
    where: template.where ? expr(template.where) : null,
    orderBy: template.orderBy.map((o) => ({ ...o, field: field(o.field) })),
  };
  if (problems.length > 0) return { problems };
  return { text: printQuery(out) };
}

/** The slots of a template, in order, for loading the target's values in one go. */
export function slotsOf(template: Query | null): { refs: Ref[]; slots: Slot[] } {
  const slots: Slot[] = [];
  const refs: Ref[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (isSlot(node)) {
      slots.push(node);
      refs.push(node.ref);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.name === 'cf' && typeof o.custom === 'number' && o.ref) refs.push(o.ref as Ref);
    for (const value of Object.values(o)) walk(value);
  };
  walk(template);
  return { refs: dedupe(refs), slots };
}
