/**
 * Every grip the app draws (T-162; ADR-114, section 12): a finger drags what it belongs to by it,
 * and a press opens its menu of the same moves. Each is a finger's size on a touch screen, which
 * stories check under a real coarse pointer with `gripsTooSmall` (T-231): the rule was once
 * hidden behind a width query with every test green.
 *
 * A stylesheet's grip is a selector with both `touch-action: none` and a grab cursor; the design
 * guard (design.test.ts) holds every such selector to this list or to `DRAGGED_WHOLE`, so a new
 * grip cannot miss its touch check by being left off (T-290). A grip that is one of these in a
 * place of its own, such as a sprint row's `.sprint-ticket-grip .move-grip-handle`, is checked by
 * that longer selector.
 */
export const GRIP_SELECTORS = [
  // MoveMenu's grip: track groups and their tracks, a sprint's tickets, the calendar's entries.
  '.move-grip-handle',
  // A board card's grip, and the pencil beside it that shares its look.
  '.board-card-grip',
  '.board-card-move',
  '.dashboard-widget-grip',
  '.layout-grip-handle',
  '.checklist-grip',
] as const;

/**
 * What a finger drags by itself rather than by a grip, each with the reason it is not held to a
 * grip's 44 px. The design guard lets these through, and only these.
 */
export const DRAGGED_WHOLE: Readonly<Record<string, string>> = {
  '.timeline-bar':
    "A ticket's bar on the timeline is what moves: its length is its days and its height the lane's. A tap opens the ticket's days in the side panel, the touch screen's way to change them.",
};
