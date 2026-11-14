import { api } from '../api/client';
import { type TicketClient, type Transition, ticketClient } from '../tickets/view/client';

/** An outcome's summary and dates as the manage panel changes them (T-082). */
export type OutcomeEdit = Partial<{
  summary: string;
  startDate: string | null;
  dueDate: string | null;
}>;

/**
 * What the Outcomes section's manage panel calls (T-082; AGL-024). Each is a ticket route, the
 * same as the ticket page and the backlog use, so the same permissions, workflow and events apply
 * on every track type. Stories and tests pass their own.
 */
export interface OutcomeManager {
  /** A new outcome of an outcome-level type in the track. */
  create(trackKey: string, ticketTypeId: number, summary: string): Promise<{ key: string }>;
  edit(id: number, change: OutcomeEdit): Promise<void>;
  /** Moves it just before or after another outcome in the planned order. */
  rank(id: number, place: { before: number } | { after: number }): Promise<void>;
  /** The ways the workflow offers now from where it is. */
  transitions(id: number): Promise<Transition[]>;
  transition(id: number, transitionId: number, fields?: Record<string, unknown>): Promise<void>;
  /** For a closing transition that asks for a close reason or a priority. */
  closeReasons: TicketClient['closeReasons'];
  priorities: TicketClient['priorities'];
  /** The track's custom fields from the field catalogue, to name a refused one (T-297). */
  fieldNames?: TicketClient['fieldNames'];
}

export const outcomeManager: OutcomeManager = {
  create: async (trackKey, ticketTypeId, summary) =>
    (
      await api<{ ticket: { key: string } }>('/tickets', {
        method: 'POST',
        body: { track: trackKey, ticketTypeId, summary },
      })
    ).ticket,
  edit: async (id, change) => {
    await ticketClient.edit(id, change);
  },
  rank: async (id, place) => {
    await api(`/tickets/${id}/rank`, { method: 'PUT', body: place });
  },
  transitions: ticketClient.transitions,
  transition: async (id, transitionId, fields) => {
    await ticketClient.transition(id, transitionId, fields);
  },
  closeReasons: ticketClient.closeReasons,
  priorities: ticketClient.priorities,
  fieldNames: ticketClient.fieldNames,
};
