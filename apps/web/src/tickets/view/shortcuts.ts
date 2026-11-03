/** Keys pressed outside a field that act on the ticket (AGL-018 (2)). */
export const TICKET_SHORTCUTS = [
  ['m', 'ticketView.shortcut.comment'],
  ['w', 'ticketView.shortcut.follow'],
  ['a', 'ticketView.shortcut.assign'],
  ['t', 'ticketView.shortcut.transition'],
  ['e', 'ticketView.shortcut.edit'],
  ['?', 'ticketView.shortcut.help'],
] as const;
