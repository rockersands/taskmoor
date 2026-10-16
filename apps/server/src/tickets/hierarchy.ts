/**
 * The ticket hierarchy as a pure model (M1-007; CORE-005 to CORE-007, spec 01a section 1.2).
 * Nothing here reads the database: the routes load levels, ticket types and (from M1-008)
 * tickets, ask this module whether a change is allowed and what it would break, and write the
 * result.
 *
 * - Levels are integers, called ranks here. Three are built in and keep their rank: the
 *   subticket level (-1), the standard level (0) and the Outcome level (1). Administrators add
 *   any number of custom levels above the Outcome level (2, 3, ...). Ranks always run from -1
 *   to the top without a gap, so inserting, removing or reordering a custom level renumbers the
 *   custom levels above it.
 * - Every ticket type sits at one level, and several types may share one; a ticket's level is
 *   its type's.
 * - A ticket's parent sits exactly one level higher (rule 4; the per-site option of skipping
 *   levels accepts any higher level). A ticket at the subticket level always has a parent
 *   (rule 6). No ticket is its own ancestor.
 * - Removing a level moves its ticket types to the standard level (rule 7); the impact of any
 *   change lists the parent links it would break before anything is written (CORE-007).
 */

export const LEVEL_KINDS = ['subticket', 'standard', 'outcome', 'custom'] as const;
export type LevelKind = (typeof LEVEL_KINDS)[number];
export type BuiltinLevelKind = Exclude<LevelKind, 'custom'>;

export const SUBTICKET_RANK = -1;
export const STANDARD_RANK = 0;
export const OUTCOME_RANK = 1;
export const FIRST_CUSTOM_RANK = 2;

/** The built-in levels with their fixed rank and default name; administrators rename them. */
export const BUILTIN_LEVELS: Record<BuiltinLevelKind, { rank: number; name: string }> = {
  subticket: { rank: SUBTICKET_RANK, name: 'Subticket' },
  standard: { rank: STANDARD_RANK, name: 'Standard' },
  outcome: { rank: OUTCOME_RANK, name: 'Outcome' },
};

export interface Level {
  id: number;
  kind: LevelKind;
  rank: number;
}

/** A ticket type and the level it sits at. */
export interface TypeAtLevel {
  id: number;
  levelId: number;
}

export interface Hierarchy {
  levels: readonly Level[];
  types: readonly TypeAtLevel[];
}

/** The highest rank in use: 1 until a custom level exists. */
export function topRank(levels: readonly Level[]): number {
  return levels.reduce((top, level) => Math.max(top, level.rank), OUTCOME_RANK);
}

export type LadderProblem =
  | 'missing_builtin'
  | 'duplicate_builtin'
  | 'builtin_rank'
  | 'custom_rank'
  | 'duplicate_rank'
  | 'gap';

/**
 * Whether levels form a valid ladder: each built-in level once at its own rank, custom levels
 * above the Outcome level, no two levels at one rank and no gap between -1 and the top.
 */
export function ladderProblem(levels: readonly Level[]): LadderProblem | null {
  for (const kind of ['subticket', 'standard', 'outcome'] as const) {
    const found = levels.filter((l) => l.kind === kind);
    if (found.length === 0) return 'missing_builtin';
    if (found.length > 1) return 'duplicate_builtin';
    if (found[0]?.rank !== BUILTIN_LEVELS[kind].rank) return 'builtin_rank';
  }
  if (levels.some((l) => l.kind === 'custom' && l.rank < FIRST_CUSTOM_RANK)) return 'custom_rank';
  const ranks = new Set(levels.map((l) => l.rank));
  if (ranks.size !== levels.length) return 'duplicate_rank';
  for (let rank = SUBTICKET_RANK; rank <= topRank(levels); rank++) {
    if (!ranks.has(rank)) return 'gap';
  }
  return null;
}

/** A change to the levels, or to the level of one ticket type. */
export type HierarchyChange =
  /** Adds a custom level at `rank` (default: on top); the levels from there up move one up. */
  | { kind: 'insert'; levelId: number; rank?: number }
  /** Moves a custom level to another custom rank; the levels in between close up. */
  | { kind: 'move'; levelId: number; rank: number }
  /** Removes a custom level; the levels above move down and its types fall to level 0. */
  | { kind: 'remove'; levelId: number }
  /** Puts a ticket type at another level. */
  | { kind: 'retype'; typeId: number; levelId: number };

export type ChangeProblem =
  | 'unknown_level'
  | 'unknown_type'
  | 'level_exists'
  | 'builtin_level'
  | 'rank_out_of_range';

export type ChangeResult =
  | { ok: true; hierarchy: Hierarchy }
  | { ok: false; problem: ChangeProblem };

/** The ranks a custom level may take: from 2 up to the top, or one above it for a new level. */
export function customRankRange(
  levels: readonly Level[],
  forNewLevel: boolean,
): { min: number; max: number } {
  return { min: FIRST_CUSTOM_RANK, max: topRank(levels) + (forNewLevel ? 1 : 0) };
}

/** Takes a level out of the ladder: the levels above it move down by one. */
function closeUp(levels: readonly Level[], removed: Level): Level[] {
  return levels
    .filter((l) => l.id !== removed.id)
    .map((l) => (l.rank > removed.rank ? { ...l, rank: l.rank - 1 } : l));
}

/** Makes room at `rank`: that level and the ones above it move up by one. */
function openAt(levels: readonly Level[], rank: number): Level[] {
  return levels.map((l) => (l.rank >= rank ? { ...l, rank: l.rank + 1 } : l));
}

const inRange = (rank: number, range: { min: number; max: number }) =>
  Number.isInteger(rank) && rank >= range.min && rank <= range.max;

/**
 * Applies a change to a hierarchy and returns the new one, or the reason it cannot apply. The
 * built-in levels never move and are never removed; custom ranks stay gapless.
 */
export function applyChange(hierarchy: Hierarchy, change: HierarchyChange): ChangeResult {
  const { levels, types } = hierarchy;
  const level = levels.find((l) => l.id === change.levelId);
  switch (change.kind) {
    case 'insert': {
      if (level) return { ok: false, problem: 'level_exists' };
      const range = customRankRange(levels, true);
      const rank = change.rank ?? range.max;
      if (!inRange(rank, range)) return { ok: false, problem: 'rank_out_of_range' };
      const added: Level = { id: change.levelId, kind: 'custom', rank };
      return { ok: true, hierarchy: { levels: [...openAt(levels, rank), added], types } };
    }
    case 'move': {
      if (!level) return { ok: false, problem: 'unknown_level' };
      if (level.kind !== 'custom') return { ok: false, problem: 'builtin_level' };
      if (!inRange(change.rank, customRankRange(levels, false))) {
        return { ok: false, problem: 'rank_out_of_range' };
      }
      const moved: Level = { ...level, rank: change.rank };
      const rest = openAt(closeUp(levels, level), change.rank);
      return { ok: true, hierarchy: { levels: [...rest, moved], types } };
    }
    case 'remove': {
      if (!level) return { ok: false, problem: 'unknown_level' };
      if (level.kind !== 'custom') return { ok: false, problem: 'builtin_level' };
      const standard = levels.find((l) => l.kind === 'standard');
      if (!standard) return { ok: false, problem: 'unknown_level' };
      return {
        ok: true,
        hierarchy: {
          levels: closeUp(levels, level),
          types: types.map((t) => (t.levelId === level.id ? { ...t, levelId: standard.id } : t)),
        },
      };
    }
    case 'retype': {
      if (!level) return { ok: false, problem: 'unknown_level' };
      if (!types.some((t) => t.id === change.typeId)) return { ok: false, problem: 'unknown_type' };
      return {
        ok: true,
        hierarchy: {
          levels,
          types: types.map((t) => (t.id === change.typeId ? { ...t, levelId: level.id } : t)),
        },
      };
    }
  }
}

/** The rank of each ticket type, by type id. */
export function typeRanks(hierarchy: Hierarchy): Map<number, number> {
  const rankOfLevel = new Map(hierarchy.levels.map((l) => [l.id, l.rank]));
  const out = new Map<number, number>();
  for (const type of hierarchy.types) {
    const rank = rankOfLevel.get(type.levelId);
    if (rank !== undefined) out.set(type.id, rank);
  }
  return out;
}

/** Rule 4 and its per-site option. */
export interface ParentRules {
  /** Accept a parent at any higher level, not only the one directly above. */
  skipLevels: boolean;
}
export const DEFAULT_PARENT_RULES: ParentRules = { skipLevels: false };

/** Whether a ticket at `childRank` may have a parent at `parentRank`. */
export function parentLevelAllowed(
  childRank: number,
  parentRank: number,
  rules: ParentRules = DEFAULT_PARENT_RULES,
): boolean {
  return rules.skipLevels ? parentRank > childRank : parentRank === childRank + 1;
}

/** A ticket as the hierarchy sees it: its type and its parent. */
export interface TicketNode {
  id: number;
  typeId: number;
  parentId: number | null;
}

export type TicketProblem =
  | 'unknown_ticket'
  | 'unknown_type'
  | 'unknown_parent'
  | 'self'
  | 'cycle'
  | 'wrong_level'
  | 'children_wrong_level'
  | 'parent_required';

/** Whether `ancestorId` is `ticketId` or one of its ancestors; stops on cycles already stored. */
function isAncestorOrSelf(
  tickets: ReadonlyMap<number, TicketNode>,
  ancestorId: number,
  ticketId: number,
): boolean {
  const seen = new Set<number>();
  let current: number | null = ticketId;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = tickets.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * Whether ticket `ticketId` may get `parentId` as its parent (null: no parent), and if not,
 * why. `tickets` must hold the ticket, the new parent and the parent's ancestors. Moving a
 * ticket keeps its level, so its children stay valid.
 */
export function checkParent(
  hierarchy: Hierarchy,
  tickets: ReadonlyMap<number, TicketNode>,
  ticketId: number,
  parentId: number | null,
  rules: ParentRules = DEFAULT_PARENT_RULES,
): TicketProblem | null {
  const ticket = tickets.get(ticketId);
  if (!ticket) return 'unknown_ticket';
  const ranks = typeRanks(hierarchy);
  const rank = ranks.get(ticket.typeId);
  if (rank === undefined) return 'unknown_type';
  if (parentId === null) return rank === SUBTICKET_RANK ? 'parent_required' : null;
  if (parentId === ticketId) return 'self';
  const parent = tickets.get(parentId);
  if (!parent) return 'unknown_parent';
  if (isAncestorOrSelf(tickets, ticketId, parentId)) return 'cycle';
  const parentRank = ranks.get(parent.typeId);
  if (parentRank === undefined) return 'unknown_type';
  return parentLevelAllowed(rank, parentRank, rules) ? null : 'wrong_level';
}

/**
 * Whether ticket `ticketId` may change to type `typeId`, and if not, why: at its new level it
 * must still sit right below its parent and right above its children, and a subticket needs a
 * parent. `tickets` must hold the ticket, its parent and its children.
 */
export function checkTypeChange(
  hierarchy: Hierarchy,
  tickets: ReadonlyMap<number, TicketNode>,
  ticketId: number,
  typeId: number,
  rules: ParentRules = DEFAULT_PARENT_RULES,
): TicketProblem | null {
  const ticket = tickets.get(ticketId);
  if (!ticket) return 'unknown_ticket';
  const ranks = typeRanks(hierarchy);
  const rank = ranks.get(typeId);
  if (rank === undefined) return 'unknown_type';
  if (ticket.parentId === null) {
    if (rank === SUBTICKET_RANK) return 'parent_required';
  } else {
    const parent = tickets.get(ticket.parentId);
    if (!parent) return 'unknown_parent';
    const parentRank = ranks.get(parent.typeId);
    if (parentRank === undefined || !parentLevelAllowed(rank, parentRank, rules)) {
      return 'wrong_level';
    }
  }
  for (const child of tickets.values()) {
    if (child.parentId !== ticketId || child.id === ticketId) continue;
    const childRank = ranks.get(child.typeId);
    if (childRank === undefined || !parentLevelAllowed(childRank, rank, rules)) {
      return 'children_wrong_level';
    }
  }
  return null;
}

/**
 * Every rule a set of tickets breaks, ticket by ticket: the full check behind the incremental
 * ones above, for imports and for tests. A ticket in a cycle reports the cycle.
 */
export function forestProblems(
  hierarchy: Hierarchy,
  tickets: ReadonlyMap<number, TicketNode>,
  rules: ParentRules = DEFAULT_PARENT_RULES,
): { ticketId: number; problem: TicketProblem }[] {
  const ranks = typeRanks(hierarchy);
  const out: { ticketId: number; problem: TicketProblem }[] = [];
  for (const ticket of tickets.values()) {
    const rank = ranks.get(ticket.typeId);
    if (rank === undefined) {
      out.push({ ticketId: ticket.id, problem: 'unknown_type' });
      continue;
    }
    if (ticket.parentId === null) {
      if (rank === SUBTICKET_RANK) out.push({ ticketId: ticket.id, problem: 'parent_required' });
      continue;
    }
    const parent = tickets.get(ticket.parentId);
    if (!parent) {
      out.push({ ticketId: ticket.id, problem: 'unknown_parent' });
    } else if (isAncestorOrSelf(tickets, ticket.id, parent.id)) {
      out.push({ ticketId: ticket.id, problem: 'cycle' });
    } else {
      const parentRank = ranks.get(parent.typeId);
      if (parentRank === undefined || !parentLevelAllowed(rank, parentRank, rules)) {
        out.push({ ticketId: ticket.id, problem: 'wrong_level' });
      }
    }
  }
  return out;
}

/** What a hierarchy change does to existing configuration and tickets (CORE-007 (1)). */
export interface HierarchyImpact {
  /** Levels whose rank changes; `to` is null for a removed level. */
  levels: { levelId: number; from: number; to: number | null }[];
  /** Ticket types whose level is removed: they fall to the standard level (rule 7). */
  typesToStandard: number[];
  /** Ticket types whose level number changes, for whatever reason. */
  types: { typeId: number; from: number; to: number }[];
  /** Tickets whose level number changes. */
  ticketsChangingLevel: number;
  /** Parent links that hold before the change and break with it. */
  brokenLinks: { ticketId: number; parentId: number }[];
  /** Tickets without a parent that the change puts at the subticket level. */
  ticketsNeedingParent: number[];
}

/** Whether a change would leave a ticket in breach of the rules. */
export function breaksTickets(impact: HierarchyImpact): boolean {
  return impact.brokenLinks.length > 0 || impact.ticketsNeedingParent.length > 0;
}

/**
 * The impact of going from hierarchy `before` to `after` for `tickets`. Only what the change
 * causes counts: a link that was already invalid is not reported as broken.
 */
export function hierarchyImpact(
  before: Hierarchy,
  after: Hierarchy,
  tickets: ReadonlyMap<number, TicketNode>,
  rules: ParentRules = DEFAULT_PARENT_RULES,
): HierarchyImpact {
  const afterLevels = new Map(after.levels.map((l) => [l.id, l.rank]));
  const levels = before.levels
    .map((l) => ({ levelId: l.id, from: l.rank, to: afterLevels.get(l.id) ?? null }))
    .filter((c) => c.from !== c.to)
    .sort((a, b) => a.from - b.from);
  const typesToStandard = before.types
    .filter((t) => !afterLevels.has(t.levelId))
    .map((t) => t.id)
    .sort((a, b) => a - b);
  const was = typeRanks(before);
  const now = typeRanks(after);
  const types: HierarchyImpact['types'] = [];
  for (const [typeId, from] of was) {
    const to = now.get(typeId);
    if (to !== undefined && to !== from) types.push({ typeId, from, to });
  }
  types.sort((a, b) => a.typeId - b.typeId);

  let ticketsChangingLevel = 0;
  const brokenLinks: HierarchyImpact['brokenLinks'] = [];
  const ticketsNeedingParent: number[] = [];
  for (const ticket of tickets.values()) {
    const from = was.get(ticket.typeId);
    const to = now.get(ticket.typeId);
    if (from !== to) ticketsChangingLevel++;
    if (ticket.parentId === null) {
      if (to === SUBTICKET_RANK && from !== SUBTICKET_RANK) ticketsNeedingParent.push(ticket.id);
      continue;
    }
    const parent = tickets.get(ticket.parentId);
    if (!parent) continue;
    const parentFrom = was.get(parent.typeId);
    const parentTo = now.get(parent.typeId);
    const heldBefore =
      from !== undefined && parentFrom !== undefined && parentLevelAllowed(from, parentFrom, rules);
    const holdsAfter =
      to !== undefined && parentTo !== undefined && parentLevelAllowed(to, parentTo, rules);
    if (heldBefore && !holdsAfter) brokenLinks.push({ ticketId: ticket.id, parentId: parent.id });
  }
  brokenLinks.sort((a, b) => a.ticketId - b.ticketId);
  ticketsNeedingParent.sort((a, b) => a - b);
  return {
    levels,
    typesToStandard,
    types,
    ticketsChangingLevel,
    brokenLinks,
    ticketsNeedingParent,
  };
}
