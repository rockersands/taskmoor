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
 * What a finger drags by itself rather than by a grip. Each is still a finger's size on a touch
 * screen, but in a way `gripsTooSmall` cannot measure from the element's own box, so each names the
 * story that checks it instead (`checkedBy`: a story file under `src`, then the story's export) and
 * the reason the grip check would get it wrong. The design guard lets these through, and only these,
 * and holds each `checkedBy` to a story that exists and runs on a real touch screen.
 */
export const DRAGGED_WHOLE: Readonly<Record<string, { reason: string; checkedBy: string }>> = {
  '.timeline-bar': {
    reason:
      "A ticket's bar on the timeline is what moves. On a touch screen it keeps its 24 px look, and its press area, drawn by ::after, is a finger's height and reaches past the ends of a bar narrower than a finger (TR-21, T-293), which the grip check, measuring the bar's own box, does not see.",
    checkedBy: 'timeline/TimelinePage.stories.tsx#ThinBarOnATouchScreen',
  },
};
