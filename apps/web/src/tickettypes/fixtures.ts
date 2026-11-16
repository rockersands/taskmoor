import { ApiError } from '../api/client';
import type {
  HierarchyChange,
  HierarchyImpact,
  Level,
  TicketType,
  TicketTypesClient,
} from './client';

export interface FakeTicketTypesClient extends TicketTypesClient {
  calls: { action: string; args: unknown[] }[];
}

/** A parent link between tickets of two types, `count` times. */
interface Link {
  child: number;
  parent: number;
  count: number;
}

const FIRST_CUSTOM_RANK = 2;

/** The level an insert makes, before it has an id of its own. */
const NEW_LEVEL: Level = { id: 0, kind: 'custom', rank: 0, name: '', description: '' };

/**
 * An in-memory backend for stories and tests that answers as the API would. The ladder is the
 * three built-in levels with Initiative added above Outcome and Portfolio above that. Three
 * Initiative tickets parent Outcome tickets, so removing Initiative, or moving Portfolio below
 * it, would break those links and is refused. Bug is in a type set; Spike is in none but four
 * tickets have it.
 */
export function fakeTicketTypesClient(): FakeTicketTypesClient {
  let levels: Level[] = [
    { id: 5, kind: 'custom', rank: 3, name: 'Portfolio', description: '' },
    {
      id: 4,
      kind: 'custom',
      rank: 2,
      name: 'Initiative',
      description: 'Several outcomes that move one goal',
    },
    { id: 3, kind: 'outcome', rank: 1, name: 'Outcome', description: '' },
    { id: 2, kind: 'standard', rank: 0, name: 'Standard', description: '' },
    { id: 1, kind: 'subticket', rank: -1, name: 'Subticket', description: '' },
  ];
  let types: {
    id: number;
    name: string;
    description: string;
    icon: string | null;
    levelId: number;
  }[] = [
    { id: 20, name: 'Initiative', description: '', icon: null, levelId: 4 },
    {
      id: 10,
      name: 'Outcome',
      description: 'A result that several tickets deliver together',
      icon: null,
      levelId: 3,
    },
    { id: 11, name: 'Feature', description: '', icon: null, levelId: 2 },
    {
      id: 12,
      name: 'Bug',
      description: 'Something that does not work as it should',
      icon: null,
      levelId: 2,
    },
    { id: 13, name: 'Chore', description: '', icon: null, levelId: 2 },
    { id: 14, name: 'Spike', description: 'A short study', icon: 'idea', levelId: 2 },
    { id: 15, name: 'Subticket', description: '', icon: null, levelId: 1 },
  ];
  const tickets = new Map<number, number>([
    [20, 3],
    [10, 8],
    [11, 20],
    [12, 12],
    [14, 4],
    [15, 30],
  ]);
  const links: Link[] = [
    { child: 10, parent: 20, count: 3 },
    { child: 15, parent: 12, count: 30 },
  ];
  const typeSets = [{ id: 1, name: 'Software types', typeIds: [10, 11, 12, 13, 15] }];
  let next = 100;
  const calls: FakeTicketTypesClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });

  const top = (ladder: Level[]) => Math.max(...ladder.map((l) => l.rank));
  const rankOf = (ladder: Level[], levelId: number) => ladder.find((l) => l.id === levelId)?.rank;
  const view = (type: (typeof types)[number]): TicketType => {
    const level = levels.find((l) => l.id === type.levelId) as Level;
    return {
      id: type.id,
      name: type.name,
      description: type.description,
      icon: type.icon,
      level: { id: level.id, rank: level.rank, name: level.name },
      trackId: null,
    };
  };

  /** The ladder and the type levels after a change, or the server's refusal. */
  function apply(change: HierarchyChange): {
    ladder: Level[];
    typeLevels: Map<number, number>;
    removed: number | null;
  } {
    const typeLevels = new Map(types.map((t) => [t.id, t.levelId]));
    const custom = (levelId: number) => {
      const level = levels.find((l) => l.id === levelId);
      if (!level) throw new ApiError(400, { error: 'invalid_request', detail: 'unknown_level' });
      if (level.kind !== 'custom') throw new ApiError(409, { error: 'builtin_level' });
      return level;
    };
    const outOfRange = () =>
      new ApiError(400, { error: 'rank_out_of_range', detail: { min: FIRST_CUSTOM_RANK } });
    switch (change.change) {
      case 'insert': {
        const rank = change.rank ?? top(levels) + 1;
        if (rank < FIRST_CUSTOM_RANK || rank > top(levels) + 1) throw outOfRange();
        const ladder = levels.map((l) => (l.rank >= rank ? { ...l, rank: l.rank + 1 } : l));
        return { ladder: [...ladder, { ...NEW_LEVEL, rank }], typeLevels, removed: null };
      }
      case 'move': {
        const level = custom(change.levelId);
        if (change.rank < FIRST_CUSTOM_RANK || change.rank > top(levels)) throw outOfRange();
        const closed = levels
          .filter((l) => l.id !== level.id)
          .map((l) => (l.rank > level.rank ? { ...l, rank: l.rank - 1 } : l));
        const opened = closed.map((l) => (l.rank >= change.rank ? { ...l, rank: l.rank + 1 } : l));
        return { ladder: [...opened, { ...level, rank: change.rank }], typeLevels, removed: null };
      }
      case 'remove': {
        const level = custom(change.levelId);
        const ladder = levels
          .filter((l) => l.id !== level.id)
          .map((l) => (l.rank > level.rank ? { ...l, rank: l.rank - 1 } : l));
        const standard = levels.find((l) => l.kind === 'standard') as Level;
        for (const [typeId, levelId] of typeLevels) {
          if (levelId === level.id) typeLevels.set(typeId, standard.id);
        }
        return { ladder, typeLevels, removed: level.id };
      }
      case 'retype': {
        if (!levels.some((l) => l.id === change.levelId)) {
          throw new ApiError(400, { error: 'invalid_request', detail: 'unknown_level' });
        }
        typeLevels.set(change.typeId, change.levelId);
        return { ladder: levels, typeLevels, removed: null };
      }
    }
  }

  function impactOf(change: HierarchyChange): HierarchyImpact & {
    after: ReturnType<typeof apply>;
  } {
    const after = apply(change);
    const before = new Map(types.map((t) => [t.id, rankOf(levels, t.levelId) as number]));
    const now = new Map(
      [...after.typeLevels].map(([typeId, levelId]) => [typeId, rankOf(after.ladder, levelId)]),
    );
    const moved = types.filter((t) => before.get(t.id) !== now.get(t.id));
    const brokenLinkCount = links
      .filter((link) => {
        const held = (before.get(link.parent) ?? 0) === (before.get(link.child) ?? 0) + 1;
        const holds = (now.get(link.parent) ?? 0) === (now.get(link.child) ?? 0) + 1;
        return held && !holds;
      })
      .reduce((n, link) => n + link.count, 0);
    const typesToStandard =
      after.removed === null
        ? []
        : types.filter((t) => t.levelId === after.removed).map((t) => t.id);
    const ticketsNeedingParent: number[] = [];
    if (change.change === 'retype' && now.get(change.typeId) === -1) {
      const withParent = links
        .filter((link) => link.child === change.typeId)
        .reduce((n, link) => n + link.count, 0);
      const orphans = (tickets.get(change.typeId) ?? 0) - withParent;
      for (let i = 0; i < orphans; i++) ticketsNeedingParent.push(1000 + i);
    }
    return {
      typesToStandard,
      ticketsChangingLevel: moved.reduce((n, t) => n + (tickets.get(t.id) ?? 0), 0),
      brokenLinkCount,
      ticketsNeedingParent,
      breaksTickets: brokenLinkCount > 0 || ticketsNeedingParent.length > 0,
      after,
    };
  }

  /** Makes a change happen, or refuses it with its impact as the server does. */
  function commit(change: HierarchyChange) {
    const { after, ...impact } = impactOf(change);
    if (impact.breaksTickets) throw new ApiError(409, { error: 'breaks_tickets', impact });
    levels = after.ladder;
    for (const type of types) type.levelId = after.typeLevels.get(type.id) ?? type.levelId;
  }

  const nameTaken = (list: { id: number; name: string }[], name: string, except?: number) =>
    list.some((item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase());
  const sorted = () => [...levels].sort((a, b) => b.rank - a.rank);

  return {
    calls,
    levels: async () => structuredClone(sorted()),
    ticketTypes: async () =>
      types.map(view).sort((a, b) => b.level.rank - a.level.rank || a.name.localeCompare(b.name)),
    impact: async (change) => {
      const { after: _after, ...impact } = impactOf(change);
      return impact;
    },
    createLevel: async (body) => {
      log('createLevel', body);
      if (nameTaken(levels, body.name)) throw new ApiError(409, { error: 'name_taken' });
      commit({ change: 'insert', ...(body.rank !== undefined ? { rank: body.rank } : {}) });
      const made = levels.find((l) => l.id === NEW_LEVEL.id) as Level;
      Object.assign(made, { id: ++next, name: body.name, description: body.description ?? '' });
      return structuredClone(made);
    },
    updateLevel: async (id, change) => {
      log('updateLevel', id, change);
      const level = levels.find((l) => l.id === id);
      if (!level) throw new ApiError(404, { error: 'not_found' });
      if (change.name !== undefined && nameTaken(levels, change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      if (change.rank !== undefined && change.rank !== level.rank) {
        commit({ change: 'move', levelId: id, rank: change.rank });
      }
      const saved = levels.find((l) => l.id === id) as Level;
      if (change.name !== undefined) saved.name = change.name;
      if (change.description !== undefined) saved.description = change.description;
      return structuredClone(saved);
    },
    deleteLevel: async (id) => {
      log('deleteLevel', id);
      if (!levels.some((l) => l.id === id)) throw new ApiError(404, { error: 'not_found' });
      commit({ change: 'remove', levelId: id });
    },
    createType: async (body) => {
      log('createType', body);
      if (nameTaken(types, body.name)) throw new ApiError(409, { error: 'name_taken' });
      const made = {
        id: ++next,
        name: body.name,
        description: body.description ?? '',
        icon: body.icon ?? null,
        levelId: body.levelId,
      };
      types = [...types, made];
      return view(made);
    },
    updateType: async (id, change) => {
      log('updateType', id, change);
      const type = types.find((t) => t.id === id);
      if (!type) throw new ApiError(404, { error: 'not_found' });
      if (change.name !== undefined && nameTaken(types, change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      if (change.levelId !== undefined && change.levelId !== type.levelId) {
        commit({ change: 'retype', typeId: id, levelId: change.levelId });
      }
      if (change.name !== undefined) type.name = change.name;
      if (change.description !== undefined) type.description = change.description;
      if (change.icon !== undefined) type.icon = change.icon;
      return view(type);
    },
    deleteType: async (id) => {
      log('deleteType', id);
      const sets = typeSets.filter((s) => s.typeIds.includes(id));
      if (sets.length > 0) {
        throw new ApiError(409, {
          error: 'in_type_sets',
          typeSets: sets.map(({ id: setId, name }) => ({ id: setId, name })),
        });
      }
      const count = tickets.get(id) ?? 0;
      if (count > 0) throw new ApiError(409, { error: 'has_tickets', ticketCount: count });
      types = types.filter((t) => t.id !== id);
    },
  };
}
