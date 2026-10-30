import type { CheckDef, EffectDef, GuardNode, RuleDef } from '@taskmoor/workflow';
import { z } from 'zod';
import { definitionSchema, type Transition, type WorkflowDefinition } from './model';

/**
 * Workflows as files (M1-127; WF-011 (1); ADR-073): Taskmoor's own JSON format for one
 * workflow, which another workspace or instance can read.
 *
 * A document carries the definition in its stored shape (`workflows/model.ts`, the JSON the
 * editor's text mode shows), with every id it names replaced by a document id: 1, 2, 3 per
 * kind, in the order the definition first names them (the workflow's own statuses first, in
 * its order). Tables beside the definition name each one: statuses with their stage and
 * description, groups, roles, people (with their email), priorities, close reasons, ticket
 * types, and releases and areas with the key of their track. Database ids never leave the
 * workspace, so exporting what an import made gives the same document again.
 *
 * `mapDefinition` walks a definition and maps every reference through a `Mapper`, in both
 * directions: the export maps database ids to document ids, the import document ids to the
 * target's ids. A reference the mapper cannot map never stays as it is, and its removal never
 * lets more people through:
 * - a guard that names it never passes (`always-false` in its place, so an `any` around it
 *   still allows through its other members); a list (any of these groups) loses it, and never
 *   passes when nothing is left;
 * - a check or a restricting rule (`restrict-*`) that names it is removed and its transition
 *   gets an `always-false` guard: it is disabled until an administrator fixes it;
 * - an effect, a non-restricting rule or a layout field that names it is removed;
 * - a role or group leaves a status's lock lists (an empty list lets nobody through) and a
 *   rule's `restrict-who` lists.
 * Permission keys are not workspace data: an unknown one is kept (nobody holds it, so the
 * guard never passes and the check always refuses, as before) and reported.
 */
export const WORKFLOW_FORMAT = 'taskmoor-workflow';
export const WORKFLOW_FORMAT_VERSION = 1;

/** The kinds of workspace objects a definition names by id. */
export type RefKind =
  | 'status'
  | 'group'
  | 'role'
  | 'user'
  | 'priority'
  | 'closeReason'
  | 'ticketType'
  | 'release'
  | 'area';

/** Workflow fields whose values name objects (`workflows/fields.ts`), and what they name. */
const FIELD_REFS: Readonly<Record<string, RefKind>> = {
  assignee: 'user',
  requester: 'user',
  creator: 'user',
  priority: 'priority',
  'close-reason': 'closeReason',
  'ticket-type': 'ticketType',
  'target-release': 'release',
  'found-in-release': 'release',
  area: 'area',
};

/** Where in a definition a reference sits: a transition, the create step or a status's locks. */
export type Place = { transitionId: number } | { onCreate: true } | { statusPermissions: number };

/**
 * What became of a part that named something the mapper could not map (the module comment
 * gives the rules).
 */
export type Outcome =
  | 'guard_never_passes'
  | 'narrowed'
  | 'removed'
  | 'transition_disabled'
  | 'kept';

export interface Finding {
  kind: RefKind | 'field' | 'permission';
  /** The id as the side being read names it, the field name, or the permission key. */
  ref: string;
  place: Place;
  /**
   * The guard, check, effect or rule type; `layout` for a layout field; for a status's locks,
   * the action (`edit`, `transition`...), or `status-permission` for the whole entry.
   */
  rule: string;
  outcome: Outcome;
}

export interface Mapper {
  /** The id on the other side, or null when it has none. */
  ref(kind: RefKind, id: number): number | null;
  /** Whether workflows know the field (`isKnownField`). */
  field(name: string): boolean;
  /** Whether the permission key is one tracks have. */
  permission(key: string): boolean;
}

const ALWAYS_FALSE: GuardNode = { type: 'always-false' };
const ID_TEXT = /^[1-9][0-9]{0,9}$/;

/** A reference as stored: an id as a number or as text. */
const asId = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0
    ? v
    : typeof v === 'string' && ID_TEXT.test(v)
      ? Number(v)
      : null;

/**
 * A status the workflow itself uses (its list, initial status, a transition's ends) has no
 * counterpart: an earlier version naming a status deleted since. Imports create statuses, so
 * only an export meets it.
 */
export class MissingStatus extends Error {
  constructor(readonly statusId: number) {
    super(`workflow status ${statusId} has no counterpart`);
  }
}

/** One walk over one definition, collecting what did not map. */
class Walk {
  readonly findings: Finding[] = [];
  /** Transitions a removed check or restriction disables. */
  readonly disabled = new Set<number>();

  constructor(private readonly m: Mapper) {}

  note(finding: Finding) {
    this.findings.push(finding);
  }

  /** A status in a required place: the workflow's own statuses always map. */
  status(id: number): number {
    const mapped = this.m.ref('status', id);
    if (mapped === null) throw new MissingStatus(id);
    return mapped;
  }

  /** An id kept as text (`"12"`), or null. */
  text(kind: RefKind, id: string): string | null {
    const mapped = this.m.ref(kind, Number(id));
    return mapped === null ? null : String(mapped);
  }

  /** A list of ids as text, without the ones that do not map; the missing ones separately. */
  private texts(kind: RefKind, ids: readonly string[]): { kept: string[]; missing: string[] } {
    const kept: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const mapped = this.text(kind, id);
      if (mapped === null) missing.push(id);
      else kept.push(mapped);
    }
    return { kept, missing };
  }

  /**
   * A field's value with the objects it names mapped, keeping each id's JSON type; `missing`
   * lists the ids that did not map. Values that are not ids stay as they are.
   */
  private value(field: string, value: unknown): { value: unknown; missing: string[] } {
    const kind = FIELD_REFS[field];
    if (kind === undefined) return { value, missing: [] };
    const missing: string[] = [];
    const one = (v: unknown): unknown => {
      const id = asId(v);
      if (id === null) return v;
      const mapped = this.m.ref(kind, id);
      if (mapped === null) {
        missing.push(String(id));
        return v;
      }
      return typeof v === 'number' ? mapped : String(mapped);
    };
    return { value: Array.isArray(value) ? value.map(one) : one(value), missing };
  }

  /** The fields a rule names that workflows do not know. */
  private unknownFields(names: readonly (string | undefined)[]): string[] {
    return names.filter((n): n is string => n !== undefined && !this.m.field(n));
  }

  /**
   * Unknown fields and unmapped values of one part as findings; true when there were any.
   */
  private missed(
    place: Place,
    rule: string,
    outcome: Outcome,
    fields: readonly string[],
    refs: readonly { kind: RefKind; ids: readonly string[] }[],
  ): boolean {
    for (const field of fields) this.note({ kind: 'field', ref: field, place, rule, outcome });
    for (const r of refs) {
      for (const id of r.ids) this.note({ kind: r.kind, ref: id, place, rule, outcome });
    }
    return fields.length > 0 || refs.some((r) => r.ids.length > 0);
  }

  guard(node: GuardNode, place: Place): GuardNode {
    if ('all' in node) return { all: node.all.map((n) => this.guard(n, place)) };
    if ('any' in node) return { any: node.any.map((n) => this.guard(n, place)) };
    const never = 'guard_never_passes';
    const fields = this.unknownFields(['field' in node ? node.field : undefined]);
    if (this.missed(place, node.type, never, fields, [])) return ALWAYS_FALSE;
    switch (node.type) {
      case 'previous-status': {
        const status = this.text('status', node.status);
        if (status !== null) return { ...node, status };
        this.missed(place, node.type, never, [], [{ kind: 'status', ids: [node.status] }]);
        return ALWAYS_FALSE;
      }
      case 'user-in-group':
      case 'user-in-role': {
        const kind = node.type === 'user-in-group' ? 'group' : 'role';
        const id = node.type === 'user-in-group' ? node.group : node.role;
        const mapped = this.text(kind, id);
        if (mapped === null) {
          this.missed(place, node.type, never, [], [{ kind, ids: [id] }]);
          return ALWAYS_FALSE;
        }
        return node.type === 'user-in-group'
          ? { ...node, group: mapped }
          : { ...node, role: mapped };
      }
      case 'subticket-blocking':
      case 'user-in-any-group':
      case 'user-in-any-role': {
        const [kind, key] =
          node.type === 'subticket-blocking'
            ? (['status', 'statuses'] as const)
            : node.type === 'user-in-any-group'
              ? (['group', 'groups'] as const)
              : (['role', 'roles'] as const);
        const list = (node as unknown as Record<string, string[]>)[key] as string[];
        const { kept, missing } = this.texts(kind, list);
        const empty = kept.length === 0 && list.length > 0;
        this.missed(place, node.type, empty ? never : 'narrowed', [], [{ kind, ids: missing }]);
        return empty ? ALWAYS_FALSE : ({ ...node, [key]: kept } as GuardNode);
      }
      case 'value-field': {
        const mapped = this.value(node.field, node.value);
        const kind = FIELD_REFS[node.field] as RefKind;
        if (this.missed(place, node.type, never, [], [{ kind, ids: mapped.missing }])) {
          return ALWAYS_FALSE;
        }
        return { ...node, value: mapped.value };
      }
      case 'permission':
        this.permission(node.permission, place, node.type);
        return node;
      default:
        return node;
    }
  }

  private permission(key: string, place: Place, rule: string) {
    if (!this.m.permission(key)) {
      this.note({ kind: 'permission', ref: key, place, rule, outcome: 'kept' });
    }
  }

  /** A check, or null when it is removed (and its transition disabled). */
  check(check: CheckDef, place: Place): CheckDef | null {
    const off = 'transition_disabled';
    const fields = this.unknownFields([
      'field' in check ? check.field : undefined,
      'other' in check ? check.other : undefined,
    ]);
    if (this.missed(place, check.type, off, fields, [])) return null;
    switch (check.type) {
      case 'previous-state': {
        const status = this.text('status', check.status);
        if (status !== null) return { ...check, status };
        this.missed(place, check.type, off, [], [{ kind: 'status', ids: [check.status] }]);
        return null;
      }
      case 'parent-status': {
        const { kept, missing } = this.texts('status', check.statuses);
        const empty = kept.length === 0 && check.statuses.length > 0;
        const ids = [{ kind: 'status' as const, ids: missing }];
        this.missed(place, check.type, empty ? off : 'narrowed', [], ids);
        return empty ? null : { ...check, statuses: kept };
      }
      case 'permission':
        this.permission(check.permission, place, check.type);
        return check;
      default:
        return check;
    }
  }

  /** An effect, or null when it is removed. */
  effect(effect: EffectDef, place: Place): EffectDef | null {
    const named = (() => {
      switch (effect.type) {
        case 'clear-field':
        case 'update-field':
        case 'update-system-field':
          return [effect.field];
        case 'copy-field':
          return [effect.from, effect.to];
        default:
          return [];
      }
    })();
    if (this.missed(place, effect.type, 'removed', this.unknownFields(named), [])) return null;
    switch (effect.type) {
      case 'update-field':
      case 'update-system-field': {
        const mapped = this.value(effect.field, effect.value);
        const kind = FIELD_REFS[effect.field] as RefKind;
        if (this.missed(place, effect.type, 'removed', [], [{ kind, ids: mapped.missing }])) {
          return null;
        }
        return { ...effect, value: mapped.value } as EffectDef;
      }
      case 'set-visibility-level-from-role': {
        const levels: Record<string, string> = {};
        const missing: string[] = [];
        for (const [role, level] of Object.entries(effect.levels)) {
          const mapped = this.text('role', role);
          if (mapped === null) missing.push(role);
          else levels[mapped] = level;
        }
        this.missed(place, effect.type, 'narrowed', [], [{ kind: 'role', ids: missing }]);
        return { ...effect, levels };
      }
      default:
        return effect;
    }
  }

  /** A local-mode rule, or null when it is removed (a restriction also disables). */
  rule(rule: RuleDef, transitionId: number): RuleDef | null {
    const place: Place = { transitionId };
    const restricts = rule.type.startsWith('restrict-') || rule.type === 'validate-permission';
    const gone = restricts ? 'transition_disabled' : 'removed';
    const fields = this.unknownFields(
      rule.type === 'copy-field' ? [rule.from, rule.to] : 'field' in rule ? [rule.field] : [],
    );
    const drop = () => {
      if (restricts) this.disabled.add(transitionId);
      return null;
    };
    if (this.missed(place, rule.type, gone, fields, [])) return drop();
    switch (rule.type) {
      case 'assign': {
        if (typeof rule.to !== 'object') return rule;
        const user = this.text('user', rule.to.user);
        if (user !== null) return { ...rule, to: { user } };
        this.missed(place, rule.type, gone, [], [{ kind: 'user', ids: [rule.to.user] }]);
        return drop();
      }
      case 'restrict-field-value':
      case 'update-field': {
        const mapped = this.value(rule.field, rule.value);
        const kind = FIELD_REFS[rule.field] as RefKind;
        if (this.missed(place, rule.type, gone, [], [{ kind, ids: mapped.missing }])) {
          return drop();
        }
        return { ...rule, value: mapped.value };
      }
      case 'restrict-been-through': {
        const status = this.text('status', rule.status);
        if (status !== null) return { ...rule, status };
        this.missed(place, rule.type, gone, [], [{ kind: 'status', ids: [rule.status] }]);
        return drop();
      }
      case 'restrict-who': {
        // Fewer people allowed: nothing widens, an empty rule lets nobody through.
        const out: RuleDef = { ...rule };
        for (const [key, kind] of [
          ['users', 'user'],
          ['groups', 'group'],
          ['roles', 'role'],
        ] as const) {
          const list = rule[key];
          if (list === undefined) continue;
          const { kept, missing } = this.texts(kind, list);
          this.missed(place, rule.type, 'narrowed', [], [{ kind, ids: missing }]);
          out[key] = kept;
        }
        return out;
      }
      case 'validate-permission':
        this.permission(rule.permission, place, rule.type);
        return rule;
      default:
        return rule;
    }
  }

  transition(t: Transition): Transition {
    const place: Place = { transitionId: t.id };
    const out: Transition = {
      ...t,
      from: t.from === 'any' ? 'any' : t.from.map((s) => this.status(s)),
      to: this.status(t.to),
    };
    if (t.layout) {
      out.layout = t.layout.filter((field) => {
        if (this.m.field(field)) return true;
        this.note({ kind: 'field', ref: field, place, rule: 'layout', outcome: 'removed' });
        return false;
      });
    }
    if (t.guards) out.guards = this.guard(t.guards, place);
    if (t.checks) {
      const kept = t.checks.flatMap((c) => {
        const mapped = this.check(c, place);
        return mapped === null ? [] : [mapped];
      });
      if (kept.length < t.checks.length) this.disabled.add(t.id);
      out.checks = kept;
    }
    if (t.effects) out.effects = this.effects(t.effects, place);
    return out;
  }

  effects(effects: readonly EffectDef[], place: Place): EffectDef[] {
    return effects.flatMap((e) => {
      const mapped = this.effect(e, place);
      return mapped === null ? [] : [mapped];
    });
  }
}

/** A transition that can no longer run: an `always-false` guard first, the rest kept. */
function disable(t: Transition): Transition {
  const guards = t.guards;
  return {
    ...t,
    guards: !guards
      ? ALWAYS_FALSE
      : 'all' in guards
        ? { all: [ALWAYS_FALSE, ...guards.all] }
        : { all: [ALWAYS_FALSE, guards] },
  };
}

/**
 * A definition with every reference mapped (the module comment says what happens to the ones
 * that do not map), and what did not map.
 */
export function mapDefinition(
  definition: WorkflowDefinition,
  mapper: Mapper,
): { definition: WorkflowDefinition; findings: Finding[] } {
  const walk = new Walk(mapper);
  // The workflow's own statuses first, in its order: the export numbers them 1, 2, 3.
  const statuses = definition.statuses.map((s) => ({ ...s, statusId: walk.status(s.statusId) }));
  const out: WorkflowDefinition = {
    ...definition,
    initialStatusId: walk.status(definition.initialStatusId),
    statuses,
    transitions: definition.transitions.map((t) => walk.transition(t)),
  };
  if (definition.onCreate?.effects) {
    out.onCreate = {
      ...definition.onCreate,
      effects: walk.effects(definition.onCreate.effects, { onCreate: true }),
    };
  }
  if (definition.rules) {
    // Keyed by transition id, which is the definition's own.
    out.rules = Object.fromEntries(
      Object.entries(definition.rules).map(([transitionId, rules]) => [
        transitionId,
        rules.flatMap((r) => {
          const mapped = walk.rule(r, Number(transitionId));
          return mapped === null ? [] : [mapped];
        }),
      ]),
    );
  }
  if (definition.statusPermissions) {
    const permissions: NonNullable<WorkflowDefinition['statusPermissions']> = {};
    for (const [status, lists] of Object.entries(definition.statusPermissions)) {
      const place: Place = { statusPermissions: Number(status) };
      const entry: typeof lists = {};
      for (const [action, principals] of Object.entries(lists) as [
        keyof typeof lists,
        NonNullable<(typeof lists)[keyof typeof lists]>,
      ][]) {
        entry[action] = principals.flatMap((p) => {
          const [kind, id] =
            'role' in p ? (['role', p.role] as const) : (['group', p.group] as const);
          const mapped = walk.text(kind, id);
          if (mapped !== null) return [kind === 'role' ? { role: mapped } : { group: mapped }];
          walk.note({ kind, ref: id, place, rule: action, outcome: 'narrowed' });
          return [];
        });
      }
      // Locks of a status the workspace no longer has hold nothing back: they go.
      const key = walk.text('status', status);
      if (key === null) {
        walk.note({
          kind: 'status',
          ref: status,
          place,
          rule: 'status-permission',
          outcome: 'removed',
        });
        continue;
      }
      permissions[key] = entry;
    }
    out.statusPermissions = permissions;
  }
  if (walk.disabled.size > 0) {
    out.transitions = out.transitions.map((t) => (walk.disabled.has(t.id) ? disable(t) : t));
  }
  return { definition: out, findings: walk.findings };
}

// --- The document ---------------------------------------------------------------------------

/** The document's table for each kind. */
export const TABLE_OF: Readonly<Record<RefKind, DocumentTable>> = {
  status: 'statuses',
  group: 'groups',
  role: 'roles',
  user: 'people',
  priority: 'priorities',
  closeReason: 'closeReasons',
  ticketType: 'ticketTypes',
  release: 'releases',
  area: 'areas',
};
type DocumentTable =
  | 'statuses'
  | 'groups'
  | 'roles'
  | 'people'
  | 'priorities'
  | 'closeReasons'
  | 'ticketTypes'
  | 'releases'
  | 'areas';

const docId = z.number().int().positive().max(1_000_000);
const entryName = z.string().trim().min(1).max(255);
const stage = z.enum(['new', 'active', 'closed']);
const uniqueIds = (rows: readonly unknown[]) =>
  new Set(rows.map((r) => (r as { id: number }).id)).size === rows.length;
const table = <T extends z.ZodRawShape>(shape: T) =>
  z
    .array(z.object({ id: docId, name: entryName, ...shape }).strict())
    .max(10_000)
    .refine(uniqueIds, 'each id once');

export const documentSchema = z
  .object({
    format: z.literal(WORKFLOW_FORMAT),
    version: z.literal(WORKFLOW_FORMAT_VERSION),
    workflow: z.object({ name: entryName, description: z.string().max(2000) }).strict(),
    /** Every status the definition names: the workflow's own first, in its order. */
    statuses: table({ stage, description: z.string().max(2000) }).refine(
      (rows) => new Set(rows.map((r) => r.name.toLowerCase())).size === rows.length,
      'each status name once',
    ),
    groups: table({}).optional(),
    roles: table({}).optional(),
    /** People by name and email; an import finds them by email. */
    people: table({ email: z.string().min(1).max(320) }).optional(),
    priorities: table({}).optional(),
    closeReasons: table({}).optional(),
    ticketTypes: table({}).optional(),
    /** Releases and areas belong to a track: `track` is its key. */
    releases: table({ track: z.string().min(1).max(100) }).optional(),
    areas: table({ track: z.string().min(1).max(100) }).optional(),
    definition: definitionSchema,
  })
  .strict();
export type WorkflowDocument = z.infer<typeof documentSchema>;
/** What a table says about one object: its name, and per kind a stage, email or track key. */
export interface EntryInfo {
  name: string;
  stage?: 'new' | 'active' | 'closed';
  description?: string;
  email?: string;
  track?: string;
}
export type DocumentEntry = { id: number } & EntryInfo;

/** Why a body is not a document this version reads, before the full check. */
export function documentRefusal(
  body: unknown,
): 'not_a_workflow_document' | 'unsupported_version' | null {
  const head = z
    .object({ format: z.literal(WORKFLOW_FORMAT), version: z.number().int() })
    .safeParse(body);
  if (!head.success) return 'not_a_workflow_document';
  return head.data.version === WORKFLOW_FORMAT_VERSION ? null : 'unsupported_version';
}

/**
 * The document for a definition. `info` names the object an id stands for, or undefined for
 * an id the workspace no longer has (handled as one that does not map).
 */
export function toDocument(
  workflow: { name: string; description: string },
  definition: WorkflowDefinition,
  info: (kind: RefKind, id: number) => EntryInfo | undefined,
  known: Pick<Mapper, 'field' | 'permission'>,
): WorkflowDocument {
  const ids = new Map<RefKind, Map<number, number>>();
  const tables = new Map<RefKind, DocumentEntry[]>();
  const { definition: mapped } = mapDefinition(definition, {
    ...known,
    ref(kind, id) {
      const seen = ids.get(kind) ?? new Map<number, number>();
      ids.set(kind, seen);
      const existing = seen.get(id);
      if (existing !== undefined) return existing;
      const entry = info(kind, id);
      if (entry === undefined) return null;
      const next = seen.size + 1;
      seen.set(id, next);
      tables.set(kind, [...(tables.get(kind) ?? []), { id: next, ...entry }]);
      return next;
    },
  });
  const optional: Partial<Record<Exclude<DocumentTable, 'statuses'>, DocumentEntry[]>> = {};
  for (const [kind, name] of Object.entries(TABLE_OF) as [RefKind, DocumentTable][]) {
    const rows = tables.get(kind);
    if (name !== 'statuses' && rows && rows.length > 0) optional[name] = rows;
  }
  // The tables' entries hold what each kind has (`entriesFor` in `transfer-store.ts`).
  return {
    format: WORKFLOW_FORMAT,
    version: WORKFLOW_FORMAT_VERSION,
    workflow: { name: workflow.name, description: workflow.description },
    statuses: tables.get('status') ?? [],
    ...optional,
    definition: mapped,
  } as WorkflowDocument;
}

/**
 * A status the definition's own places (its list, initial status, a transition's ends) name
 * by a document id its table lacks, or null. Such a file cannot be read; elsewhere a missing
 * entry is a reference that does not map.
 */
export function unlistedStatus(document: WorkflowDocument): number | null {
  const listed = new Set(document.statuses.map((s) => s.id));
  try {
    mapDefinition(document.definition, {
      ref: (kind, id) => (kind !== 'status' || listed.has(id) ? id : null),
      field: () => true,
      permission: () => true,
    });
    return null;
  } catch (error) {
    if (error instanceof MissingStatus) return error.statusId;
    throw error;
  }
}

/** A document's table for a kind. */
export const entriesOf = (document: WorkflowDocument, kind: RefKind): DocumentEntry[] =>
  (document[TABLE_OF[kind]] ?? []) as DocumentEntry[];

/** One thing an import could not map, named as the document names it. */
export interface ImportProblem {
  kind: Finding['kind'];
  /** The document's name for it (a person's email), the field name or the permission key. */
  name: string;
  rule: string;
  outcome: Outcome;
  /** Where: a transition, the create step, or the locks of a status. */
  transition?: { id: number; name: string };
  onCreate?: true;
  status?: string;
}

/** Findings of a walk over a document's definition, with the document's names. */
export function problemsOf(
  document: WorkflowDocument,
  findings: readonly Finding[],
): ImportProblem[] {
  const nameOf = (kind: RefKind, ref: string) => {
    const entry = entriesOf(document, kind).find((e) => e.id === Number(ref));
    if (!entry) return `#${ref}`;
    return kind === 'user' && entry.email ? entry.email : entry.name;
  };
  const transitions = new Map(document.definition.transitions.map((t) => [t.id, t.name]));
  return findings.map((f) => {
    const name = f.kind === 'field' || f.kind === 'permission' ? f.ref : nameOf(f.kind, f.ref);
    const where =
      'transitionId' in f.place
        ? {
            transition: {
              id: f.place.transitionId,
              name: transitions.get(f.place.transitionId) ?? '',
            },
          }
        : 'onCreate' in f.place
          ? { onCreate: true as const }
          : { status: nameOf('status', String(f.place.statusPermissions)) };
    return { kind: f.kind, name, rule: f.rule, outcome: f.outcome, ...where };
  });
}
