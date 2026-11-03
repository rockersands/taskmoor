/**
 * Which board a person opened a ticket from (ADR-114), so the ticket can lead back to it and the
 * sidebar stays on Boards. Kept for this tab only: a ticket opened any other way has no board
 * behind it.
 */
const KEY = 'taskmoor.ticketFromBoard';

export interface BoardBehind {
  id: number;
  name: string;
}

export function rememberBoard(ticket: string, board: BoardBehind) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ticket, ...board }));
  } catch {
    // Storage can be off (private windows, policies): the ticket simply has no way back.
  }
}

export function boardBehind(ticket: string): BoardBehind | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as
      | (BoardBehind & { ticket: string })
      | null;
    return saved?.ticket === ticket ? { id: saved.id, name: saved.name } : null;
  } catch {
    return null;
  }
}
