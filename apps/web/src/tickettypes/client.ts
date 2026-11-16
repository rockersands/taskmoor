import { api } from '../api/client';

/** The kinds of hierarchy level: three built in, and the ones administrators add above Outcome. */
export type LevelKind = 'subticket' | 'standard' | 'outcome' | 'custom';

/** A hierarchy level (CORE-006): its rank says where it sits, -1 at the bottom. */
export interface Level {
  id: number;
  kind: LevelKind;
  rank: number;
  name: string;
  description: string;
}

/** A shared ticket type and the level it sits at (CORE-005). */
export interface TicketType {
  id: number;
  name: string;
  description: string;
  /** The name of one of our shapes, any other name for a plain hexagon, or none. */
  icon: string | null;
  level: { id: number; rank: number; name: string };
  trackId: number | null;
}

/**
 * What a change to the levels, or to a type's level, would do before anyone makes it
 * (CORE-007 (1); `GET /api/v1/hierarchy-levels/impact`).
 */
export interface HierarchyImpact {
  /** Types whose level is removed: they fall to the standard level. */
  typesToStandard: number[];
  /** Tickets whose level number changes. */
  ticketsChangingLevel: number;
  /** Parent links that hold now and would break. */
  brokenLinkCount: number;
  /** Tickets without a parent that the change would put at the subticket level. */
  ticketsNeedingParent: number[];
  /** Whether the server refuses the change. */
  breaksTickets: boolean;
}

/** A change the impact preview can measure. */
export type HierarchyChange =
  | { change: 'insert'; rank?: number }
  | { change: 'move'; levelId: number; rank: number }
  | { change: 'remove'; levelId: number }
  | { change: 'retype'; typeId: number; levelId: number };

export interface NewTicketType {
  name: string;
  description?: string;
  icon?: string;
  levelId: number;
}

export interface TicketTypeChange {
  name?: string;
  description?: string;
  icon?: string | null;
  levelId?: number;
}

/** The endpoints the ticket types page uses. Stories and tests pass their own. */
export interface TicketTypesClient {
  /** Every level, top first. */
  levels: () => Promise<Level[]>;
  /** The shared ticket types, top level first. */
  ticketTypes: () => Promise<TicketType[]>;
  impact: (change: HierarchyChange) => Promise<HierarchyImpact>;
  /** Without a rank, the level goes on top. */
  createLevel: (body: { name: string; description?: string; rank?: number }) => Promise<Level>;
  updateLevel: (
    id: number,
    change: { name?: string; description?: string; rank?: number },
  ) => Promise<Level>;
  deleteLevel: (id: number) => Promise<void>;
  createType: (body: NewTicketType) => Promise<TicketType>;
  updateType: (id: number, change: TicketTypeChange) => Promise<TicketType>;
  deleteType: (id: number) => Promise<void>;
}

const query = (change: HierarchyChange) =>
  new URLSearchParams(
    Object.entries(change).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();

export const ticketTypesClient: TicketTypesClient = {
  levels: async () => (await api<{ levels: Level[] }>('/hierarchy-levels')).levels,
  ticketTypes: async () =>
    (await api<{ ticketTypes: TicketType[] }>('/ticket-types')).ticketTypes.filter(
      (type) => type.trackId === null,
    ),
  impact: async (change) =>
    (await api<{ impact: HierarchyImpact }>(`/hierarchy-levels/impact?${query(change)}`)).impact,
  createLevel: async (body) =>
    (await api<{ level: Level }>('/hierarchy-levels', { method: 'POST', body })).level,
  updateLevel: async (id, change) =>
    (await api<{ level: Level }>(`/hierarchy-levels/${id}`, { method: 'PATCH', body: change }))
      .level,
  deleteLevel: async (id) => {
    await api<unknown>(`/hierarchy-levels/${id}`, { method: 'DELETE' });
  },
  createType: async (body) =>
    (await api<{ ticketType: TicketType }>('/ticket-types', { method: 'POST', body })).ticketType,
  updateType: async (id, change) =>
    (
      await api<{ ticketType: TicketType }>(`/ticket-types/${id}`, {
        method: 'PATCH',
        body: change,
      })
    ).ticketType,
  deleteType: async (id) => {
    await api<unknown>(`/ticket-types/${id}`, { method: 'DELETE' });
  },
};
